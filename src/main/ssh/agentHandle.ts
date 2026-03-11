import { ipcMain } from 'electron'
import { Client, ConnectConfig } from 'ssh2'
import { ConnectionInfo } from '../agent/integrations/remote-terminal'
import { createProxySocket } from './proxy'
import { createProxyCommandSocket, getReusableSshConnection, registerReusableSshSession, releaseReusableSshSession } from './sshHandle'
import { LEGACY_ALGORITHMS } from './algorithms'
import net from 'net'
import tls from 'tls'
import { getUserConfigFromRenderer } from '../index'

// Store SSH connections
const remoteConnections = new Map<string, Client>()
// Store shell session streams
const remoteShellStreams = new Map()
const reusedRemoteSessions = new Map<string, { poolKey: string }>()

// Shell type detection
export enum ShellType {
  BASH = 'bash',
  POWERSHELL = 'powershell',
  UNKNOWN = 'unknown'
}

// Cache for detected shell types
const shellTypeCache = new Map<string, ShellType>()

// Helper function for internal shell detection
async function detectShellTypeInternal(conn: Client, command: string): Promise<{ success: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        resolve({ success: false, error: err.message })
        return
      }

      let output = ''
      let finished = false

      const safeResolve = (result: { success: boolean; output?: string; error?: string }) => {
        if (!finished) {
          finished = true
          resolve(result)
        }
      }

      stream.on('data', (data: Buffer) => {
        output += data.toString()
      })

      stream.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })

      stream.on('close', () => {
        safeResolve({ success: true, output })
      })

      // Set short timeout for detection commands
      setTimeout(() => {
        try {
          stream.close()
        } catch {}
        safeResolve({ success: false, output, error: 'Detection command timed out' })
      }, 5000)
    })
  })
}

export async function detectShellType(sessionId: string): Promise<ShellType> {
  // Check cache first
  if (shellTypeCache.has(sessionId)) {
    return shellTypeCache.get(sessionId)!
  }

  const conn = remoteConnections.get(sessionId)
  if (!conn) {
    console.error(`SSH connection does not exist for shell detection: ${sessionId}`)
    return ShellType.BASH // Default to bash for compatibility
  }

  try {
    // First try PowerShell detection
    const psResult = await detectShellTypeInternal(conn, 'echo $PSVersionTable.PSVersion')
    if (psResult.success && psResult.output && psResult.output.includes('Major')) {
      console.log(`[ShellDetection] Detected PowerShell for session ${sessionId}`)
      shellTypeCache.set(sessionId, ShellType.POWERSHELL)
      return ShellType.POWERSHELL
    }

    // Then try shell environment variable detection
    const shellResult = await detectShellTypeInternal(conn, 'echo $SHELL')
    if (shellResult.success && shellResult.output) {
      if (shellResult.output.includes('bash') || shellResult.output.includes('zsh') || shellResult.output.includes('ksh')) {
        console.log(`[ShellDetection] Detected Bash/Zsh/Ksh for session ${sessionId}: ${shellResult.output.trim()}`)
        shellTypeCache.set(sessionId, ShellType.BASH)
        return ShellType.BASH
      }
    }

    // Default to bash for compatibility
    console.log(`[ShellDetection] Defaulting to Bash for session ${sessionId}`)
    shellTypeCache.set(sessionId, ShellType.BASH)
    return ShellType.BASH
  } catch (error) {
    console.error(`[ShellDetection] Error detecting shell type for session ${sessionId}:`, error)
    // Default to bash on error
    return ShellType.BASH
  }
}

// Helper function to determine if an exit code represents a real system error
// We only treat very specific exit codes as actual errors that should interrupt the flow
function isSystemError(_command: string, exitCode: number | null): boolean {
  if (exitCode === null || exitCode === 0) {
    return false // null or 0 is always success
  }
  return false
}

// Helper function to get appropriate pty configuration based on shell type
function getPtyConfig(shellType: ShellType): { pty: boolean } {
  // Disable pty for PowerShell to avoid conhost.exe issues
  // Keep pty enabled for other shell types for full terminal functionality
  return {
    pty: shellType !== ShellType.POWERSHELL
  }
}

// Helper function to build command based on shell type
function buildShellCommand(command: string, shellType: ShellType): string {
  if (shellType === ShellType.POWERSHELL) {
    // PowerShell command execution with Base64 encoding
    const base64Command = Buffer.from(command, 'utf-8').toString('base64')
    return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Command}')) | Invoke-Expression`
  } else {
    // Default to bash for all other shell types
    const base64Command = Buffer.from(command, 'utf-8').toString('base64')
    return `CHATERM_COMMAND_B64='${base64Command}' exec bash -l -c 'eval "$(echo $CHATERM_COMMAND_B64 | base64 -d)"'`
  }
}

// Helper function to build streaming command based on shell type
function buildStreamingShellCommand(command: string, shellType: ShellType): string {
  if (shellType === ShellType.POWERSHELL) {
    // PowerShell command execution for streaming
    return `${command.replace(/"/g, '\"')}`
  } else {
    // Default to bash for all other shell types
    return `exec bash -l -c '${command.replace(/'/g, "'\\''")}'`
  }
}

export async function remoteSshConnect(connectionInfo: ConnectionInfo): Promise<{ id?: string; error?: string }> {
  const { host, port, username, password, privateKey, passphrase } = connectionInfo
  const connectionId = `ssh_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`
  const normalizedHost = host ?? ''
  const normalizedUsername = username ?? ''
  const normalizedPort = port || 22

  if (normalizedHost && normalizedUsername) {
    const reusable = getReusableSshConnection(normalizedHost, normalizedPort, normalizedUsername)
    if (reusable) {
      remoteConnections.set(connectionId, reusable.conn)
      reusedRemoteSessions.set(connectionId, { poolKey: reusable.poolKey })
      registerReusableSshSession(reusable.poolKey, connectionId)
      console.log(`SSH connection re-used via MFA pool: ${normalizedUsername}@${normalizedHost} (session: ${connectionId})`)
      return Promise.resolve({ id: connectionId })
    }
  }

  let sock: net.Socket | tls.TLSSocket

  if (connectionInfo.proxyCommand) {
    sock = await createProxyCommandSocket(connectionInfo.proxyCommand, connectionInfo.host || '', port || 22)
  } else if (connectionInfo.needProxy) {
    const cfg = await getUserConfigFromRenderer()
    if (connectionInfo.proxyName) {
      const proxyConfig = cfg.sshProxyConfigs.find((item) => item.name === connectionInfo.proxyName)
      sock = await createProxySocket(proxyConfig, connectionInfo.host || '', connectionInfo.port || 22)
    }
  }

  return new Promise((resolve) => {
    const conn = new Client()
    let secondAuthTriggered = false
    let resolved = false

    const safeResolve = (result: { id?: string; error?: string }) => {
      if (!resolved) {
        resolved = true
        resolve(result)
      }
    }

    conn.on('keyboard-interactive', () => {
      secondAuthTriggered = true
      conn.end()
      safeResolve({ error: 'Server requires second authentication (e.g., OTP/2FA), cannot connect.' })
    })

    conn.on('ready', () => {
      if (secondAuthTriggered) return
      remoteConnections.set(connectionId, conn)
      console.log(`SSH connection successful: ${connectionId}`)
      safeResolve({ id: connectionId })
    })

    conn.on('error', (err) => {
      if (secondAuthTriggered) return
      console.error('SSH connection error:', err.message)
      conn.end()
      safeResolve({ error: err.message })
    })

    conn.on('close', () => {
      if (secondAuthTriggered) return
      // If the connection closes before the 'ready' event, and no 'error' event is triggered,
      // this usually means all authentication methods failed.
      safeResolve({ error: 'SSH connection closed, possibly authentication failed.' })
    })

    const connectConfig: ConnectConfig = {
      host,
      port: normalizedPort,
      username,
      keepaliveInterval: 10000, // Keep connection alive
      tryKeyboard: true, // Disable keyboard-interactive
      algorithms: LEGACY_ALGORITHMS
    }

    connectConfig.ident = connectionInfo.ident

    if (connectionInfo.needProxy || connectionInfo.proxyCommand) {
      connectConfig.sock = sock
    }

    try {
      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (passphrase) {
          connectConfig.passphrase = passphrase
        }
      } else if (password) {
        connectConfig.password = password
      } else {
        safeResolve({ error: 'Missing password or private key' })
        return
      }
      conn.connect(connectConfig)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('SSH connection configuration error:', errorMessage)
      safeResolve({ error: `Connection configuration error: ${errorMessage}` })
    }
  })
}

export async function remoteSshExec(
  sessionId: string,
  command: string,
  timeoutMs: number = 30 * 60 * 1000
): Promise<{ success?: boolean; output?: string; error?: string }> {
  const conn = remoteConnections.get(sessionId)

  if (!conn) {
    console.error(`SSH connection does not exist: ${sessionId}`)
    return { success: false, error: 'Not connected to remote server' }
  }
  console.log(`Starting SSH command: ${command} (Session: ${sessionId})`)

  // Detect shell type automatically
  const shellType = await detectShellType(sessionId)
  const shellCommand = buildShellCommand(command, shellType)
  console.log(shellCommand)

  return new Promise((resolve) => {
    let timeoutHandler: NodeJS.Timeout
    let finished = false

    function safeResolve(result: { success?: boolean; output?: string; error?: string }) {
      if (!finished) {
        finished = true
        clearTimeout(timeoutHandler)
        resolve(result)
      }
    }

    const ptyConfig = getPtyConfig(shellType)
    conn.exec(shellCommand, ptyConfig, (err, stream) => {
      if (err) {
        safeResolve({ success: false, error: err.message })
        return
      }

      let output = ''

      stream.on('data', (data: Buffer) => {
        output += data.toString()
      })

      stream.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })

      stream.on('close', (code: number | null) => {
        const isError = isSystemError(command, code)
        let finalOutput = output

        // Add exit code information to output for AI model to interpret
        if (code !== null && code !== 0) {
          finalOutput += `\n[Exit Code: ${code}]`
        }

        // Add command not found message for exit code 127
        if (code === 127) {
          finalOutput += "\nCommand not found. Please check if the command exists in the remote server's PATH."
        }

        safeResolve({
          success: !isError,
          output: finalOutput,
          error: isError ? `Command failed with exit code: ${code}` : undefined
        })
      })

      // Set timeout
      timeoutHandler = setTimeout(() => {
        // stream termination
        try {
          stream.close()
        } catch {}
        safeResolve({
          success: false,
          output: output,
          error: `Command execution timed out (${timeoutMs}ms)`
        })
      }, timeoutMs)
    })
  })
}

// New: SSH command execution method supporting real-time streaming output
export async function remoteSshExecStream(
  sessionId: string,
  command: string,
  onData: (chunk: string) => void,
  timeoutMs: number = 30 * 60 * 1000
): Promise<{ success?: boolean; error?: string; stream?: any }> {
  const conn = remoteConnections.get(sessionId)
  if (!conn) {
    console.error(`SSH connection does not exist: ${sessionId}`)
    return { success: false, error: 'Not connected to remote server' }
  }

  console.log(`Starting SSH command (stream): ${command} (Session: ${sessionId})`)

  // Detect shell type automatically
  const shellType = await detectShellType(sessionId)
  const shellCommand = buildStreamingShellCommand(command, shellType)
  console.log(shellCommand)

  return new Promise((resolve) => {
    let timeoutHandler: NodeJS.Timeout
    let finished = false

    function safeResolve(result: { success?: boolean; error?: string; stream?: any }) {
      if (!finished) {
        finished = true
        clearTimeout(timeoutHandler)
        resolve(result)
      }
    }

    const ptyConfig = getPtyConfig(shellType)
    conn.exec(shellCommand, ptyConfig, (err, stream) => {
      if (err) {
        safeResolve({ success: false, error: err.message })
        return
      }

      // Store the stream for later input operations
      remoteShellStreams.set(sessionId, stream)

      stream.on('data', (data: Buffer) => {
        try {
          onData(data.toString())
        } catch (cbErr) {
          console.error('remoteSshExecStream onData callback error:', cbErr)
        }
      })

      stream.stderr.on('data', (data: Buffer) => {
        try {
          onData(data.toString())
        } catch (cbErr) {
          console.error('remoteSshExecStream stderr onData callback error:', cbErr)
        }
      })

      stream.on('close', (code: number | null) => {
        // Clean up the stored stream when it closes
        remoteShellStreams.delete(sessionId)

        // Add exit code information for AI model to interpret
        if (code !== null && code !== 0) {
          try {
            onData(`\n[Exit Code: ${code}]`)
          } catch (cbErr) {
            console.error('remoteSshExecStream onData callback error:', cbErr)
          }
        }

        if (code === 127) {
          try {
            onData("\nCommand not found. Please check if the command exists in the remote server's PATH.")
          } catch (cbErr) {
            console.error('remoteSshExecStream onData callback error:', cbErr)
          }
        }

        const isError = isSystemError(command, code)
        safeResolve({
          success: !isError,
          error: isError ? `Command failed with exit code: ${code}` : undefined
        })
      })

      // Set timeout
      timeoutHandler = setTimeout(() => {
        try {
          stream.close()
        } catch {}
        // Clean up the stored stream on timeout
        remoteShellStreams.delete(sessionId)
        safeResolve({
          success: false,
          error: `Command execution timed out (${timeoutMs}ms)`
        })
      }, timeoutMs)
    })
  })
}

export async function remoteSshDisconnect(sessionId: string): Promise<{ success?: boolean; error?: string }> {
  const stream = remoteShellStreams.get(sessionId)
  if (stream) {
    stream.end()
    remoteShellStreams.delete(sessionId)
  }

  // Clean up shell type cache
  shellTypeCache.delete(sessionId)

  const reuseInfo = reusedRemoteSessions.get(sessionId)
  if (reuseInfo) {
    remoteConnections.delete(sessionId)
    reusedRemoteSessions.delete(sessionId)
    releaseReusableSshSession(reuseInfo.poolKey, sessionId)
    console.log(`SSH reused connection session released: ${sessionId}`)
    return { success: true }
  }

  const conn = remoteConnections.get(sessionId)
  if (conn) {
    conn.end()
    remoteConnections.delete(sessionId)
    console.log(`SSH connection disconnected: ${sessionId}`)
    return { success: true }
  }

  console.warn(`Attempting to disconnect non-existent SSH connection: ${sessionId}`)
  return { success: false, error: 'No active remote connection' }
}

// Export function for direct use in main process
export function handleRemoteExecInput(streamId: string, input: string): { success: boolean; error?: string } {
  const stream = remoteShellStreams.get(streamId)
  if (stream) {
    stream.write(input)
    return { success: true }
  }
  return { success: false, error: 'Stream not found' }
}

export const registerRemoteTerminalHandlers = () => {
  ipcMain.handle('ssh:remote-connect', async (_event, connectionInfo) => {
    try {
      return await remoteSshConnect(connectionInfo)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ssh:remote-exec', async (_event, sessionId, command) => {
    try {
      return await remoteSshExec(sessionId, command)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Streaming execution is not exposed via IPC, keep it internal

  ipcMain.handle('ssh:remote-disconnect', async (_event, sessionId) => {
    try {
      return await remoteSshDisconnect(sessionId)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

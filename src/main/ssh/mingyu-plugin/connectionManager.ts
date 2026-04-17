import { ipcMain } from 'electron'
import { Client } from 'ssh2'
import net from 'net'
import tls from 'tls'
import type { Readable } from 'stream'
import { createProxySocket } from '../proxy'
import { attemptSecondaryConnection, keyboardInteractiveOpts } from '../sshHandle'
import { LEGACY_ALGORITHMS } from '../algorithms'
import {
  mingyuConnections,
  mingyuShellStreams,
  mingyuMarkedCommands,
  mingyuInputBuffer,
  mingyuConnectionStatus,
  mingyuUuidToConnectionId
} from './state'
import type { MingyuConnectionInfo } from './types'
import { MAX_MINGYU_MFA_ATTEMPTS } from './constants'
import { setupMingyuInteraction } from './interaction'
import { handleMingyuKeyboardInteractive } from './mfa'
import { buildErrorResponse } from './errorUtils'
import { ensureDebugTranscriptSession, recordDebugTranscriptEvent, type DebugTranscriptRedaction } from '../debugTranscript'
import { registerBastionSessionType } from '../bastionPlugin'
import path from 'path'
import fs from 'fs'

export type PackageInfo = { name: string; version: string } & Record<string, unknown>

function safeAppPath(): string {
  try {
    const { app } = require('electron') as { app?: { getAppPath?: () => string } }
    if (app?.getAppPath) return app.getAppPath()
  } catch {}
  return process.cwd()
}

export function getPackageInfo(
  fallbackRelative: string = '../../package.json',
  defaultInfo: PackageInfo = { name: 'xxx', version: 'unknown' }
): PackageInfo {
  try {
    const appPath = safeAppPath()
    const packagePath = path.join(appPath, 'package.json')
    const sourcePath = fs.existsSync(packagePath) ? packagePath : path.join(__dirname, fallbackRelative)

    return JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as PackageInfo
  } catch (e) {
    console.error('Failed to read package.json:', e)
    return { ...defaultInfo }
  }
}

const getMfaPromptText = (prompts: Array<{ prompt: string }>) => prompts.map((item) => item.prompt).join('\n')

const getMfaResponseCount = (responses: unknown): number => {
  return Array.isArray(responses) ? responses.length : 0
}

const recordMingyuConnectionEvent = (options: {
  rootSessionId: string
  event: string
  actor?: 'user' | 'system' | 'remote'
  phase?: 'connecting' | 'connected' | 'closed'
  direction?: 'in' | 'out' | 'meta'
  text?: string
  bytes?: number
  redacted?: DebugTranscriptRedaction
  noise?: boolean
  meta?: Record<string, unknown>
  source?: 'connection' | 'secondary' | 'mfa'
  sessionId?: string
}) => {
  recordDebugTranscriptEvent({
    rootSessionId: options.rootSessionId,
    sessionId: options.sessionId,
    transport: 'mingyu',
    source: options.source ?? 'connection',
    actor: options.actor ?? 'system',
    event: options.event,
    phase: options.phase,
    direction: options.direction,
    text: options.text,
    bytes: options.bytes,
    redacted: options.redacted,
    noise: options.noise,
    meta: options.meta
  })
}

const recordMingyuSecondaryNoise = (connectionInfo: MingyuConnectionInfo, event: string, meta?: Record<string, unknown>) => {
  recordMingyuConnectionEvent({
    rootSessionId: connectionInfo.id,
    source: 'secondary',
    event,
    phase: 'connected',
    noise: true,
    meta
  })
}

const attemptMingyuConnection = async (
  connectionInfo: MingyuConnectionInfo,
  event?: Electron.IpcMainInvokeEvent,
  attemptCount: number = 0
): Promise<{ status: string; message: string }> => {
  const transcriptPath = ensureDebugTranscriptSession({
    rootSessionId: connectionInfo.id,
    transport: 'mingyu',
    source: 'connection',
    meta: {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      targetIp: connectionInfo.targetIp,
      targetHostname: connectionInfo.targetHostname || '',
      targetAsset: connectionInfo.targetAsset || '',
      authMethod: connectionInfo.privateKey ? 'privateKey' : connectionInfo.password ? 'password' : 'unknown',
      needProxy: !!connectionInfo.needProxy
    }
  })

  recordMingyuConnectionEvent({
    rootSessionId: connectionInfo.id,
    event: 'transcript_ready',
    phase: 'connecting',
    meta: { filePath: transcriptPath }
  })

  recordMingyuConnectionEvent({
    rootSessionId: connectionInfo.id,
    event: 'connect_start',
    phase: 'connecting',
    meta: {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      attempt: attemptCount + 1,
      needProxy: !!connectionInfo.needProxy
    }
  })

  if (attemptCount > 0) {
    recordMingyuConnectionEvent({
      rootSessionId: connectionInfo.id,
      event: 'connect_retry',
      phase: 'connecting',
      meta: { attempt: attemptCount + 1 }
    })
  }

  const recordSecondaryAttempt = attemptSecondaryConnection

  const attemptMingyuSecondaryConnection = async (ident: string) => {
    recordMingyuSecondaryNoise(connectionInfo, 'secondary_connect_start', {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      ident
    })

    try {
      await recordSecondaryAttempt(event, connectionInfo, ident)
      recordMingyuSecondaryNoise(connectionInfo, 'secondary_connect_complete')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      recordMingyuConnectionEvent({
        rootSessionId: connectionInfo.id,
        source: 'secondary',
        event: 'secondary_connect_error',
        phase: 'closed',
        noise: true,
        meta: { message }
      })
      throw error
    }
  }
  const connectionId = connectionInfo.id

  const sendStatusUpdate = (
    message: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
    messageKey?: string,
    messageParams?: Record<string, string | number>
  ) => {
    if (event) {
      event.sender.send('mingyu:status-update', {
        id: connectionId,
        message,
        messageKey,
        messageParams,
        type,
        timestamp: new Date().toLocaleTimeString()
      })
    }
  }

  let sock: net.Socket | tls.TLSSocket | undefined
  if (connectionInfo.needProxy && connectionInfo.proxyConfig) {
    sock = await createProxySocket(connectionInfo.proxyConfig, connectionInfo.host, connectionInfo.port || 22)
  }
  const identToken = connectionInfo.connIdentToken ? `_t=${connectionInfo.connIdentToken}` : ''
  const packageInfo = getPackageInfo()
  const ident = `${packageInfo.name}_${packageInfo.version}` + identToken

  return new Promise((resolve, reject) => {
    const mingyuUuid = connectionInfo.assetUuid || connectionId

    if (connectionInfo.assetUuid) {
      // Check if we can reuse an existing connection
      // For mingyu profile, only reuse if targetIp is also the same
      for (const [existingId, existingData] of mingyuConnections.entries()) {
        if (existingData.mingyuUuid === mingyuUuid) {
          // Found existing connection with same mingyuUuid
          const existingStream = mingyuShellStreams.get(existingId)
          //const isMingyuProfile = existingData.navigationPath?.profile === 'mingyu'
          const sameTargetIp = existingData.targetIp === connectionInfo.targetIp

          if (existingStream && sameTargetIp) {
            // For mingyu profile: only reuse if targetIp is also the same
            // This is critical for AI Chat to reuse the user's existing SSH connection to the same target
            console.log(`[Mingyu-plugin] Reusing existing mingyu shell stream: existingId=${existingId}, targetIp=${connectionInfo.targetIp}`)

            mingyuConnections.set(connectionId, {
              conn: existingData.conn,
              stream: existingStream,
              mingyuUuid,
              targetIp: connectionInfo.targetIp,
              navigationPath: existingData.navigationPath
            })
            mingyuShellStreams.set(connectionId, existingStream)
            mingyuConnectionStatus.set(connectionId, { isVerified: true, source: 'mingyu', profile: 'mingyu' })
            mingyuUuidToConnectionId.set(mingyuUuid, connectionId)

            // Register bastionType for the new connectionId so writeBastionSession can find it
            registerBastionSessionType(connectionId, 'mingyu')
            console.log(`[Mingyu-plugin] Registered bastionType 'mingyu' for reused connectionId=${connectionId}`)

            sendStatusUpdate('Mingyu connection reused successfully', 'success', 'ssh.mingyu.reused')
            resolve({ status: 'connected', message: 'Mingyu connection reused successfully' })
            return
          }

          // if (existingData.navigationPath?.profile !== 'mingyu') {
          //   // For non-mingyu profiles: create new shell session (original behavior)
          //   sendStatusUpdate('Reusing existing connection, creating new shell session...', 'info', 'ssh.mingyu.reuseConnection')
          //   recordMingyuConnectionEvent({
          //     rootSessionId: connectionId,
          //     event: 'connection_reused',
          //     phase: 'connected',
          //     meta: {
          //       mingyuUuid,
          //       targetIp: connectionInfo.targetIp,
          //       reusedSessionId: existingData.mingyuUuid
          //     }
          //   })

          //   const conn = existingData.conn
          //   conn.shell({ term: connectionInfo.terminalType || 'vt100' }, (err, newStream) => {
          //     if (err) {
          //       console.error('Failed to create shell with reused connection:', err)
          //       reject(new Error(`Failed to create shell with reused connection: ${err.message}`))
          //       return
          //     }
          //     // Establish SFTP connection
          //     try {
          //       recordMingyuSecondaryNoise(connectionInfo, 'secondary_sftp_check_start')
          //       sftpAsync(conn, connectionId)
          //     } catch (e) {
          //       connectionStatus.set(connectionId, {
          //         sftpAvailable: false,
          //         sftpError: 'SFTP connection failed'
          //       })
          //       recordMingyuConnectionEvent({
          //         rootSessionId: connectionId,
          //         source: 'secondary',
          //         event: 'secondary_sftp_check_error',
          //         phase: 'closed',
          //         noise: true,
          //         meta: { message: 'SFTP connection failed' }
          //       })
          //     }
          //     setupMingyuInteraction(newStream, connectionInfo, connectionId, mingyuUuid, conn, event, sendStatusUpdate, resolve, reject)
          //   })

          //   return
          // }
        }
      }
    }

    sendStatusUpdate('Connecting to remote bastion host...', 'info', 'ssh.mingyu.connectingToBastionHost')

    const conn = new Client()

    const connectConfig: {
      host: string
      port: number
      username: string
      keepaliveInterval: number
      readyTimeout: number
      tryKeyboard: boolean
      privateKey?: Buffer
      passphrase?: string
      password?: string
      ident: string
      sock?: Readable
      algorithms?: typeof LEGACY_ALGORITHMS
    } = {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      keepaliveInterval: 10000,
      readyTimeout: 180000,
      tryKeyboard: true,
      ident: ident,
      algorithms: LEGACY_ALGORITHMS
    }

    if (sock) {
      connectConfig.sock = sock
    }

    if (connectionInfo.privateKey) {
      try {
        connectConfig.privateKey = Buffer.from(connectionInfo.privateKey)
        if (connectionInfo.passphrase) {
          connectConfig.passphrase = connectionInfo.passphrase
        }
      } catch (err: unknown) {
        reject(new Error(`Private key format error: ${err instanceof Error ? err.message : String(err)}`))
        return
      }
    } else if (connectionInfo.password) {
      connectConfig.password = connectionInfo.password
    } else {
      reject(new Error('Missing authentication info: private key or password required'))
      return
    }

    conn.on('keyboard-interactive', async (_name, _instructions, _instructionsLang, prompts, finish) => {
      try {
        if (attemptCount === 0) {
          sendStatusUpdate('Two-factor authentication required, please enter verification code...', 'info', 'ssh.mingyu.mfaRequired')
        } else {
          sendStatusUpdate(
            `Verification failed, please re-enter verification code (${attemptCount + 1}/${MAX_MINGYU_MFA_ATTEMPTS})...`,
            'warning',
            'ssh.mingyu.mfaRetry',
            {
              attempt: attemptCount + 1,
              max: MAX_MINGYU_MFA_ATTEMPTS
            }
          )
        }

        await handleMingyuKeyboardInteractive(event, connectionId, prompts, finish, {
          onPrompt: (promptList) => {
            const text = getMfaPromptText(promptList)
            recordMingyuConnectionEvent({
              rootSessionId: connectionId,
              source: 'mfa',
              actor: 'remote',
              event: 'mfa_prompt',
              phase: 'connecting',
              direction: 'in',
              text,
              meta: {
                promptCount: promptList.length,
                attempt: attemptCount + 1
              }
            })
          },
          onResponse: (responses) => {
            recordMingyuConnectionEvent({
              rootSessionId: connectionId,
              source: 'mfa',
              actor: 'user',
              event: 'mfa_response',
              phase: 'connecting',
              direction: 'out',
              text: '<redacted:mfa>',
              redacted: 'mfa',
              meta: {
                responseCount: getMfaResponseCount(responses),
                attempt: attemptCount + 1
              }
            })
          },
          onTimeout: () => {
            recordMingyuConnectionEvent({
              rootSessionId: connectionId,
              source: 'mfa',
              actor: 'system',
              event: 'mfa_timeout',
              phase: 'closed',
              meta: {
                attempt: attemptCount + 1
              }
            })
          },
          onCancel: () => {
            recordMingyuConnectionEvent({
              rootSessionId: connectionId,
              source: 'mfa',
              actor: 'user',
              event: 'mfa_cancel',
              phase: 'closed',
              direction: 'out',
              meta: {
                attempt: attemptCount + 1
              }
            })
          }
        })
      } catch (err) {
        sendStatusUpdate('Two-factor authentication failed', 'error', 'ssh.mingyu.mfaFailed')
        recordMingyuConnectionEvent({
          rootSessionId: connectionId,
          source: 'mfa',
          event: 'mfa_result',
          phase: 'closed',
          meta: {
            status: 'failed',
            attempt: attemptCount + 1,
            message: err instanceof Error ? err.message : String(err)
          }
        })
        conn.end()
        reject(err as Error)
      }
    })

    conn.on('ready', () => {
      console.log('Mingyu connection established, starting to create shell')
      sendStatusUpdate('Successfully connected to bastion host, please wait...', 'success', 'ssh.mingyu.connectedToBastionHost')
      recordMingyuConnectionEvent({
        rootSessionId: connectionId,
        event: 'connect_ready',
        phase: 'connected',
        meta: {
          mingyuUuid,
          attempt: attemptCount + 1
        }
      })
      void attemptMingyuSecondaryConnection(ident)

      if (event && keyboardInteractiveOpts.has(connectionId)) {
        console.log('Sending MFA verification success event:', { connectionId, status: 'success' })
        recordMingyuConnectionEvent({
          rootSessionId: connectionId,
          source: 'mfa',
          event: 'mfa_result',
          phase: 'connected',
          meta: {
            status: 'success',
            attempt: attemptCount + 1
          }
        })
        event.sender.send('ssh:keyboard-interactive-result', {
          id: connectionId,
          status: 'success'
        })
      }

      conn.shell({ term: connectionInfo.terminalType || 'vt100' }, (err, stream) => {
        if (err) {
          recordMingyuConnectionEvent({
            rootSessionId: connectionId,
            event: 'shell_create_error',
            phase: 'closed',
            meta: { message: err.message }
          })
          reject(new Error(`Failed to create shell: ${err.message}`))
          return
        }

        setupMingyuInteraction(stream, connectionInfo, connectionId, mingyuUuid, conn, event, sendStatusUpdate, resolve, reject)
      })
    })

    conn.on('error', (err) => {
      console.error('Mingyu connection error:', err)
      recordMingyuConnectionEvent({
        rootSessionId: connectionId,
        event: 'connect_error',
        phase: 'closed',
        meta: {
          message: err.message,
          level: (err as any).level || ''
        }
      })

      if ((err as any).level === 'client-authentication') {
        console.log(`Mingyu MFA authentication failed, attempt count: ${attemptCount + 1}/${MAX_MINGYU_MFA_ATTEMPTS}`)
        recordMingyuConnectionEvent({
          rootSessionId: connectionId,
          source: 'mfa',
          event: 'mfa_result',
          phase: 'connecting',
          meta: {
            status: 'failed',
            attempt: attemptCount + 1,
            final: attemptCount >= MAX_MINGYU_MFA_ATTEMPTS - 1,
            message: err.message
          }
        })

        if (event) {
          event.sender.send('ssh:keyboard-interactive-result', {
            id: connectionId,
            attempts: attemptCount + 1,
            status: 'failed'
          })
        }

        if (attemptCount < MAX_MINGYU_MFA_ATTEMPTS - 1) {
          const retryError = new Error(`Mingyu MFA authentication failed`)
          ;(retryError as any).shouldRetry = true
          ;(retryError as any).attemptCount = attemptCount
          reject(retryError)
          return
        }
      }

      if (event) {
        event.sender.send('ssh:keyboard-interactive-result', {
          id: connectionId,
          status: 'failed',
          final: true
        })
      }

      reject(new Error(`Mingyu connection failed: ${err.message}`))
    })

    conn.connect(connectConfig)
  })
}

export const handleMingyuConnection = async (
  connectionInfo: MingyuConnectionInfo,
  event?: Electron.IpcMainInvokeEvent
): Promise<{ status: string; message: string }> => {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_MINGYU_MFA_ATTEMPTS; attempt++) {
    try {
      console.log(`Mingyu connection attempt ${attempt + 1}/${MAX_MINGYU_MFA_ATTEMPTS}`)
      const result = await attemptMingyuConnection(connectionInfo, event, attempt)
      return result
    } catch (error) {
      lastError = error as Error
      console.log(`Mingyu connection attempt ${attempt + 1} failed:`, lastError.message)

      if ((lastError as any).shouldRetry && attempt < MAX_MINGYU_MFA_ATTEMPTS - 1) {
        console.log(`Will retry attempt ${attempt + 2}...`)
        recordMingyuConnectionEvent({
          rootSessionId: connectionInfo.id,
          event: 'connect_retry_scheduled',
          phase: 'connecting',
          meta: {
            nextAttempt: attempt + 2,
            message: lastError.message
          }
        })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      break
    }
  }

  recordMingyuConnectionEvent({
    rootSessionId: connectionInfo.id,
    event: 'connect_failed',
    phase: 'closed',
    meta: {
      message: (lastError || new Error('Mingyu connection failed')).message
    }
  })

  if (event) {
    event.sender.send('ssh:keyboard-interactive-result', {
      id: connectionInfo.id,
      status: 'failed',
      final: true
    })
  }

  throw lastError || new Error('Mingyu connection failed')
}

export const registerMingyuHandlers = (): void => {
  // Only register if not already registered (check using global flag)
  if ((global as any).__mingyuHandlersRegistered) {
    console.log('[Mingyu-plugin] Handlers already registered globally, skipping')
    return
  }
  ;(global as any).__mingyuHandlersRegistered = true

  console.log('[Mingyu-plugin] Registering IPC handlers...')
  ipcMain.handle('mingyu:connect', async (event, connectionInfo: MingyuConnectionInfo) => {
    try {
      return await handleMingyuConnection(connectionInfo, event)
    } catch (error: unknown) {
      return buildErrorResponse(error)
    }
  })

  ipcMain.handle('mingyu:shell', async (_event, { id }) => {
    const stream = mingyuShellStreams.get(id)
    if (!stream) {
      return { status: 'error', message: 'Mingyu connection not found' }
    }

    return { status: 'success', message: 'Mingyu Shell is ready' }
  })

  ipcMain.on('mingyu:shell:write', (_event, { id, data, marker }) => {
    const stream = mingyuShellStreams.get(id) as { write: (data: string) => void } | undefined
    if (stream) {
      if (!mingyuInputBuffer.has(id)) {
        mingyuInputBuffer.set(id, '')
      }

      if (mingyuMarkedCommands.has(id)) {
        mingyuMarkedCommands.delete(id)
      }
      if (marker) {
        mingyuMarkedCommands.set(id, {
          marker,
          output: '',
          rawChunks: [] as Uint8Array[],
          rawBytes: 0,
          raw: [] as Uint8Array[],
          completed: false,
          lastActivity: Date.now(),
          idleTimer: null
        })
      }
      stream.write(data)
    } else {
      console.warn('Attempting to write to non-existent Mingyu stream:', id)
    }
  })

  ipcMain.handle('mingyu:conn:exec', async (_event, { id, cmd }) => {
    const conn = mingyuConnections.get(id)
    if (!conn) {
      return {
        success: false,
        error: `No Mingyu connection for id=${id}`,
        stdout: '',
        stderr: '',
        exitCode: undefined,
        exitSignal: undefined
      }
    }

    return new Promise((resolve) => {
      conn.conn.exec(cmd, (err, stream) => {
        if (err) {
          resolve({
            success: false,
            error: err.message,
            stdout: '',
            stderr: '',
            exitCode: undefined,
            exitSignal: undefined
          })
          return
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number, signal: string) => {
          resolve({
            success: code === 0,
            error: code !== 0 ? `Command failed with exit code: ${code}` : undefined,
            stdout,
            stderr,
            exitCode: code,
            exitSignal: signal
          })
        })
      })
    })
  })

  ipcMain.handle('mingyu:shell:resize', async (_event, { id, cols, rows }) => {
    const stream = mingyuShellStreams.get(id) as { setWindow?: (r: number, c: number, w: number, h: number) => void } | undefined
    if (!stream) {
      return { status: 'error', message: 'Mingyu Shell not found' }
    }

    try {
      if (stream.setWindow) {
        stream.setWindow(rows, cols, 0, 0)
      }
      return { status: 'success', message: `Mingyu window size set to ${cols}x${rows}` }
    } catch (error: unknown) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  })
}

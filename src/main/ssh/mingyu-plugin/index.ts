/**
 * Mingyu 堡垒机插件入口
 * 实现 BastionCapability 接口并注册到 capabilityRegistry
 */

import type { IpcMainInvokeEvent } from 'electron'
import { Client, ConnectConfig } from 'ssh2'
import { capabilityRegistry } from '../capabilityRegistry'
import type { BastionCapability, BastionDefinition, BastionRefreshOptions, BastionRefreshResult } from '../capabilityRegistry'
import { handleMingyuConnection, getPackageInfo } from './connectionManager'
import {
  mingyuShellStreams,
  mingyuConnections,
  mingyuConnectionStatus,
  mingyuLastCommand,
  mingyuInputBuffer,
  mingyuConnectedToTargetSent,
  mingyuExecStreams,
  mingyuMarkedCommands,
  mingyuUuidToConnectionId
} from './state'
import type { MingyuConnectionInfo, MingyuConnectResult, MingyuShellArgs, MingyuShellResult, MingyuWriteArgs, MingyuResizeArgs } from './types'
import { parseMingyuAssetEntries } from './parser'
import { MINGYU_CONSTANTS } from './constants'
import { LEGACY_ALGORITHMS } from '../algorithms'

// Stream type for shell sessions
interface ShellStream {
  write(data: string, callback?: (err?: Error) => void): void
  end(): void
  emit(event: string, ...args: unknown[]): void
  on(event: string, listener: (...args: unknown[]) => void): this
  removeAllListeners(event?: string): this
}

let mingyuRegistered = false

export const createMingyuBastionCapability = (): BastionCapability => {
  return {
    type: 'mingyu',

    connect: async (connectionInfo: any, event?: IpcMainInvokeEvent): Promise<MingyuConnectResult> => {
      try {
        const result = await handleMingyuConnection(connectionInfo as MingyuConnectionInfo, event)
        if (result.status === 'connected') {
          return {
            status: 'connected',
            sessionId: connectionInfo.id,
            message: result.message
          }
        }
        return {
          status: 'error',
          message: result.message || 'Connection failed'
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'error',
          message
        }
      }
    },

    shell: async (event: IpcMainInvokeEvent, args: MingyuShellArgs): Promise<MingyuShellResult> => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        return { status: 'error', message: 'Shell session not found' }
      }

      // Set up stream data handler to send output to UI (similar to jumpserver shell handler)
      stream.removeAllListeners('data')

      let buffer = ''
      let flushTimer: NodeJS.Timeout | null = null
      const rawChunks: Buffer[] = []
      let rawBytes = 0

      // Shell prompt detection regex - matches shell prompts ending with $ or #
      // Same pattern as in sshHandle.ts for consistency
      const SHELL_PROMPT_REGEX = /[$#]\s*$/m

      const getDelayByBufferSize = (size: number): number => {
        if (size < 1024) return 0
        if (size < 4096) return 5
        if (size < 16384) return 10
        return 20
      }

      const flushBuffer = () => {
        if (!buffer && rawBytes === 0) return
        const chunk = buffer
        buffer = ''
        const raw = rawBytes ? Buffer.concat(rawChunks, rawBytes) : undefined
        rawChunks.splice(0, rawChunks.length)
        rawBytes = 0

        // Detect shell prompt for AI Chat auto-open
        // This handles mingyu-type connections where the target shell prompt arrives via main-shell stream
        if (!mingyuConnectedToTargetSent.has(args.id) && SHELL_PROMPT_REGEX.test(chunk)) {
          mingyuConnectedToTargetSent.add(args.id)
          event.sender.send('jumpserver:status-update', {
            id: args.id,
            message: 'Successfully connected to target server, you can start operating',
            messageKey: 'ssh.jumpserver.connectedToTarget',
            type: 'success',
            timestamp: new Date().toLocaleTimeString()
          })
        }

        event.sender.send(`ssh:shell:data:${args.id}`, { data: chunk, raw, marker: '' })
        flushTimer = null
      }

      const scheduleFlush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer)
        }
        const delay = getDelayByBufferSize(buffer.length)
        if (delay === 0) {
          flushBuffer()
        } else {
          flushTimer = setTimeout(flushBuffer, delay)
        }
      }

      stream.on('data', (data) => {
        const dataStr = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)

        // Check if this is a marked command output collection
        const markedCmd = mingyuMarkedCommands.get(args.id)
        if (markedCmd !== undefined) {
          // For Chaterm:command marker, send each chunk immediately (same as jumpserver)
          if (markedCmd.marker === 'Chaterm:command') {
            const rawData = Buffer.isBuffer(data) ? data : Buffer.from(dataStr, 'utf8')
            event.sender.send(`ssh:shell:data:${args.id}`, {
              data: dataStr,
              raw: rawData,
              marker: markedCmd.marker
            })
            return
          }
          // Otherwise, accumulate output
          markedCmd.output += dataStr
          markedCmd.rawChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(dataStr, 'utf8'))
          markedCmd.rawBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(dataStr, 'utf8')
          markedCmd.lastActivity = Date.now()
          if (markedCmd.idleTimer) {
            clearTimeout(markedCmd.idleTimer)
          }
          markedCmd.idleTimer = setTimeout(() => {
            if (markedCmd && !markedCmd.completed) {
              markedCmd.completed = true
              const markedRaw = markedCmd.rawBytes ? Buffer.concat(markedCmd.rawChunks, markedCmd.rawBytes) : undefined
              event.sender.send(`ssh:shell:data:${args.id}`, {
                data: markedCmd.output,
                raw: markedRaw,
                marker: markedCmd.marker
              })
              mingyuMarkedCommands.delete(args.id)
            }
          }, 200)
          return
        }

        // Normal shell output handling (non-marked)
        buffer += dataStr
        if (Buffer.isBuffer(data)) {
          rawChunks.push(data)
          rawBytes += data.length
        }
        scheduleFlush()
      })

      return { status: 'success' }
    },

    write: (args: MingyuWriteArgs): void => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        console.warn('[Mingyu-plugin] Write to non-existent shell session:', args.id)
        return
      }

      // Set markedCommands for command output collection (same logic as jumpserverHandle.ts)
      if (mingyuMarkedCommands.has(args.id)) {
        mingyuMarkedCommands.delete(args.id)
      }
      if (args.marker) {
        mingyuMarkedCommands.set(args.id, {
          marker: args.marker,
          output: '',
          completed: false,
          rawChunks: [],
          rawBytes: 0,
          raw: [],
          lastActivity: Date.now(),
          idleTimer: null
        })
      }

      // Write data as-is, without appending '\n'
      // The terminal handles line endings when user presses Enter
      stream.write(args.data)
      mingyuLastCommand.set(args.id, args.data)
    },

    resize: async (args: MingyuResizeArgs): Promise<void> => {
      const stream = mingyuShellStreams.get(args.id) as ShellStream | undefined
      if (!stream) {
        console.warn('[Mingyu-plugin] Resize on non-existent shell session:', args.id)
        return
      }
      stream.emit('resize', args.cols, args.rows)
    },

    disconnect: async (args: { id: string }): Promise<void> => {
      const { id } = args

      console.log(`[Mingyu-plugin] Disconnecting session: ${id}`)

      const stream = mingyuShellStreams.get(id) as ShellStream | undefined
      if (stream) {
        // Send exit command to properly notify Mingyu bastion that session is closing
        // Without this, the bastion may keep the session alive
        try {
          stream.write('exit\r')
        } catch (e) {
          // Ignore write errors, proceed to close anyway
        }
        stream.end()
        mingyuShellStreams.delete(id)
        console.log(`[Mingyu-plugin] Shell stream closed for: ${id}`)
      }

      // Clean up exec streams
      const execStream = mingyuExecStreams.get(id)
      if (execStream) {
        console.log(`[Mingyu-plugin] Cleaning up exec stream: ${id}`)
        ;(execStream as any).end()
        mingyuExecStreams.delete(id)
      }

      const connData = mingyuConnections.get(id)
      if (connData) {
        // Clean up mingyuUuidToConnectionId mapping
        if (connData.mingyuUuid) {
          mingyuUuidToConnectionId.delete(connData.mingyuUuid)
          console.log(`[Mingyu-plugin] Cleaned up mingyuUuid mapping: ${connData.mingyuUuid}`)
        }
        // End the SSH connection
        connData.conn.end()
        mingyuConnections.delete(id)
        console.log(`[Mingyu-plugin] SSH connection closed for: ${id}`)
      }

      // Clean up marked commands
      mingyuMarkedCommands.delete(id)

      // Clean up other state
      mingyuConnectionStatus.delete(id)
      mingyuLastCommand.delete(id)
      mingyuInputBuffer.delete(id)
      mingyuConnectedToTargetSent.delete(id)

      console.log(`[Mingyu-plugin] Session disconnected and cleaned up: ${id}`)
    },

    refreshAssets: async (options: BastionRefreshOptions): Promise<BastionRefreshResult> => {
      console.log('[Mingyu-plugin] refreshAssets: Starting asset refresh for organization:', options.organizationUuid)

      const { host, port, username, password, privateKey, passphrase, onProgress, onMfaRequired } = options

      return new Promise((resolve) => {
        const conn = new Client()

        const connectConfig: ConnectConfig = {
          host,
          port: port || 22,
          username,
          keepaliveInterval: 10000,
          readyTimeout: 180000,
          tryKeyboard: true,
          algorithms: LEGACY_ALGORITHMS
        }

        const identToken = ''
        const packageInfo = getPackageInfo()
        connectConfig.ident = `${packageInfo.name}_${packageInfo.version}${identToken}`

        if (privateKey) {
          connectConfig.privateKey = Buffer.from(privateKey)
          if (passphrase) {
            connectConfig.passphrase = passphrase
          }
        } else if (password) {
          connectConfig.password = password
        } else {
          resolve({
            success: false,
            error: 'Missing authentication info: private key or password required'
          })
          return
        }

        let outputBuffer = ''
        let shellStream: import('ssh2').ClientChannel | null = null
        let dataSettleTimer: NodeJS.Timeout | null = null
        let isMenuLoaded = false
        let isConnecting = true

        const scheduleDataSettle = () => {
          if (dataSettleTimer) {
            clearTimeout(dataSettleTimer)
          }
          dataSettleTimer = setTimeout(() => {
            if (!isConnecting && isMenuLoaded) {
              // We've received menu prompt and waited for data to settle
              // Parse and return the assets
              try {
                const entries = parseMingyuAssetEntries(outputBuffer)
                console.log(`[Mingyu-plugin] refreshAssets: Parsed ${entries.length} assets`)

                const assets = entries.map((entry) => ({
                  hostname: entry.name,
                  host: entry.address,
                  comment: entry.comment || entry.group || ''
                }))

                if (shellStream) {
                  shellStream.end()
                }
                conn.end()

                resolve({
                  success: true,
                  assets
                })
              } catch (parseError) {
                console.error('[Mingyu-plugin] refreshAssets: Parse error:', parseError)
                if (shellStream) {
                  shellStream.end()
                }
                conn.end()
                resolve({
                  success: false,
                  error: `Failed to parse asset list: ${parseError instanceof Error ? parseError.message : String(parseError)}`
                })
              }
            }
          }, MINGYU_CONSTANTS.DATA_SETTLE_DELAY)
        }

        conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
          console.log('[Mingyu-plugin] refreshAssets: Keyboard-interactive auth required')

          if (onMfaRequired) {
            onMfaRequired()
              .then((mfaCode) => {
                if (mfaCode === null) {
                  console.warn('[Mingyu-plugin] refreshAssets: MFA cancelled by user')
                  finish([])
                  conn.end()
                  resolve({ success: false, error: 'MFA authentication cancelled by user' })
                } else {
                  finish([mfaCode])
                }
              })
              .catch((mfaError) => {
                console.error('[Mingyu-plugin] refreshAssets: MFA error:', mfaError)
                finish([])
                conn.end()
                resolve({ success: false, error: `MFA error: ${mfaError instanceof Error ? mfaError.message : String(mfaError)}` })
              })
          } else {
            console.warn('[Mingyu-plugin] refreshAssets: MFA required but no handler provided')
            finish([])
            conn.end()
            resolve({ success: false, error: 'Two-factor authentication required but no handler provided' })
          }
        })

        conn.on('ready', () => {
          console.log('[Mingyu-plugin] refreshAssets: SSH connection established')
          isConnecting = false

          conn.shell((err, stream) => {
            if (err) {
              console.error('[Mingyu-plugin] refreshAssets: Shell error:', err)
              conn.end()
              resolve({ success: false, error: `Shell error: ${err.message}` })
              return
            }

            shellStream = stream

            stream.on('data', (data: Buffer) => {
              const chunk = data.toString('utf8')
              outputBuffer += chunk

              // Check if menu is loaded ([GateShell] prompt detected)
              if (!isMenuLoaded && outputBuffer.includes('[GateShell]')) {
                console.log('[Mingyu-plugin] refreshAssets: Menu prompt detected, sending list command')
                isMenuLoaded = true
                onProgress?.('Menu loaded, fetching asset list...')
                stream.write('r\r')
              } else if (isMenuLoaded) {
                // Menu already loaded, we're receiving asset list data
                scheduleDataSettle()
              }
            })

            stream.on('close', () => {
              console.log('[Mingyu-plugin] refreshAssets: Stream closed')
              if (dataSettleTimer) {
                clearTimeout(dataSettleTimer)
              }
            })

            stream.on('error', (streamErr: Error) => {
              console.error('[Mingyu-plugin] refreshAssets: Stream error:', streamErr)
              if (dataSettleTimer) {
                clearTimeout(dataSettleTimer)
              }
              conn.end()
              resolve({ success: false, error: `Stream error: ${streamErr.message}` })
            })

            // Wait for menu prompt with timeout
            // Note: timeout fires even if menu already loaded, but isMenuLoaded check prevents action
            setTimeout(() => {
              if (!isMenuLoaded) {
                console.error('[Mingyu-plugin] refreshAssets: Timeout waiting for menu prompt')
                stream.end()
                conn.end()
                resolve({ success: false, error: 'Timeout waiting for menu prompt' })
              }
            }, MINGYU_CONSTANTS.NAVIGATION_TIMEOUT)
          })
        })

        conn.on('error', (err) => {
          console.error('[Mingyu-plugin] refreshAssets: SSH connection error:', err)
          if (dataSettleTimer) {
            clearTimeout(dataSettleTimer)
          }
          resolve({ success: false, error: `SSH connection error: ${err.message}` })
        })

        console.log('[Mingyu-plugin] refreshAssets: Connecting to', host, 'port', port || 22)
        conn.connect(connectConfig)
      })
    },

    getShellStream: (id: string): unknown => {
      // Try direct lookup first
      const stream = mingyuShellStreams.get(id)
      if (stream) {
        console.log(`[Mingyu-plugin] getShellStream: direct hit for id=${id}`)
        return stream
      }

      // Fallback: if direct lookup fails, the AI Chat may have created a new sessionId
      // but the underlying connection is the same. Search for any existing stream
      // in mingyuConnections to enable AI Chat command execution.
      // This handles the case where AI Chat uses a different sessionId than the original.
      console.log(`[Mingyu-plugin] getShellStream: miss for id=${id}, checking ${mingyuShellStreams.size} existing streams`)
      for (const [existingId, connData] of mingyuConnections.entries()) {
        const existingStream = mingyuShellStreams.get(existingId)
        if (existingStream) {
          console.log(
            `[Mingyu-plugin] getShellStream fallback: found stream via existingId=${existingId}, targetIp=${connData.targetIp}, mingyuUuid=${connData.mingyuUuid}`
          )
          return existingStream
        }
      }

      console.warn(
        `[Mingyu-plugin] getShellStream: no stream found for id=${id}, mingyuConnections size=${mingyuConnections.size}, mingyuShellStreams size=${mingyuShellStreams.size}`
      )
      return undefined
    },

    /**
     * Execute command directly via SSH exec channel.
     * This bypasses the shell stream and uses conn.exec() directly.
     * Critical for Mingyu because the menu intercepts shell I/O.
     */
    exec: async (id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const connectionData = mingyuConnections.get(id)
      if (!connectionData) {
        throw new Error(`No Mingyu connection for id=${id}`)
      }

      const conn = connectionData.conn
      if (!conn) {
        throw new Error(`No SSH Client in Mingyu connection for id=${id}`)
      }

      console.log(`[Mingyu-plugin] exec: executing via conn.exec() for id=${id}, command=${command}`)

      return new Promise((resolve) => {
        conn.exec(command, (err: any, stream: any) => {
          if (err) {
            console.error(`[Mingyu-plugin] exec error:`, err)
            resolve({
              stdout: '',
              stderr: err.message,
              exitCode: 1
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

          stream.on('close', () => {
            console.log(`[Mingyu-plugin] exec completed: exitCode=${stream.exitCode ?? 0}`)
            resolve({
              stdout,
              stderr,
              exitCode: (stream.exitCode as number) ?? 0
            })
          })
        })
      })
    }
  }
}

export const getMingyuBastionDefinition = (): BastionDefinition => {
  return {
    type: 'mingyu',
    version: 1,
    displayNameKey: 'bastion.mingyu.name',
    assetTypePrefix: 'organization-mingyu',
    authPolicy: ['password', 'keyBased'],
    supportsRefresh: true,
    supportsShellStream: true,
    agentExec: 'stream'
  }
}

export const registerMingyuPlugin = (): void => {
  // Check if already registered by verifying capabilityRegistry has the plugin
  // This handles the case where capabilityRegistry.clearBastions() was called
  if (mingyuRegistered && capabilityRegistry.hasBastion('mingyu')) {
    console.log('[Mingyu-plugin] Plugin already registered in capabilityRegistry, skipping')
    return
  }

  // Mark as registered BEFORE attempting registration to prevent re-entry
  mingyuRegistered = true

  try {
    console.log('[Mingyu-plugin] Starting plugin registration...')

    // Note: IPC handlers are NOT registered here because:
    // 1. ssh:connect routes 'mingyu' to capabilityRegistry.getBastion('mingyu').connect()
    // 2. The IPC handlers in connectionManager.ts (mingyu:connect, etc.) are never called
    // 3. JumpServer's registerJumpServerHandlers() also follows the same pattern

    // Register bastion definition
    console.log('[Mingyu-plugin] Registering bastion definition...')
    capabilityRegistry.registerBastionDefinition(getMingyuBastionDefinition())

    // Register bastion capability
    console.log('[Mingyu-plugin] Registering bastion capability...')
    capabilityRegistry.registerBastion(createMingyuBastionCapability())

    console.log('[Mingyu-plugin] Plugin registered successfully')
    console.log('[Mingyu-plugin] Registered bastions:', capabilityRegistry.listBastions())
  } catch (error) {
    // Revert registration state on failure
    mingyuRegistered = false
    console.error('[Mingyu-plugin] Failed to register plugin:', error)
  }
}

export const unregisterMingyuPlugin = (): void => {
  if (!mingyuRegistered) {
    console.log('[Mingyu-plugin] Plugin not registered, skipping')
    return
  }

  capabilityRegistry.unregisterBastion('mingyu')
  capabilityRegistry.unregisterBastionDefinition('mingyu')

  mingyuRegistered = false
  console.log('[Mingyu-plugin] Plugin unregistered')
}

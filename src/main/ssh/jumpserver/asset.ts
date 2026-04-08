// jumpserver-client.ts
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import type { JumpServerShellProfile } from './constants'
import { JUMPSERVER_CONSTANTS } from './constants'
import { Asset, parseJumpserverOutput } from './parser'
import {
  getJumpServerListCommand,
  getJumpServerNextPageCommand,
  hasJumpServerCommandPrompt,
  hasJumpServerInitialMenuPrompt,
  resolveJumpServerShellProfile
} from './navigator'

import { getPackageInfo } from './connectionManager'
import { LEGACY_ALGORITHMS } from '../algorithms'

interface JumpServerConfig {
  host: string
  port?: number
  username: string
  privateKey?: string
  password?: string
  passphrase?: string
  connIdentToken?: string
}

interface KeyboardInteractiveHandler {
  (prompts: any[], finish: (responses: string[]) => void): Promise<void>
}

interface AuthResultCallback {
  (success: boolean, error?: string): void
}

export interface JumpServerAssetRefreshResult {
  assets: Asset[]
  profile: JumpServerShellProfile
  recognized: boolean
  complete: boolean
  debugLogPath?: string
}

const JUMPSERVER_ASSET_DEBUG_LOG_ENABLED = process.env.CHATERM_JUMPSERVER_ASSET_DEBUG_LOG !== 'false'
const JUMPSERVER_ASSET_DEBUG_LOG_PREFIX = 'chaterm-jumpserver-assets-'

class JumpServerAssetDebugLogger {
  private readonly enabled: boolean
  private readonly logPath: string | null

  constructor(enabled: boolean) {
    this.enabled = enabled
    this.logPath = enabled
      ? path.join(os.tmpdir(), `${JUMPSERVER_ASSET_DEBUG_LOG_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.log`)
      : null

    if (this.logPath) {
      this.write('session_start', { pid: process.pid, platform: process.platform, tmpdir: os.tmpdir() })
    }
  }

  get path(): string | undefined {
    return this.logPath ?? undefined
  }

  log(event: string, meta?: Record<string, unknown>): void {
    this.write(event, meta)
  }

  logOutput(event: string, output: string, meta?: Record<string, unknown>): void {
    this.write(event, {
      ...meta,
      outputLength: output.length,
      outputPreview: output.slice(-500),
      output
    })
  }

  private write(event: string, meta?: Record<string, unknown>): void {
    if (!this.enabled || !this.logPath) {
      return
    }

    try {
      fs.appendFileSync(
        this.logPath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          ...meta
        }) + '\n'
      )
    } catch (error) {
      console.error('JumpServer asset debug log write failed:', error)
    }
  }
}

class JumpServerClient {
  private conn: Client | null = null
  private stream: import('ssh2').ClientChannel | null = null
  private config: JumpServerConfig
  private isConnected = false
  private outputBuffer = ''
  private listCommand: string = getJumpServerListCommand('standard')
  private shellProfile: JumpServerShellProfile = 'standard'
  private dataResolve: ((data: string) => void) | null = null
  private dataSettleTimer: NodeJS.Timeout | null = null
  private keyboardInteractiveHandler?: KeyboardInteractiveHandler
  private authResultCallback?: AuthResultCallback
  private readonly debugLogger = new JumpServerAssetDebugLogger(JUMPSERVER_ASSET_DEBUG_LOG_ENABLED)

  constructor(config: JumpServerConfig, keyboardInteractiveHandler?: KeyboardInteractiveHandler, authResultCallback?: AuthResultCallback) {
    this.config = config
    this.keyboardInteractiveHandler = keyboardInteractiveHandler
    this.authResultCallback = authResultCallback
  }

  private clearDataSettleTimer(): void {
    if (this.dataSettleTimer) {
      clearTimeout(this.dataSettleTimer)
      this.dataSettleTimer = null
    }
  }

  getDebugLogPath(): string | undefined {
    return this.debugLogger.path
  }

  private logDebug(event: string, meta?: Record<string, unknown>): void {
    this.debugLogger.log(event, meta)
  }

  private logDebugOutput(event: string, output: string, meta?: Record<string, unknown>): void {
    this.debugLogger.logOutput(event, output, meta)
  }

  private updateShellProfile(source: string, text: string): void {
    const previousProfile = this.shellProfile
    const nextProfile = resolveJumpServerShellProfile(text, previousProfile)
    this.shellProfile = nextProfile

    if (nextProfile !== previousProfile) {
      this.logDebug('profile_changed', {
        source,
        previousProfile,
        nextProfile,
        bufferLength: text.length,
        preview: text.slice(-200)
      })
    }
  }

  private scheduleCommandCompletion(): void {
    if (!this.dataResolve) {
      return
    }

    this.clearDataSettleTimer()
    this.dataSettleTimer = setTimeout(() => {
      if (!this.dataResolve) {
        return
      }

      const resolveData = this.dataResolve
      if (!resolveData) {
        return
      }
      const output = this.outputBuffer
      console.log('JumpServerClient: Command end marker detected, returning output, length:', output.length, 'profile:', this.shellProfile)
      this.logDebugOutput('command_completed', output, {
        profile: this.shellProfile,
        hasPrompt: hasJumpServerCommandPrompt(output, this.shellProfile)
      })
      this.dataResolve = null
      this.outputBuffer = ''
      this.clearDataSettleTimer()
      resolveData(output)
    }, JUMPSERVER_CONSTANTS.DATA_SETTLE_DELAY)
  }

  /**
   * Connect to JumpServer and establish a persistent shell
   */
  async connect(): Promise<void> {
    console.log('JumpServerClient.connect: Starting connection to JumpServer')
    this.logDebug('connect_start', {
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      hasPassword: !!this.config.password,
      hasPrivateKey: !!this.config.privateKey,
      connIdentToken: this.config.connIdentToken ?? null
    })
    return new Promise((resolve, reject) => {
      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.username,
        keepaliveInterval: 10000,
        readyTimeout: 180000,
        tryKeyboard: true,
        algorithms: LEGACY_ALGORITHMS
      }

      const identToken = this.config.connIdentToken ? `_t=${this.config.connIdentToken}` : ''
      const packageInfo = getPackageInfo()
      connectConfig.ident = `${packageInfo.name}_${packageInfo.version}` + identToken

      if (this.config.privateKey) {
        connectConfig.privateKey = Buffer.from(this.config.privateKey)
        if (this.config.passphrase) {
          connectConfig.passphrase = this.config.passphrase
        }
      } else if (this.config.password) {
        connectConfig.password = this.config.password
      } else {
        this.logDebug('connect_missing_auth')
        return reject(new Error('Missing authentication info: private key or password required'))
      }

      this.conn = new Client()

      this.conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
        this.logDebug('keyboard_interactive', {
          promptCount: prompts.length,
          prompts: prompts.map((prompt: { prompt?: string; echo?: boolean }) => ({
            prompt: prompt.prompt ?? '',
            echo: !!prompt.echo
          }))
        })

        if (this.keyboardInteractiveHandler) {
          console.log('JumpServerClient: Two-factor authentication required, calling handler...')
          this.keyboardInteractiveHandler(prompts, finish).catch((error) => {
            console.error('JumpServerClient: Two-factor authentication handler error', error)
            this.logDebug('keyboard_interactive_error', {
              errorMessage: error instanceof Error ? error.message : String(error)
            })
            this.conn?.end()
            reject(error)
          })
        } else {
          console.log('JumpServerClient: Two-factor authentication required but no handler provided, rejecting connection')
          finish([])
          reject(new Error('Two-factor authentication required but no handler provided'))
        }
      })

      this.conn.on('ready', () => {
        this.isConnected = true
        console.log('JumpServerClient: SSH connection established')
        this.logDebug('connect_ready')

        if (this.authResultCallback) {
          this.authResultCallback(true)
        }

        this.conn!.shell((error, stream) => {
          if (error) {
            this.logDebug('shell_open_error', {
              errorMessage: error.message
            })
            return reject(error)
          }
          this.stream = stream
          this.logDebug('shell_opened')

          this.stream.on('data', (data: Buffer) => {
            const ansiRegex = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nry=><]/g
            const rawChunk = data.toString()
            const chunk = rawChunk.replace(ansiRegex, '')
            this.outputBuffer += chunk
            this.updateShellProfile('stream_data', this.outputBuffer)
            this.logDebugOutput('stream_data', chunk, {
              rawLength: rawChunk.length,
              bufferLength: this.outputBuffer.length,
              profile: this.shellProfile,
              commandPromptDetected: hasJumpServerCommandPrompt(this.outputBuffer, this.shellProfile)
            })

            if (this.dataResolve && hasJumpServerCommandPrompt(this.outputBuffer, this.shellProfile)) {
              this.scheduleCommandCompletion()
            }
          })

          this.stream.on('close', () => {
            console.log('Stream closed')
            this.logDebug('stream_closed', {
              isConnected: this.isConnected,
              pendingCommand: !!this.dataResolve
            })
            this.clearDataSettleTimer()
            this.isConnected = false
          })

          this.stream.on('error', (error: Error) => {
            console.error('Stream error:', error)
            this.logDebug('stream_error', {
              errorMessage: error.message,
              stack: error.stack
            })
            this.clearDataSettleTimer()
            if (this.dataResolve) {
              this.dataResolve = null
              this.outputBuffer = ''
              reject(error)
            }
          })

          const waitForMenu = (retries = 10) => {
            console.log(
              `JumpServerClient: Waiting for initial menu, remaining retries: ${retries}, current buffer length: ${this.outputBuffer.length}`
            )
            this.logDebug('wait_for_menu_tick', {
              retries,
              bufferLength: this.outputBuffer.length,
              profile: this.shellProfile,
              hasInitialPrompt: hasJumpServerInitialMenuPrompt(this.outputBuffer, this.shellProfile)
            })
            if (retries === 0) {
              console.log('JumpServerClient: Timeout waiting for initial menu, buffer content:', this.outputBuffer)
              this.logDebugOutput('wait_for_menu_timeout', this.outputBuffer, {
                profile: this.shellProfile
              })
              return reject(new Error('Failed to get initial menu prompt.'))
            }

            this.updateShellProfile('wait_for_menu', this.outputBuffer)
            if (hasJumpServerInitialMenuPrompt(this.outputBuffer, this.shellProfile)) {
              this.listCommand = getJumpServerListCommand(this.shellProfile)
              console.log('JumpServerClient: Initial menu loaded, profile:', this.shellProfile, 'buffer content:', this.outputBuffer)
              this.logDebugOutput('initial_menu_detected', this.outputBuffer, {
                profile: this.shellProfile,
                listCommand: this.listCommand
              })
              this.outputBuffer = ''
              resolve()
              return
            }

            setTimeout(() => waitForMenu(retries - 1), 500)
          }
          setTimeout(waitForMenu, 500)
        })
      })

      this.conn.on('error', (error) => {
        console.log('JumpServerClient: SSH connection error', error)
        this.logDebug('connect_error', {
          errorMessage: error.message,
          stack: error.stack
        })

        if (this.authResultCallback) {
          this.authResultCallback(false, error.message)
        }

        reject(error)
      })

      this.conn.connect(connectConfig)
    })
  }

  /**
   * Execute command in persistent shell and get output
   */
  private async executeCommand(command: string): Promise<string> {
    console.log(`JumpServerClient.executeCommand: Executing command "${command}"`)

    if (!this.stream) {
      console.log('JumpServerClient.executeCommand: Shell stream not available')
      this.logDebug('command_missing_stream', { command })
      throw new Error('Shell stream is not available.')
    }

    const stream = this.stream

    return new Promise((resolve, reject) => {
      this.clearDataSettleTimer()
      this.outputBuffer = ''
      this.dataResolve = resolve
      this.logDebug('command_sent', {
        command,
        profile: this.shellProfile
      })

      console.log(`JumpServerClient.executeCommand: Sending command to stream: "${command}"`)
      stream.write(command + '\r')

      const timeoutId = setTimeout(() => {
        if (this.dataResolve) {
          console.log(`JumpServerClient.executeCommand: Command "${command}" timed out`)
          this.logDebugOutput('command_timeout', this.outputBuffer, {
            command,
            profile: this.shellProfile
          })
          this.clearDataSettleTimer()
          this.dataResolve = null
          reject(new Error(`Command '${command}' timed out.`))
        }
      }, 15000)

      const originalResolve = this.dataResolve
      this.dataResolve = (data: string) => {
        clearTimeout(timeoutId)
        this.logDebug('command_resolved', {
          command,
          profile: this.shellProfile,
          outputLength: data.length
        })
        originalResolve(data)
      }
    })
  }

  /**
   * Get all assets
   */
  async getAllAssets(): Promise<JumpServerAssetRefreshResult> {
    console.log('JumpServerClient.getAllAssets: Starting to fetch assets')
    this.logDebug('asset_refresh_start', {
      initialProfile: this.shellProfile,
      initialListCommand: this.listCommand
    })

    if (!this.isConnected) {
      console.log('JumpServerClient.getAllAssets: Connection not established, starting connection...')
      await this.connect()
      console.log('JumpServerClient.getAllAssets: Connection established')
    } else {
      console.log('JumpServerClient.getAllAssets: Connection already exists')
    }

    const allAssets: Asset[] = []
    const seenAssetAddresses = new Set<string>()
    let recognized = false
    let complete = true

    const collectAssets = (pageAssets: Asset[]) => {
      pageAssets.forEach((asset) => {
        if (!seenAssetAddresses.has(asset.address)) {
          allAssets.push(asset)
          seenAssetAddresses.add(asset.address)
        }
      })
    }

    console.log(`JumpServerClient.getAllAssets: Executing command "${this.listCommand}" to get first page of assets...`)
    let output = await this.executeCommand(this.listCommand)
    this.updateShellProfile('first_page_output', output)
    console.log('JumpServerClient.getAllAssets: Received first page output, length:', output.length, 'profile:', this.shellProfile)
    this.logDebugOutput('first_page_output', output, {
      profile: this.shellProfile,
      listCommand: this.listCommand
    })

    let parsedOutput = parseJumpserverOutput(output)
    if (parsedOutput.profile) {
      this.shellProfile = parsedOutput.profile
      this.listCommand = getJumpServerListCommand(this.shellProfile)
    }

    let { assets: pageAssets, pagination } = parsedOutput
    recognized = recognized || parsedOutput.recognized
    this.logDebug('first_page_parsed', {
      profile: this.shellProfile,
      parsedProfile: parsedOutput.profile,
      assetCount: pageAssets.length,
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      recognized: parsedOutput.recognized,
      listCommand: this.listCommand
    })
    console.log(
      'JumpServerClient.getAllAssets: Parsed first page result, asset count:',
      pageAssets.length,
      'pagination info:',
      pagination,
      'recognized:',
      parsedOutput.recognized
    )

    collectAssets(pageAssets)

    const MAX_PAGES = 100
    const maxPagesToFetch = Math.min(pagination.totalPages, MAX_PAGES)
    if (pagination.totalPages > MAX_PAGES) {
      complete = false
      this.logDebug('pagination_truncated_by_limit', {
        totalPages: pagination.totalPages,
        maxPagesToFetch
      })
    }

    console.log(`JumpServerClient.getAllAssets: Total pages ${pagination.totalPages}, limiting fetch to ${maxPagesToFetch} pages`)

    let nextPageCommand = getJumpServerNextPageCommand(this.shellProfile)
    if (pagination.currentPage < maxPagesToFetch && !nextPageCommand) {
      console.log(
        `JumpServerClient.getAllAssets: Profile ${this.shellProfile} does not expose a next-page command, skipping deletion-safe pagination`
      )
      this.logDebug('pagination_unavailable_for_profile', {
        profile: this.shellProfile,
        currentPage: pagination.currentPage,
        totalPages: pagination.totalPages
      })
      complete = false
    }

    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 2
    const startTime = Date.now()

    while (nextPageCommand && pagination.currentPage < maxPagesToFetch && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      if (Date.now() - startTime > 5 * 60 * 1000) {
        console.log('JumpServerClient.getAllAssets: Running for more than 5 minutes, stopping fetch of more pages')
        this.logDebug('pagination_stopped_by_total_timeout', {
          elapsedMs: Date.now() - startTime,
          currentPage: pagination.currentPage,
          totalPages: pagination.totalPages
        })
        complete = false
        break
      }
      const nextPage = pagination.currentPage + 1
      console.log(`JumpServerClient.getAllAssets: Fetching page ${nextPage} with command "${nextPageCommand}"...`)
      this.logDebug('pagination_fetch_start', {
        nextPage,
        command: nextPageCommand,
        profile: this.shellProfile,
        currentPage: pagination.currentPage,
        totalPages: pagination.totalPages
      })

      try {
        const pageStartTime = Date.now()
        let commandSucceeded = false
        let retryCount = 0
        const maxRetries = 1

        while (!commandSucceeded && retryCount <= maxRetries) {
          try {
            output = await this.executeCommand(nextPageCommand)
            commandSucceeded = true
          } catch (commandError) {
            retryCount++
            this.logDebug('pagination_command_retry', {
              nextPage,
              retryCount,
              maxRetries,
              errorMessage: commandError instanceof Error ? commandError.message : String(commandError)
            })
            if (retryCount <= maxRetries) {
              console.log(`JumpServerClient.getAllAssets: Page ${nextPage} command failed, retrying ${retryCount}/${maxRetries}`)
              await new Promise((resolve) => setTimeout(resolve, 2000))
            } else {
              throw commandError
            }
          }
        }

        const pageTime = Date.now() - pageStartTime
        console.log(`JumpServerClient.getAllAssets: Page ${nextPage} output length: ${output.length}, time taken: ${pageTime}ms`)
        this.logDebugOutput('pagination_page_output', output, {
          nextPage,
          pageTime,
          profile: this.shellProfile
        })
        consecutiveFailures = 0

        if (pageTime > 15000) {
          console.log(`JumpServerClient.getAllAssets: Page ${nextPage} took too long (${pageTime}ms), stopping fetch`)
          this.logDebug('pagination_stopped_by_page_timeout', {
            nextPage,
            pageTime
          })
          complete = false
          break
        }
      } catch (error) {
        consecutiveFailures++
        console.error(`JumpServerClient.getAllAssets: Failed to fetch page ${nextPage} (consecutive failures ${consecutiveFailures}):`, error)
        this.logDebug('pagination_fetch_error', {
          nextPage,
          consecutiveFailures,
          errorMessage: error instanceof Error ? error.message : String(error)
        })

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`JumpServerClient.getAllAssets: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, stopping fetch of more pages`)
          this.logDebug('pagination_stopped_by_consecutive_failures', {
            consecutiveFailures,
            nextPage
          })
          complete = false
          break
        }

        pagination.currentPage++
        complete = false
        continue
      }

      this.updateShellProfile('pagination_output', output)
      parsedOutput = parseJumpserverOutput(output)
      if (parsedOutput.profile) {
        this.shellProfile = parsedOutput.profile
      }
      recognized = recognized || parsedOutput.recognized

      const newPagination = parsedOutput.pagination
      if (newPagination.totalPages > 1) {
        pagination = newPagination
      } else {
        pagination.currentPage++
      }

      pageAssets = parsedOutput.assets
      this.logDebug('pagination_page_parsed', {
        nextPage,
        profile: this.shellProfile,
        parsedProfile: parsedOutput.profile,
        assetCount: pageAssets.length,
        currentPage: pagination.currentPage,
        totalPages: pagination.totalPages,
        recognized: parsedOutput.recognized
      })
      console.log(
        `JumpServerClient.getAllAssets: Page ${nextPage} parsed result, asset count: ${pageAssets.length}, recognized: ${parsedOutput.recognized}`
      )

      if (pageAssets.length === 0) {
        console.log(`JumpServerClient.getAllAssets: Page ${nextPage} has no assets, stopping pagination`)
        this.logDebug('pagination_stopped_by_empty_page', {
          nextPage,
          recognized: parsedOutput.recognized
        })
        complete = false
        break
      }

      const assetCountBeforeMerge = allAssets.length
      collectAssets(pageAssets)

      if (allAssets.length === assetCountBeforeMerge) {
        console.log(`JumpServerClient.getAllAssets: Page ${nextPage} found no new assets, stopping pagination`)
        this.logDebug('pagination_stopped_by_duplicate_page', {
          nextPage,
          assetCountBeforeMerge,
          currentAssetCount: allAssets.length
        })
        complete = false
        break
      }

      nextPageCommand = getJumpServerNextPageCommand(this.shellProfile)
      if (pagination.currentPage < maxPagesToFetch && !nextPageCommand) {
        console.log(`JumpServerClient.getAllAssets: Profile ${this.shellProfile} cannot continue pagination after page ${nextPage}`)
        this.logDebug('pagination_missing_next_command', {
          nextPage,
          profile: this.shellProfile,
          currentPage: pagination.currentPage,
          totalPages: pagination.totalPages
        })
        complete = false
        break
      }

      console.log(`JumpServerClient.getAllAssets: Page ${nextPage} processing complete, current total asset count: ${allAssets.length}`)
    }

    console.log(
      `JumpServerClient.getAllAssets: Complete, total assets fetched: ${allAssets.length}, profile: ${this.shellProfile}, recognized: ${recognized}, complete: ${complete}`
    )
    this.logDebug('asset_refresh_complete', {
      totalAssets: allAssets.length,
      profile: this.shellProfile,
      recognized,
      complete,
      debugLogPath: this.getDebugLogPath() ?? null
    })

    return {
      assets: allAssets,
      profile: this.shellProfile,
      recognized,
      complete,
      debugLogPath: this.getDebugLogPath()
    }
  }

  /**
   * Close connection
   */
  close(): void {
    this.clearDataSettleTimer()
    if (this.isConnected) {
      if (this.stream) {
        this.stream.end()
        this.stream = null
      }
      if (this.conn) {
        this.conn.end()
      }
      this.isConnected = false
      console.log('Connection closed')
    }
  }
}

export default JumpServerClient

import {
  hasPasswordPrompt,
  hasPasswordError,
  hasRetryablePasswordError,
  detectDirectConnectionReason,
  hasMingyuInitialMenuPrompt,
  //resolveMingyuShellProfile,
  hasMingyuMenuReturn,
  getMingyuListCommand,
  hasUsernamePrompt,
  hasNoAssetsPrompt,
  createNoAssetsError,
  getMingyuAuthenticationTargetMismatch,
  createAuthenticationTargetMismatchError
} from './navigator'
import { hasUserSelectionPrompt, resolveMingyuTargetSelection, normalizeMingyuLoginUser, MINGYU_ENTER_SELECTION_COMMAND } from './parser'
import { OutputParser } from './executor'
import { mingyuConnections, mingyuExecStreams, deleteExecStreamPromise, getExecStreamPromise, setExecStreamPromise } from './state'
import { MINGYU_CONSTANTS, type MingyuNavigationPath } from './constants'

const MAX_TARGET_PASSWORD_RETRY_COUNT = 1

const prioritizeCommands = (preferredCommand: string | undefined, commands: string[]): string[] => {
  if (!preferredCommand) {
    return commands
  }

  return [preferredCommand, ...commands.filter((command) => command !== preferredCommand)]
}

const hasTargetUsernameValue = (navigationPath: MingyuNavigationPath): boolean => {
  return typeof navigationPath.targetUsername === 'string' && navigationPath.targetUsername.trim().length > 0
}

const hasTargetPasswordValue = (navigationPath: MingyuNavigationPath): boolean => {
  return typeof navigationPath.targetPassword === 'string' && navigationPath.targetPassword.length > 0
}

const writeNavigationCommand = (stream: any, command: string) => {
  // Use \n for :ssh commands to avoid \r being interpreted as carriage return (which moves cursor to line start without executing)
  // For other commands and __ENTER__, use \r as before
  if (command.startsWith(':ssh ')) {
    stream.write(command + '\n')
  } else {
    const actualWrite = command === MINGYU_ENTER_SELECTION_COMMAND ? '\r' : command + '\r'
    stream.write(actualWrite)
  }
}

export async function navigateToMingyuAsset(
  stream: any,
  targetIp: string,
  navigationPath: MingyuNavigationPath,
  jumpserverUuid: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputBuffer = ''
    let connectionPhase: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected' = 'connecting'
    let connectionEstablished = false
    let mingyuListRequested = false
    let mingyuSelectionCommands: string[] = []
    let mingyuSelectionCommandIndex = 0
    let mingyuLastSelectionCommand: string | null = null
    let targetPasswordRetryCount = 0
    let noProgressTimer: NodeJS.Timeout | null = null

    const clearNoProgressWatchdog = () => {
      if (noProgressTimer) {
        clearTimeout(noProgressTimer)
        noProgressTimer = null
      }
    }

    const cleanup = () => {
      clearNoProgressWatchdog()
      stream.removeListener('data', dataHandler)
      stream.removeListener('error', errorHandler)
      stream.removeListener('close', closeHandler)
    }

    const continueMingyuSelectionAfterStall = (context: string) => {
      if (connectionEstablished) {
        return
      }

      if (connectionPhase !== 'selectTarget') {
        return
      }

      if (sendNextMingyuSelectionCommand(`${context}:no-progress-fallback`)) {
        return
      }

      cleanup()
      reject(new Error(`Mingyu exec stream: Mingyu target selection made no progress after ${mingyuLastSelectionCommand || 'no command'}`))
    }

    const rejectOnAuthenticationTargetMismatch = (): boolean => {
      const mismatch = getMingyuAuthenticationTargetMismatch(outputBuffer, targetIp)
      if (!mismatch) {
        return false
      }

      cleanup()
      reject(createAuthenticationTargetMismatchError(mismatch))
      return true
    }

    const armNoProgressWatchdog = (context: string) => {
      clearNoProgressWatchdog()
      noProgressTimer = setTimeout(() => {
        console.log(`Mingyu exec stream: Mingyu selection stalled after ${mingyuLastSelectionCommand || 'no command'}, trying fallback`)
        continueMingyuSelectionAfterStall(context)
      }, MINGYU_CONSTANTS.DATA_SETTLE_DELAY + 2000)
    }

    const shouldTreatChunkAsSelectionProgress = (chunk: string): boolean => {
      if (connectionPhase !== 'selectTarget') {
        return chunk.length > 0
      }

      const trimmedChunk = chunk.trim()
      if (!trimmedChunk) {
        return false
      }

      return (
        hasUsernamePrompt(outputBuffer) ||
        hasPasswordPrompt(outputBuffer) ||
        hasUserSelectionPrompt(outputBuffer) ||
        hasNoAssetsPrompt(outputBuffer) ||
        hasMingyuMenuReturn(outputBuffer) ||
        Boolean(detectDirectConnectionReason(outputBuffer))
      )
    }

    const handleNavigationSuccess = (reason: string) => {
      if (connectionEstablished) return
      connectionEstablished = true
      console.log(`Mingyu exec stream navigation successful (${jumpserverUuid}): ${reason}`)
      connectionPhase = 'connected'
      targetPasswordRetryCount = 0
      outputBuffer = ''
      cleanup()
      resolve()
    }

    const sendNextMingyuSelectionCommand = (context: string): boolean => {
      if (mingyuSelectionCommandIndex >= mingyuSelectionCommands.length) {
        return false
      }

      const command = mingyuSelectionCommands[mingyuSelectionCommandIndex++]
      mingyuLastSelectionCommand = command
      navigationPath.mingyuSelectionCommand = command
      outputBuffer = ''
      console.log(`Mingyu exec stream: Mingyu selecting target (${context}) with ${command}`)
      writeNavigationCommand(stream, command)
      armNoProgressWatchdog(`write:${command === MINGYU_ENTER_SELECTION_COMMAND ? '<enter>' : command}`)
      return true
    }

    const tryProgressMingyuSelection = (context: string): boolean => {
      const selectionResult = resolveMingyuTargetSelection(outputBuffer, {
        targetIp,
        targetHostname: navigationPath.targetHostname,
        targetAsset: navigationPath.targetAsset
      })

      if (mingyuSelectionCommands.length === 0) {
        if (selectionResult.status === 'matched') {
          navigationPath.mingyuSelector = selectionResult.match.entry.selector
          const detectedLoginUser = normalizeMingyuLoginUser(selectionResult.match.entry.loginUser)
          if (!hasTargetUsernameValue(navigationPath) && detectedLoginUser) {
            navigationPath.targetUsername = detectedLoginUser
          }
          mingyuSelectionCommands = prioritizeCommands(navigationPath.mingyuSelectionCommand, selectionResult.match.selectionCommands)
          mingyuSelectionCommandIndex = 0
          return sendNextMingyuSelectionCommand(context)
        }

        if (selectionResult.entries.length > 0) {
          cleanup()
          reject(
            new Error(
              selectionResult.status === 'ambiguous'
                ? `Mingyu exec stream: Mingyu target selection is ambiguous for ${targetIp}`
                : `Mingyu exec stream: Mingyu target asset not found in current GateShell list for ${targetIp}`
            )
          )
          return true
        }

        if (!mingyuListRequested && hasMingyuInitialMenuPrompt(outputBuffer)) {
          mingyuListRequested = true
          outputBuffer = ''
          const listCommand = getMingyuListCommand()
          console.log(`Mingyu exec stream: Mingyu menu detected without visible list, requesting assets via ${listCommand}`)
          stream.write(listCommand + '\r')
          return true
        }

        return false
      }

      if (hasMingyuMenuReturn(outputBuffer)) {
        if (sendNextMingyuSelectionCommand(`${context}:retry`)) {
          return true
        }

        cleanup()
        reject(new Error(`Mingyu exec stream: Mingyu target selection returned to GateShell menu (${mingyuLastSelectionCommand || 'no command'})`))
        return true
      }

      return false
    }

    const dataHandler = (data: Buffer) => {
      const ansiRegex = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nry=><]/g
      const chunk = data.toString().replace(ansiRegex, '')
      outputBuffer += chunk
      //navigationPath.profile = resolveMingyuShellProfile(outputBuffer, navigationPath.profile ?? 'standard')

      if (shouldTreatChunkAsSelectionProgress(chunk)) {
        clearNoProgressWatchdog()
      }

      if (connectionPhase === 'connecting' && hasMingyuInitialMenuPrompt(outputBuffer)) {
        console.log('Mingyu exec stream: Mingyu menu detected, preparing target selection')
        connectionPhase = 'selectTarget'
        tryProgressMingyuSelection('initial-menu')
        return
      }

      if (connectionPhase === 'inputIp') {
        if (hasNoAssetsPrompt(outputBuffer)) {
          cleanup()
          reject(createNoAssetsError())
          return
        }

        if (hasUserSelectionPrompt(outputBuffer)) {
          if (navigationPath.selectedUserId !== undefined) {
            console.log(`Mingyu exec stream: User selection prompt detected, auto-selecting userId=${navigationPath.selectedUserId}`)
            connectionPhase = 'selectUser'
            outputBuffer = ''
            writeNavigationCommand(stream, navigationPath.selectedUserId.toString())
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Multiple user scenario detected but selectedUserId not provided'))
          }
          return
        }

        if (hasUsernamePrompt(outputBuffer)) {
          if (!hasTargetUsernameValue(navigationPath)) {
            cleanup()
            reject(new Error('Mingyu exec stream: Target username prompt detected but targetUsername not recorded'))
            return
          }
          connectionPhase = 'inputUsername'
          outputBuffer = ''
          writeNavigationCommand(stream, navigationPath.targetUsername!)
          return
        }

        if (hasPasswordPrompt(outputBuffer)) {
          if (rejectOnAuthenticationTargetMismatch()) {
            return
          }

          if (hasTargetPasswordValue(navigationPath)) {
            console.log('Mingyu exec stream: Password prompt detected, using saved target password')
            connectionPhase = 'inputPassword'
            targetPasswordRetryCount = 0
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.targetPassword + '\r')
            }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Target password prompt detected but targetPassword not recorded'))
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`No password required - ${reason}`)
        }
        return
      }

      if (connectionPhase === 'selectTarget') {
        if (hasNoAssetsPrompt(outputBuffer)) {
          cleanup()
          reject(createNoAssetsError())
          return
        }

        if (hasUserSelectionPrompt(outputBuffer)) {
          if (navigationPath.selectedUserId !== undefined) {
            console.log(
              `Mingyu exec stream: User selection prompt detected after Mingyu selection, auto-selecting userId=${navigationPath.selectedUserId}`
            )
            connectionPhase = 'selectUser'
            outputBuffer = ''
            writeNavigationCommand(stream, navigationPath.selectedUserId.toString())
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Multiple user scenario detected but selectedUserId not provided'))
          }
          return
        }

        if (hasUsernamePrompt(outputBuffer)) {
          if (!hasTargetUsernameValue(navigationPath)) {
            cleanup()
            reject(new Error('Mingyu exec stream: Target username prompt detected after Mingyu selection but targetUsername not recorded'))
            return
          }
          connectionPhase = 'inputUsername'
          outputBuffer = ''
          writeNavigationCommand(stream, navigationPath.targetUsername!)
          return
        }

        if (hasPasswordPrompt(outputBuffer)) {
          if (rejectOnAuthenticationTargetMismatch()) {
            return
          }

          if (hasTargetPasswordValue(navigationPath)) {
            console.log('Mingyu exec stream: Password prompt detected after Mingyu selection, using saved target password')
            connectionPhase = 'inputPassword'
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.targetPassword + '\r')
            }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Target password prompt detected after Mingyu selection but targetPassword not recorded'))
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`Mingyu target selection - ${reason}`)
          return
        }

        tryProgressMingyuSelection('select-target')
        return
      }

      if (connectionPhase === 'selectUser') {
        if (hasUsernamePrompt(outputBuffer)) {
          if (!hasTargetUsernameValue(navigationPath)) {
            cleanup()
            reject(new Error('Mingyu exec stream: Target username prompt detected after user selection but targetUsername not recorded'))
            return
          }
          connectionPhase = 'inputUsername'
          outputBuffer = ''
          writeNavigationCommand(stream, navigationPath.targetUsername!)
          return
        }

        if (hasPasswordPrompt(outputBuffer)) {
          if (rejectOnAuthenticationTargetMismatch()) {
            return
          }

          if (hasTargetPasswordValue(navigationPath)) {
            console.log('Mingyu exec stream: Password prompt detected after user selection, using saved target password')
            connectionPhase = 'inputPassword'
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.targetPassword + '\r')
            }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Target password prompt detected after user selection but targetPassword not recorded'))
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`After user selection - ${reason}`)
          return
        }
        tryProgressMingyuSelection('user-selection')
        // if (navigationPath.profile === 'mingyu') {
        //   tryProgressMingyuSelection('user-selection')
        // }
        return
      }

      if (connectionPhase === 'inputUsername') {
        if (hasPasswordPrompt(outputBuffer)) {
          if (rejectOnAuthenticationTargetMismatch()) {
            return
          }

          if (hasTargetPasswordValue(navigationPath)) {
            connectionPhase = 'inputPassword'
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.targetPassword + '\r')
            }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            cleanup()
            reject(new Error('Mingyu exec stream: Target password prompt detected after username input but targetPassword not recorded'))
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`After username input - ${reason}`)
          return
        }

        if (hasMingyuMenuReturn(outputBuffer)) {
          cleanup()
          reject(new Error('Mingyu exec stream: Mingyu target selection returned to GateShell menu after username input'))
        }
        return
      }

      if (connectionPhase === 'inputPassword') {
        if (hasRetryablePasswordError(outputBuffer)) {
          cleanup()
          reject(new Error('Mingyu exec stream: Password rejected and fresh input is required'))
          return
        }

        if (hasPasswordError(outputBuffer)) {
          cleanup()
          reject(new Error('Mingyu exec stream: Password authentication failed'))
          return
        }

        if (hasPasswordPrompt(outputBuffer)) {
          if (rejectOnAuthenticationTargetMismatch()) {
            return
          }

          if (!hasTargetPasswordValue(navigationPath)) {
            cleanup()
            reject(new Error('Mingyu exec stream: Target password retry prompt detected but targetPassword not recorded'))
            return
          }

          if (targetPasswordRetryCount >= MAX_TARGET_PASSWORD_RETRY_COUNT) {
            cleanup()
            reject(new Error('Mingyu exec stream: Password authentication failed after password retry'))
            return
          }

          targetPasswordRetryCount += 1
          outputBuffer = ''
          setTimeout(() => {
            stream.write(navigationPath.targetPassword + '\r')
          }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`After password verification - ${reason}`)
          return
        }

        if (hasMingyuMenuReturn(outputBuffer)) {
          cleanup()
          reject(new Error('Mingyu exec stream: Mingyu target selection returned to GateShell menu after password input'))
        }
      }
    }

    const errorHandler = (error: Error) => {
      console.error('Mingyu exec stream navigation error:', error)
      cleanup()
      clearTimeout(timeout)
      reject(error)
    }

    const closeHandler = () => {
      console.log('Mingyu exec stream closed during navigation')
      cleanup()
      if (connectionPhase !== 'connected') {
        clearTimeout(timeout)
        reject(new Error(`Mingyu exec stream: Mingyu navigation closed before entering target host (phase: ${connectionPhase})`))
      }
    }

    stream.on('data', dataHandler)
    stream.on('error', errorHandler)
    stream.on('close', closeHandler)

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Mingyu exec stream navigation timeout'))
    }, MINGYU_CONSTANTS.NAVIGATION_TIMEOUT)
    const clearNavigationTimeout = () => clearTimeout(timeout)

    const originalResolve = resolve
    resolve = (value?: any) => {
      clearNavigationTimeout()
      originalResolve(value)
    }

    const originalReject = reject
    reject = (reason?: any) => {
      clearNavigationTimeout()
      originalReject(reason)
    }
  })
}

export async function createMingyuExecStream(connectionId: string): Promise<any> {
  if (mingyuExecStreams.has(connectionId)) {
    console.log(`[Mingyu:ExecStream] Reusing existing stream: ${connectionId}`)
    return mingyuExecStreams.get(connectionId)
  }

  const existingPromise = getExecStreamPromise(connectionId)
  if (existingPromise) {
    console.log(`[Mingyu:ExecStream] Waiting for stream being created: ${connectionId}`)
    return existingPromise
  }

  console.log(`[Mingyu:ExecStream] Starting to create new stream: ${connectionId}`)

  const creationPromise = (async () => {
    try {
      const connData = mingyuConnections.get(connectionId)
      if (!connData) {
        console.error(`[Mingyu:ExecStream] Connection data not found!`)
        console.error(`[Mingyu:ExecStream] Available connection ID list:`, Array.from(mingyuConnections.keys()))
        throw new Error(`Mingyu connection not found: ${connectionId}`)
      }

      const { conn, mingyuUuid, targetIp, navigationPath } = connData

      if (!targetIp) {
        console.error(`[Mingyu:ExecStream] Target asset information missing: targetIp=${targetIp}`)
        throw new Error(`Mingyu unable to get target asset information: ${connectionId}`)
      }

      if (!navigationPath) {
        console.error(`[Mingyu] Navigation path not recorded`)
        throw new Error(`Mingyu connection missing navigation path: ${connectionId}`)
      }

      if (!mingyuUuid) {
        console.error(`[Mingyu] Mingyu UUID not recorded`)
        throw new Error(`Mingyu connection missing jumpserverUuid: ${connectionId}`)
      }

      const execStream: any = await new Promise((resolve, reject) => {
        conn.shell({ term: 'xterm-256color' }, (err: Error | undefined, stream: any) => {
          if (err) {
            console.error(`[Mingyu] Exec stream creation failed:`, err)
            reject(err)
          } else {
            resolve(stream)
          }
        })
      })

      await navigateToMingyuAsset(execStream, targetIp, navigationPath, mingyuUuid)

      mingyuExecStreams.set(connectionId, execStream)

      execStream.on('close', () => {
        mingyuExecStreams.delete(connectionId)
        deleteExecStreamPromise(connectionId)
      })

      deleteExecStreamPromise(connectionId)
      return execStream
    } catch (error) {
      deleteExecStreamPromise(connectionId)
      throw error
    }
  })()

  setExecStreamPromise(connectionId, creationPromise)
  return creationPromise
}

export async function executeCommandOnMingyuExec(
  execStream: any,
  cmd: string
): Promise<{
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
}> {
  return new Promise((resolve) => {
    const { marker, exitCodeMarker } = OutputParser.generateMarkers()

    let outputBuffer = ''
    let timeoutHandle: NodeJS.Timeout
    let commandSent = false

    const dataHandler = (data: Buffer) => {
      if (!commandSent) return

      const chunk = data.toString()
      outputBuffer += chunk

      const hasMarker = outputBuffer.includes(marker)
      const hasExitCode = new RegExp(`${exitCodeMarker}\d+`).test(outputBuffer)

      if (hasMarker && hasExitCode) {
        setTimeout(() => {
          cleanup()

          try {
            const markerPattern = new RegExp(`[\r\n]${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\r\n]`)
            const markerMatch = outputBuffer.match(markerPattern)

            if (!markerMatch || markerMatch.index === undefined) {
              throw new Error('Marker not found or format incorrect')
            }

            const rawOutput = outputBuffer.substring(0, markerMatch.index + 1)
            const stdout = OutputParser.cleanCommandOutput(rawOutput)
            const exitCode = OutputParser.extractExitCode(outputBuffer, exitCodeMarker)

            resolve({
              success: exitCode === 0,
              stdout,
              stderr: '',
              exitCode
            })
          } catch (parseError) {
            console.error('[Mingyu] Command output parsing error:', parseError)
            resolve({
              success: false,
              error: `Failed to parse command output: ${parseError}`,
              stdout: outputBuffer,
              stderr: '',
              exitCode: undefined
            })
          }
        }, MINGYU_CONSTANTS.DATA_SETTLE_DELAY)
      }
    }

    const cleanup = () => {
      execStream.removeListener('data', dataHandler)
      clearTimeout(timeoutHandle)
    }

    timeoutHandle = setTimeout(() => {
      console.warn(`[Mingyu] Command execution timeout (${MINGYU_CONSTANTS.COMMAND_EXEC_TIMEOUT}ms)`)
      cleanup()
      resolve({
        success: false,
        error: 'Command execution timeout',
        stdout: outputBuffer,
        stderr: '',
        exitCode: undefined
      })
    }, MINGYU_CONSTANTS.COMMAND_EXEC_TIMEOUT)

    execStream.on('data', dataHandler)

    setTimeout(() => {
      commandSent = true
      execStream.write(`${cmd}\necho ${exitCodeMarker}$?\necho ${marker}\n`)
    }, MINGYU_CONSTANTS.DATA_SETTLE_DELAY)
  })
}

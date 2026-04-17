import { BrowserWindow } from 'electron'
import type { Client } from 'ssh2'
import type { MingyuConnectionInfo } from './types'
import { type MingyuNavigationPath } from './constants'
import {
  mingyuConnections,
  mingyuShellStreams,
  mingyuConnectionStatus,
  mingyuLastCommand,
  mingyuInputBuffer,
  mingyuUuidToConnectionId
} from './state'
import { createMingyuExecStream, executeCommandOnMingyuExec } from './streamManager'
import {
  hasUserSelectionPrompt,
  resolveMingyuTargetSelection,
  normalizeMingyuLoginUser,
  MINGYU_ENTER_SELECTION_COMMAND,
  buildMingyuArrowNavigationCommands,
  parseMingyuUsers
} from './parser'
import { handleMingyuUserSelectionWithEvent } from './userSelection'
import {
  hasUsernamePrompt,
  hasPasswordPrompt,
  hasPasswordError,
  hasRetryablePasswordError,
  detectDirectConnectionReason,
  hasNoAssetsPrompt,
  createNoAssetsError,
  hasMingyuInitialMenuPrompt,
  hasMingyuMenuReturn,
  getMingyuListCommand,
  getMingyuAuthenticationTargetMismatch,
  createAuthenticationTargetMismatchError
} from './navigator'
import { MINGYU_CONSTANTS } from './constants'
import { handleMingyuKeyboardInteractive } from './mfa'

const MAX_TARGET_PASSWORD_RETRY_COUNT = 1

const sendPasswordToStream = (
  password: string,
  navigationPath: MingyuNavigationPath,
  writePassword: (password: string, meta?: Record<string, unknown>) => void,
  context: string = ''
) => {
  const actualPassword = password || ''
  navigationPath.needsPassword = !!actualPassword
  navigationPath.targetPassword = actualPassword

  setTimeout(() => {
    console.log(`[Mingyu-plugin] Sending password${context ? ` (${context})` : ''}`)
    writePassword(actualPassword, { context })
  }, MINGYU_CONSTANTS.PASSWORD_INPUT_DELAY)
}

const normalizeInteractivePromptText = (prompt: string): string => {
  return prompt.replace(/[<>]/g, '').trim()
}

const hasTargetUsernameValue = (navigationPath: MingyuNavigationPath): boolean => {
  return typeof navigationPath.targetUsername === 'string' && navigationPath.targetUsername.trim().length > 0
}

const hasTargetPasswordValue = (navigationPath: MingyuNavigationPath): boolean => {
  return typeof navigationPath.targetPassword === 'string' && navigationPath.targetPassword.length > 0
}

const prioritizeCommands = (preferredCommand: string | undefined, commands: string[]): string[] => {
  if (!preferredCommand) {
    return commands
  }

  return [preferredCommand, ...commands.filter((command) => command !== preferredCommand)]
}

const sanitizeTranscriptChunk = (data: Buffer) => {
  const ansiRegex = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nry=><]/g
  return data.toString().replace(ansiRegex, '')
}

export const setupMingyuInteraction = (
  stream: any,
  connectionInfo: MingyuConnectionInfo,
  connectionId: string,
  mingyuUuid: string,
  conn: Client,
  event: Electron.IpcMainInvokeEvent | undefined,
  sendStatusUpdate: (
    message: string,
    type: 'info' | 'success' | 'warning' | 'error',
    messageKey?: string,
    messageParams?: Record<string, string | number>
  ) => void,
  resolve: (value: { status: string; message: string }) => void,
  reject: (reason: Error) => void
) => {
  console.log(`[Mingyu-plugin] setupMingyuInteraction called, connectionId: ${connectionId}`)
  let outputBuffer = ''
  let connectionPhase: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected' = 'connecting'
  console.log(`[Mingyu-plugin] setupMingyuInteraction: initial connectionPhase = ${connectionPhase}`)
  let connectionEstablished = false
  let connectionFailed = false
  let mingyuListRequested = false
  let mingyuSelectionCommands: string[] = []
  let mingyuSelectionCommandIndex = 0
  let mingyuLastSelectionCommand: string | null = null
  let targetUsernamePromptPending = false
  let targetPasswordPromptPending = false
  let targetPasswordRetryCount = 0
  let passwordRetryNeedsFreshInput = false
  let pendingProgressContext: string | null = null
  let noProgressTimer: NodeJS.Timeout | null = null

  const recordMingyuNavigationEvent = (_options: {
    event: string
    actor?: 'user' | 'system' | 'remote'
    phase?: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected' | 'closed'
    direction?: 'in' | 'out' | 'meta'
    text?: string
    bytes?: number
    redacted?: 'none' | 'password' | 'mfa' | 'prompt_detected'
    meta?: Record<string, unknown>
  }) => {
    // Mingyu-plugin does not use debug transcript - skip recording
    // This avoids type compatibility issues with jumpserver types
  }

  const setConnectionPhase = (
    nextPhase: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected',
    reason: string,
    meta?: Record<string, unknown>
  ) => {
    const previousPhase = connectionPhase
    connectionPhase = nextPhase
    console.log(`[Mingyu-plugin] setConnectionPhase: ${previousPhase} -> ${nextPhase}, reason: ${reason}`)
    recordMingyuNavigationEvent({
      event: 'phase_change',
      actor: 'system',
      phase: nextPhase,
      meta: {
        from: previousPhase,
        to: nextPhase,
        reason,
        ...meta
      }
    })
  }

  const clearNoProgressWatchdog = () => {
    if (noProgressTimer) {
      clearTimeout(noProgressTimer)
      noProgressTimer = null
    }
  }

  const armNoProgressWatchdog = (context: string, meta?: Record<string, unknown>) => {
    pendingProgressContext = context
    clearNoProgressWatchdog()
    noProgressTimer = setTimeout(() => {
      recordMingyuNavigationEvent({
        event: 'no_progress',
        actor: 'system',
        meta: {
          watchContext: context,
          outputPreview: outputBuffer.slice(-400),
          //profile: navigationPath.profile || 'unknown',
          mingyuCommand: navigationPath.mingyuSelectionCommand || '',
          selectedUserId: navigationPath.selectedUserId,
          ...meta,
          context: meta?.context ?? context
        }
      })
      continueMingyuSelectionAfterStall(String(meta?.context ?? context))
    }, MINGYU_CONSTANTS.DATA_SETTLE_DELAY + 2000)
  }

  const noteProgress = (reason: string, meta?: Record<string, unknown>) => {
    clearNoProgressWatchdog()
    if (pendingProgressContext) {
      recordMingyuNavigationEvent({
        event: 'progress',
        actor: 'system',
        meta: {
          watchContext: pendingProgressContext,
          reason,
          ...meta,
          context: meta?.context ?? pendingProgressContext
        }
      })
      pendingProgressContext = null
    }
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

  const continueMingyuSelectionAfterStall = (context: string) => {
    console.log(
      `[Mingyu-plugin] continueMingyuSelectionAfterStall called, context=${context}, connectionEstablished=${connectionEstablished}, connectionPhase=${connectionPhase}`
    )
    if (connectionEstablished || connectionFailed) {
      console.log(
        `[Mingyu-plugin] continueMingyuSelectionAfterStall: skipping due to connectionEstablished=${connectionEstablished} or connectionFailed=${connectionFailed}`
      )
      return
    }

    if (connectionPhase !== 'selectTarget') {
      console.log(`[Mingyu-plugin] continueMingyuSelectionAfterStall: skipping due to phase=${connectionPhase}`)
      return
    }

    if (sendNextMingyuSelectionCommand(`${context}:no-progress-fallback`)) {
      return
    }

    rejectAsFailure(new Error(`Mingyu target selection made no progress after ${mingyuLastSelectionCommand || 'no command'}`), false)
  }

  const writeNavigationCommand = (command: string, meta?: Record<string, unknown>) => {
    // Use \r for all Mingyu commands including :ssh, as the GateShell expects carriage return
    // to execute commands (not just move the cursor to a new line)
    const actualWrite = command === MINGYU_ENTER_SELECTION_COMMAND ? '\r' : command + '\r'
    recordMingyuNavigationEvent({
      event: 'write',
      actor: 'user',
      direction: 'out',
      text: command === MINGYU_ENTER_SELECTION_COMMAND ? '<enter>' : command,
      bytes: Buffer.byteLength(actualWrite, 'utf8'),
      meta: {
        ...meta,
        enterCommand: command === MINGYU_ENTER_SELECTION_COMMAND
      }
    })
    armNoProgressWatchdog(`write:${command === MINGYU_ENTER_SELECTION_COMMAND ? '<enter>' : command}`, meta)
    stream.write(actualWrite)
  }

  const writePassword = (password: string, meta?: Record<string, unknown>) => {
    recordMingyuNavigationEvent({
      event: 'write',
      actor: 'user',
      direction: 'out',
      text: '<redacted:password>',
      redacted: 'password',
      bytes: Buffer.byteLength(password + '\r', 'utf8'),
      meta: { ...meta, context: 'password' }
    })
    armNoProgressWatchdog('write:password', meta)
    stream.write(password + '\r')
  }

  const navigationPath: MingyuNavigationPath = {
    mingyuUuid,
    needsPassword: false,
    targetHostname: connectionInfo.targetHostname,
    targetAsset: connectionInfo.targetAsset,
    targetUsername: connectionInfo.targetUsername,
    targetPassword: connectionInfo.targetPassword
  }

  const requestKeyboardInteractiveValue = async (
    title: string,
    prompt: string,
    inputType: 'text' | 'password',
    validationMessage: string,
    failureMessage: string,
    transcriptContext: string
  ): Promise<string> => {
    if (!event) {
      throw new Error(`Mingyu ${transcriptContext} requires event object`)
    }

    const normalizedPrompt = normalizeInteractivePromptText(prompt)

    recordMingyuNavigationEvent({
      event: 'interactive_prompt',
      actor: 'remote',
      direction: 'in',
      redacted: 'prompt_detected',
      text: normalizedPrompt,
      meta: {
        title,
        inputType,
        context: transcriptContext //,
        //profile: navigationPath.profile || 'unknown'
      }
    })

    let responsePayload: unknown = null

    await handleMingyuKeyboardInteractive(
      event,
      connectionId,
      [{ prompt: normalizedPrompt }],
      (responses: unknown) => {
        responsePayload = responses
      },
      {
        onResponse: (responses: unknown) => {
          recordMingyuNavigationEvent({
            event: 'interactive_response',
            actor: 'user',
            direction: 'out',
            text: inputType === 'password' ? '<redacted:password>' : '<redacted:username>',
            redacted: inputType === 'password' ? 'password' : 'prompt_detected',
            meta: {
              inputType,
              context: transcriptContext,
              responseCount: Array.isArray(responses) ? responses.length : 0
            }
          })
        },
        onCancel: () => {
          recordMingyuNavigationEvent({
            event: 'interactive_cancel',
            actor: 'user',
            direction: 'out',
            meta: {
              inputType,
              context: transcriptContext
            }
          })
        }
      },
      {
        timeoutMs: 180000,
        cacheResponses: false,
        requestPayload: {
          title,
          inputType,
          validationMessage,
          failureMessage
        }
      }
    )

    const value = Array.isArray(responsePayload) ? responsePayload[0] : undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${title} is required`)
    }

    return value
  }

  const requestTargetUsername = async (context: string): Promise<string> => {
    const username = await requestKeyboardInteractiveValue(
      'Target Username',
      '<<USERNAME>>',
      'text',
      'Please input username',
      'Username is required',
      context
    )
    navigationPath.targetUsername = username
    return username
  }

  const requestTargetPassword = async (context: string): Promise<string> => {
    const password = await requestKeyboardInteractiveValue(
      'Target Password',
      '<<PASSWORD>>',
      'password',
      'Please input password',
      'Password is required',
      context
    )
    navigationPath.targetPassword = password
    navigationPath.needsPassword = true
    return password
  }

  const rejectOnAuthenticationTargetMismatch = (context: string): boolean => {
    const mismatch = getMingyuAuthenticationTargetMismatch(outputBuffer, connectionInfo.targetIp)
    if (!mismatch) {
      return false
    }

    recordMingyuNavigationEvent({
      event: 'authentication_target_mismatch',
      actor: 'system',
      direction: 'meta',
      meta: {
        context,
        expectedTargetIp: mismatch.expectedTargetIp,
        actualTargetIp: mismatch.targetIp,
        authenticationTarget: mismatch.authenticationTarget,
        authenticationSource: mismatch.source,
        //profile: navigationPath.profile || 'unknown',
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId,
        outputPreview: outputBuffer.slice(-400)
      }
    })

    rejectAsFailure(createAuthenticationTargetMismatchError(mismatch))
    return true
  }

  const endConnectionIfUnused = () => {
    const hasOtherSessions = Array.from(mingyuConnections.values()).some((item) => item.conn === conn)
    if (!hasOtherSessions) {
      conn.end()
    }
  }

  const rejectAsFailure = (error: Error, closeStream: boolean = true) => {
    if (connectionFailed) {
      return
    }

    connectionFailed = true
    clearNoProgressWatchdog()
    recordMingyuNavigationEvent({
      event: 'connect_failed',
      actor: 'system',
      phase: 'closed',
      meta: {
        message: error.message,
        closeStream,
        outputPreview: outputBuffer.slice(-400),
        //profile: navigationPath.profile || 'unknown',
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId
      }
    })
    outputBuffer = ''

    if (closeStream) {
      try {
        stream.end()
      } catch {
        // ignore stream close errors during failure cleanup
      }
    }

    endConnectionIfUnused()
    reject(error)
  }

  const sendNextMingyuSelectionCommand = (context: string): boolean => {
    if (mingyuSelectionCommandIndex >= mingyuSelectionCommands.length) {
      return false
    }

    const command = mingyuSelectionCommands[mingyuSelectionCommandIndex++]
    mingyuLastSelectionCommand = command
    navigationPath.mingyuSelectionCommand = command
    outputBuffer = ''

    console.log(`[Mingyu-plugin] Mingyu selecting target (${context}): ${command}`)
    writeNavigationCommand(command, {
      context,
      //profile: navigationPath.profile || 'unknown',
      selectedUserId: navigationPath.selectedUserId,
      commandIndex: mingyuSelectionCommandIndex,
      commandCount: mingyuSelectionCommands.length
    })
    return true
  }

  const tryProgressMingyuSelection = (context: string): boolean => {
    const selectionResult = resolveMingyuTargetSelection(outputBuffer, {
      targetIp: connectionInfo.targetIp,
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
        const errorMessage =
          selectionResult.status === 'ambiguous'
            ? `Mingyu target selection is ambiguous for ${connectionInfo.targetIp}`
            : `Mingyu target asset not found in current GateShell list for ${connectionInfo.targetIp}`
        rejectAsFailure(new Error(errorMessage))
        return true
      }

      if (!mingyuListRequested && hasMingyuInitialMenuPrompt(outputBuffer)) {
        mingyuListRequested = true
        outputBuffer = ''
        const listCommand = getMingyuListCommand()
        console.log(`[Mingyu-plugin] Mingyu menu detected without visible list, requesting assets via ${listCommand}`)
        writeNavigationCommand(listCommand, {
          context: 'mingyu-list-request'
        })
        return true
      }

      return false
    }

    if (hasMingyuMenuReturn(outputBuffer)) {
      if (sendNextMingyuSelectionCommand(`${context}:retry`)) {
        return true
      }

      rejectAsFailure(
        new Error(`Mingyu target selection returned to GateShell menu before entering target host (${mingyuLastSelectionCommand || 'no command'})`)
      )
      return true
    }

    return false
  }

  const requestAndSendTargetUsername = (context: string) => {
    sendStatusUpdate('Waiting for target username...', 'info')
    setConnectionPhase('inputUsername', 'target-username-prompt', {
      //profile: navigationPath.profile,
      context
    })
    outputBuffer = ''
    void requestTargetUsername(context)
      .then((username) => {
        targetUsernamePromptPending = false
        writeNavigationCommand(username, {
          context,
          promptType: 'username'
        })
      })
      .catch((error) => {
        rejectAsFailure(error as Error)
      })
  }

  const sendKnownTargetPassword = (context: string, options?: { preservePhase?: boolean; retry?: boolean }) => {
    sendStatusUpdate('Authenticating...', 'info', 'ssh.mingyu.authenticating')

    if (!options?.preservePhase) {
      setConnectionPhase('inputPassword', context, {
        //profile: navigationPath.profile,
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId
      })
    }

    if (options?.retry) {
      targetPasswordRetryCount += 1
      recordMingyuNavigationEvent({
        event: 'password_retry',
        actor: 'system',
        direction: 'meta',
        redacted: 'password',
        meta: {
          context,
          retryCount: targetPasswordRetryCount,
          //profile: navigationPath.profile,
          mingyuCommand: navigationPath.mingyuSelectionCommand || '',
          selectedUserId: navigationPath.selectedUserId,
          source: 'cached-password'
        }
      })
    } else {
      targetPasswordRetryCount = 0
    }

    passwordRetryNeedsFreshInput = false

    outputBuffer = ''
    sendPasswordToStream(navigationPath.targetPassword || '', navigationPath, writePassword, context)
  }

  const requestAndSendTargetPassword = (context: string, options?: { preserveRetryCount?: boolean; source?: 'fresh-input' | 'initial-input' }) => {
    sendStatusUpdate('Waiting for target password...', 'info')
    setConnectionPhase('inputPassword', 'target-password-prompt', {
      //profile: navigationPath.profile,
      context,
      mingyuCommand: navigationPath.mingyuSelectionCommand || '',
      selectedUserId: navigationPath.selectedUserId
    })
    if (!options?.preserveRetryCount) {
      targetPasswordRetryCount = 0
    }
    passwordRetryNeedsFreshInput = false
    outputBuffer = ''
    void requestTargetPassword(context)
      .then((password) => {
        targetPasswordPromptPending = false
        recordMingyuNavigationEvent({
          event: 'password_retry',
          actor: 'system',
          direction: 'meta',
          redacted: 'password',
          meta: {
            context,
            retryCount: targetPasswordRetryCount,
            //profile: navigationPath.profile,
            mingyuCommand: navigationPath.mingyuSelectionCommand || '',
            selectedUserId: navigationPath.selectedUserId,
            source: options?.source ?? 'initial-input'
          }
        })
        sendPasswordToStream(password, navigationPath, writePassword, context)
      })
      .catch((error) => {
        rejectAsFailure(error as Error)
      })
  }

  const markRetryablePasswordFailure = (context: string) => {
    passwordRetryNeedsFreshInput = true
    targetPasswordPromptPending = false
    outputBuffer = ''
    sendStatusUpdate('Password was rejected, waiting for another password prompt...', 'warning')
    recordMingyuNavigationEvent({
      event: 'password_retry_pending',
      actor: 'system',
      direction: 'meta',
      redacted: 'password',
      meta: {
        context,
        retryCount: targetPasswordRetryCount,
        //profile: navigationPath.profile,
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId
      }
    })
  }

  const requestFreshTargetPassword = (context: string) => {
    targetPasswordPromptPending = true
    requestAndSendTargetPassword(context, {
      preserveRetryCount: true,
      source: 'fresh-input'
    })
  }

  const retryKnownTargetPassword = (context: string): boolean => {
    if (!hasTargetPasswordValue(navigationPath)) {
      return false
    }

    if (targetPasswordRetryCount >= MAX_TARGET_PASSWORD_RETRY_COUNT) {
      rejectAsFailure(new Error('Mingyu password authentication failed after password retry, please check if password is correct'))
      return true
    }

    targetPasswordPromptPending = false
    sendKnownTargetPassword(context, {
      preservePhase: true,
      retry: true
    })
    return true
  }

  const handleUserSelectionPrompt = () => {
    console.log('[Mingyu-plugin] Multiple user prompt detected, user selection required')
    sendStatusUpdate('Multiple user accounts detected, please select...', 'info', 'ssh.mingyu.multipleUsersDetected')
    setConnectionPhase('selectUser', 'user-selection-prompt-detected')
    const users = parseMingyuUsers(outputBuffer)
    recordMingyuNavigationEvent({
      event: 'user_selection_prompt',
      actor: 'remote',
      direction: 'in',
      meta: {
        userCount: users.length,
        outputPreview: outputBuffer.slice(-400)
      }
    })
    console.log('[Mingyu-plugin] Parsed user list:', users)

    if (users.length === 0) {
      console.error('[Mingyu-plugin] Failed to parse user list, buffer content:', outputBuffer)
      rejectAsFailure(new Error('Failed to parse user list'))
      return true
    }

    outputBuffer = ''

    if (!event) {
      console.error('[Mingyu-plugin] User selection requires event object')
      rejectAsFailure(new Error('User selection requires event object'))
      return true
    }

    handleMingyuUserSelectionWithEvent(event, connectionId, users)
      .then((selectedUserId) => {
        console.log('[Mingyu-plugin] User selected account ID:', selectedUserId)
        sendStatusUpdate('Connecting with selected account...', 'info', 'ssh.mingyu.connectingWithSelectedAccount')
        setConnectionPhase('selectUser', 'user-selection-submitted', {
          selectedUserId,
          userCount: users.length
        })

        navigationPath.selectedUserId = selectedUserId

        writeNavigationCommand(selectedUserId.toString(), {
          context: 'user-selection',
          selectedUserId,
          userCount: users.length
        })
      })
      .catch((err) => {
        console.error('[Mingyu-plugin] User selection failed:', err)
        sendStatusUpdate('User selection cancelled', 'error', 'ssh.mingyu.userSelectionCanceled')
        rejectAsFailure(err as Error)
      })
    return true
  }

  const handleConnectionSuccess = (reason: string) => {
    if (connectionEstablished) return
    connectionEstablished = true
    clearNoProgressWatchdog()
    noteProgress('connection-success', { reason })
    sendStatusUpdate('Successfully connected to target server, you can start operating', 'success', 'ssh.mingyu.connectedToTarget')
    setConnectionPhase('connected', 'connection-established', { reason })
    recordMingyuNavigationEvent({
      event: 'connect_success',
      actor: 'system',
      phase: 'connected',
      meta: {
        reason,
        targetIp: connectionInfo.targetIp,
        //profile: navigationPath.profile || 'unknown',
        selectedUserId: navigationPath.selectedUserId,
        mingyuCommand: navigationPath.mingyuSelectionCommand || ''
      }
    })
    outputBuffer = ''

    console.log(`[Mingyu-plugin] Connection successful: ${connectionId} -> ${connectionInfo.targetIp} (${reason})`)
    mingyuConnections.set(connectionId, {
      conn,
      stream,
      mingyuUuid,
      targetIp: connectionInfo.targetIp,
      navigationPath
    })
    mingyuShellStreams.set(connectionId, stream)
    mingyuConnectionStatus.set(connectionId, { isVerified: true })

    createMingyuExecStream(connectionId)
      .then(async (execStream) => {
        const readyResult = {
          hasSudo: false,
          commandList: [] as string[]
        }

        try {
          const commandListResult = await executeCommandOnMingyuExec(
            execStream,
            'sh -c \'if command -v bash >/dev/null 2>&1; then bash -lc "compgen -A builtin; compgen -A command"; bash -ic "compgen -A alias" 2>/dev/null; else IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -x "$f" ] && printf "%s\\n" "${f##*/}"; done; done; fi\' | sort -u'
          ).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          const sudoCheckResult = await executeCommandOnMingyuExec(execStream, 'sudo -n true 2>/dev/null && echo true || echo false').then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          if (commandListResult.status === 'fulfilled' && commandListResult.value.success) {
            const stdout = commandListResult.value.stdout || ''
            readyResult.commandList = stdout.split('\n').filter(Boolean)

            if (readyResult.commandList.length === 0) {
              console.warn(`[Mingyu-plugin] Warning: Command list is empty`)
            }
          } else if (commandListResult.status === 'fulfilled') {
            console.error('[Mingyu-plugin] Failed to get command list:', commandListResult.value.error)
          }

          if (sudoCheckResult.status === 'fulfilled' && sudoCheckResult.value.success) {
            readyResult.hasSudo = (sudoCheckResult.value.stdout || '').trim() === 'true'
          }
        } catch (error) {
          console.error('[Mingyu-plugin] Error getting command list:', error)
        }

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, readyResult)
        }
      })
      .catch((error) => {
        console.error(`[Mingyu-plugin:ExecStream] Creation failed: ${connectionId}`, error)

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, {
            hasSudo: false,
            commandList: []
          })
          console.log(`[Mingyu-plugin:Connect] Sent empty command list to frontend (exec stream creation failed)`)
        } else {
          console.error('[Mingyu-plugin:Connect] Cannot send empty command list: window does not exist or is destroyed')
        }
      })

    resolve({ status: 'connected', message: 'Connection successful' })
  }

  stream.on('data', (data: Buffer) => {
    const chunk = sanitizeTranscriptChunk(data)
    outputBuffer += chunk

    // Debug: log received data and buffer state
    console.log(`[Mingyu-plugin] stream.on('data') chunk length=${chunk.length}, buffer length=${outputBuffer.length}, phase=${connectionPhase}`)
    if (chunk.includes('GateShell') || chunk.includes('[') || chunk.includes('Menu')) {
      console.log(`[Mingyu-plugin] DEBUG: chunk contains menu-related content: ${chunk.substring(0, 200).replace(/\r?\n/g, '\\n')}`)
    }

    //const previousProfile = navigationPath.profile ?? 'standard'
    //navigationPath.profile = resolveMingyuShellProfile(outputBuffer, previousProfile as 'standard' | 'mingyu')

    recordMingyuNavigationEvent({
      event: 'data',
      actor: 'remote',
      direction: 'in',
      text: chunk,
      bytes: data.length,
      meta: {
        //profile: navigationPath.profile,
        bufferLength: outputBuffer.length
      }
    })
    if (shouldTreatChunkAsSelectionProgress(chunk)) {
      noteProgress('stream-data', {
        chunkLength: chunk.length,
        //profile: navigationPath.profile,
        phase: connectionPhase
      })
    }

    if (connectionPhase === 'connecting' && hasMingyuInitialMenuPrompt(outputBuffer)) {
      console.log('[Mingyu-plugin] Menu detected, preparing target navigation')
      sendStatusUpdate('Connecting to target server...', 'info', 'ssh.mingyu.connectingToTarget')
      recordMingyuNavigationEvent({
        event: 'menu_detected',
        actor: 'system',
        meta: {
          //profile: navigationPath.profile,
          outputPreview: outputBuffer.slice(-400)
        }
      })

      //if (navigationPath.profile === 'mingyu') {
      // For mingyu bastion hosts, try to navigate to target using arrow keys first
      // Then let user manually operate the shell
      console.log('[Mingyu-plugin] Mingyu menu detected, trying to navigate to target')
      sendStatusUpdate('Mingyu menu detected. Navigating to target...', 'info', 'ssh.mingyu.navigatingToTarget')

      // Try to resolve target position and send arrow keys
      const selectionResult = resolveMingyuTargetSelection(outputBuffer, {
        targetIp: connectionInfo.targetIp,
        targetHostname: navigationPath.targetHostname,
        targetAsset: navigationPath.targetAsset
      })

      if (selectionResult.status === 'matched') {
        const targetLine = selectionResult.match.entry.id
        const arrowCommands = buildMingyuArrowNavigationCommands(targetLine)
        if (arrowCommands) {
          console.log(`[Mingyu-plugin] Mingyu navigating to line ${targetLine} with: ${arrowCommands}`)
          writeNavigationCommand(arrowCommands, {
            context: 'mingyu-arrow-navigation',
            //profile: 'mingyu',
            targetLine
          })
        }
      } else {
        // Unable to find exact match, send default navigation (jj = select first item)
        // This handles cases where menu parsing fails or target is ambiguous
        console.log(`[Mingyu-plugin] Target not found or ambiguous, sending default navigation 'jj'`)
        writeNavigationCommand('jj', {
          context: 'mingyu-default-navigation',
          //profile: 'mingyu',
          selectionStatus: selectionResult.status
        })
      }

      // For mingyu, we cannot detect when the target connection is fully established
      // because mingyu uses a different data channel for the target's output.
      // So we don't send connectedToTarget here - AI Chat will not auto-open for mingyu.
      // The user can manually open AI Chat after login is complete.
      mingyuConnections.set(connectionId, {
        conn,
        stream,
        mingyuUuid,
        targetIp: connectionInfo.targetIp,
        navigationPath
      })
      mingyuShellStreams.set(connectionId, stream)
      mingyuConnectionStatus.set(connectionId, { isVerified: true, source: 'mingyu', profile: 'mingyu' })
      // Update mapping for quick lookup by mingyuUuid (for AI CHAT reuse)
      mingyuUuidToConnectionId.set(mingyuUuid, connectionId)
      // Mark connection as established to prevent watchdog from sending more commands
      connectionEstablished = true
      // Clear watchdog timer before resolving
      clearNoProgressWatchdog()
      // Mark phase as connected to prevent re-entry on subsequent data events
      setConnectionPhase('connected', 'mingyu-early-exit', { reason: 'Mingyu shell ready' })
      // Resolve the promise to signal connection is ready
      resolve({ status: 'connected', message: 'Mingyu shell ready for manual operation' })
      return
      //}

      // setConnectionPhase('inputIp', 'standard-menu-detected', {
      //   profile: navigationPath.profile
      // })
      // outputBuffer = ''
      // writeNavigationCommand(connectionInfo.targetIp, {
      //   context: 'target-ip-input',
      //   targetIp: connectionInfo.targetIp,
      //   profile: navigationPath.profile
      // })
      // return
    }

    if (connectionPhase === 'inputIp') {
      if (hasNoAssetsPrompt(outputBuffer)) {
        console.log(`[Mingyu-plugin] Asset not found for target IP: ${connectionInfo.targetIp}`)
        rejectAsFailure(createNoAssetsError())
        return
      }

      if (hasUserSelectionPrompt(outputBuffer)) {
        handleUserSelectionPrompt()
        return
      }

      if (hasUsernamePrompt(outputBuffer)) {
        if (hasTargetUsernameValue(navigationPath)) {
          setConnectionPhase('inputUsername', 'username-prompt-after-ip', {
            //profile: navigationPath.profile
          })
          outputBuffer = ''
          writeNavigationCommand(navigationPath.targetUsername!, {
            context: 'after-ip-username',
            promptType: 'username'
          })
        } else if (!targetUsernamePromptPending) {
          targetUsernamePromptPending = true
          requestAndSendTargetUsername('after-ip-username')
        }
        return
      }

      if (hasPasswordPrompt(outputBuffer)) {
        if (rejectOnAuthenticationTargetMismatch('password-prompt-after-ip')) {
          return
        }

        if (hasTargetPasswordValue(navigationPath)) {
          targetPasswordPromptPending = false
          sendKnownTargetPassword('password-prompt-after-ip')
        } else if (!targetPasswordPromptPending) {
          targetPasswordPromptPending = true
          requestAndSendTargetPassword('password-prompt-after-ip')
        }
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        console.log(`[Mingyu-plugin] Target asset requires no password, establishing direct connection (${reason})`)
        handleConnectionSuccess(`No password required - ${reason}`)
      } else {
        const preview = outputBuffer.slice(-200).replace(/\r?\n/g, '\\n')
        console.log(`[Mingyu-plugin] inputIp phase output preview: "${preview}"`)
      }
      return
    }

    if (connectionPhase === 'selectTarget') {
      if (hasNoAssetsPrompt(outputBuffer)) {
        rejectAsFailure(createNoAssetsError())
        return
      }

      if (hasUserSelectionPrompt(outputBuffer)) {
        handleUserSelectionPrompt()
        return
      }

      if (hasUsernamePrompt(outputBuffer)) {
        if (hasTargetUsernameValue(navigationPath)) {
          setConnectionPhase('inputUsername', 'username-prompt-after-target-selection', {
            //profile: navigationPath.profile,
            mingyuCommand: navigationPath.mingyuSelectionCommand || ''
          })
          outputBuffer = ''
          writeNavigationCommand(navigationPath.targetUsername!, {
            context: 'after-mingyu-selection-username',
            promptType: 'username'
          })
        } else if (!targetUsernamePromptPending) {
          targetUsernamePromptPending = true
          requestAndSendTargetUsername('after-mingyu-selection-username')
        }
        return
      }

      if (hasPasswordPrompt(outputBuffer)) {
        if (rejectOnAuthenticationTargetMismatch('password-prompt-after-target-selection')) {
          return
        }

        if (hasTargetPasswordValue(navigationPath)) {
          targetPasswordPromptPending = false
          sendKnownTargetPassword('password-prompt-after-target-selection')
        } else if (!targetPasswordPromptPending) {
          targetPasswordPromptPending = true
          requestAndSendTargetPassword('password-prompt-after-target-selection')
        }
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        handleConnectionSuccess(`Mingyu target selection - ${reason}`)
        return
      }

      //if (navigationPath.profile === 'mingyu') {
      tryProgressMingyuSelection('select-target')
      //}
      return
    }

    if (connectionPhase === 'selectUser') {
      if (hasUsernamePrompt(outputBuffer)) {
        if (hasTargetUsernameValue(navigationPath)) {
          setConnectionPhase('inputUsername', 'username-prompt-after-user-selection', {
            //profile: navigationPath.profile,
            selectedUserId: navigationPath.selectedUserId
          })
          outputBuffer = ''
          writeNavigationCommand(navigationPath.targetUsername!, {
            context: 'after-user-selection-username',
            promptType: 'username',
            selectedUserId: navigationPath.selectedUserId
          })
        } else if (!targetUsernamePromptPending) {
          targetUsernamePromptPending = true
          requestAndSendTargetUsername('after-user-selection-username')
        }
        return
      }

      if (hasPasswordPrompt(outputBuffer)) {
        if (rejectOnAuthenticationTargetMismatch('password-prompt-after-user-selection')) {
          return
        }

        if (hasTargetPasswordValue(navigationPath)) {
          targetPasswordPromptPending = false
          sendKnownTargetPassword('password-prompt-after-user-selection')
        } else if (!targetPasswordPromptPending) {
          targetPasswordPromptPending = true
          requestAndSendTargetPassword('password-prompt-after-user-selection')
        }
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        console.log(`[Mingyu-plugin] Established direct connection after user selection (${reason})`)
        handleConnectionSuccess(`User selection - ${reason}`)
      }

      //if (navigationPath.profile === 'mingyu') {
      tryProgressMingyuSelection('user-selection')
      //}
      return
    }

    if (connectionPhase === 'inputUsername') {
      targetUsernamePromptPending = false

      if (hasPasswordPrompt(outputBuffer)) {
        if (rejectOnAuthenticationTargetMismatch('password-prompt-after-username')) {
          return
        }

        if (hasTargetPasswordValue(navigationPath)) {
          targetPasswordPromptPending = false
          sendKnownTargetPassword('password-prompt-after-username')
        } else if (!targetPasswordPromptPending) {
          targetPasswordPromptPending = true
          requestAndSendTargetPassword('password-prompt-after-username')
        }
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        handleConnectionSuccess(`After username input - ${reason}`)
        return
      }

      if (hasMingyuMenuReturn(outputBuffer)) {
        rejectAsFailure(new Error('Mingyu target selection returned to GateShell menu after username input'))
      }
      return
    }

    if (connectionPhase === 'inputPassword') {
      targetPasswordPromptPending = false

      if (hasRetryablePasswordError(outputBuffer)) {
        markRetryablePasswordFailure('password-rejected-awaiting-next-prompt')
        return
      }

      if (hasPasswordError(outputBuffer)) {
        console.log('[Mingyu-plugin] Password authentication failed')

        if (event) {
          event.sender.send('ssh:keyboard-interactive-result', {
            id: connectionId,
            status: 'failed'
          })
        }

        rejectAsFailure(new Error('Mingyu password authentication failed, please check if password is correct'))
        return
      }

      if (hasPasswordPrompt(outputBuffer)) {
        const retryContext = passwordRetryNeedsFreshInput ? 'password-prompt-after-retryable-failure' : 'password-prompt-retry-after-password'

        if (rejectOnAuthenticationTargetMismatch(retryContext)) {
          return
        }

        if (passwordRetryNeedsFreshInput) {
          if (!targetPasswordPromptPending) {
            requestFreshTargetPassword(retryContext)
          }
          return
        }

        if (retryKnownTargetPassword(retryContext)) {
          return
        }

        if (!targetPasswordPromptPending) {
          targetPasswordPromptPending = true
          requestAndSendTargetPassword(retryContext)
        }
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        console.log(`[Mingyu-plugin] Successfully entered target server after password verification (${reason})`)
        handleConnectionSuccess(`After password verification - ${reason}`)
        return
      }

      if (hasMingyuMenuReturn(outputBuffer)) {
        rejectAsFailure(new Error('Mingyu target selection returned to GateShell menu after password input'))
      }
    }
  })

  stream.stderr.on('data', (data: Buffer) => {
    const text = sanitizeTranscriptChunk(data)
    recordMingyuNavigationEvent({
      event: 'stderr',
      actor: 'remote',
      direction: 'in',
      text,
      bytes: data.length,
      meta: {}
    })
    noteProgress('stream-stderr', {
      chunkLength: text.length,
      phase: connectionPhase
    })
    console.error('[Mingyu-plugin] stderr:', data.toString())
  })

  stream.on('close', () => {
    clearNoProgressWatchdog()
    recordMingyuNavigationEvent({
      event: 'session_close',
      actor: 'system',
      phase: 'closed',
      meta: {
        connectionEstablished,
        connectionFailed,
        previousPhase: connectionPhase,
        selectedUserId: navigationPath.selectedUserId,
        mingyuCommand: navigationPath.mingyuSelectionCommand || ''
      }
    })
    console.log(`[Mingyu-plugin] Stream closed for connection ${connectionId}`)

    const connData = mingyuConnections.get(connectionId)
    if (connData) {
      const connToClose = connData.conn

      let isConnStillInUse = false
      for (const [otherId, otherData] of mingyuConnections.entries()) {
        if (otherId !== connectionId && otherData.conn === connToClose) {
          isConnStillInUse = true
          break
        }
      }

      if (!isConnStillInUse) {
        console.log(`[Mingyu-plugin] All sessions closed, releasing underlying connection: ${connectionId}`)
        connToClose.end()
      } else {
        console.log(`[Mingyu-plugin] Session closed, but underlying connection still in use by other sessions: ${connectionId}`)
      }
    }

    mingyuShellStreams.delete(connectionId)
    mingyuConnections.delete(connectionId)
    mingyuConnectionStatus.delete(connectionId)
    mingyuLastCommand.delete(connectionId)
    mingyuInputBuffer.delete(connectionId)
    mingyuUuidToConnectionId.delete(mingyuUuid)

    if (connectionPhase !== 'connected' && !connectionFailed) {
      const closeError = new Error(`Mingyu target connection closed before entering target host (phase: ${connectionPhase})`)
      rejectAsFailure(closeError, false)
    }
  })

  stream.on('error', (error: Error) => {
    clearNoProgressWatchdog()
    recordMingyuNavigationEvent({
      event: 'stream_error',
      actor: 'system',
      phase: 'closed',
      meta: {
        message: error.message,
        previousPhase: connectionPhase
      }
    })
    console.error('[Mingyu-plugin] Stream error:', error)
    rejectAsFailure(error, false)
  })
}

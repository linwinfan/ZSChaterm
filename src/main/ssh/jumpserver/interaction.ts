import { BrowserWindow } from 'electron'
import type { Client } from 'ssh2'
import type { JumpServerConnectionInfo, JumpServerNavigationPath } from './constants'
import {
  jumpserverConnections,
  jumpserverShellStreams,
  jumpserverConnectionStatus,
  jumpserverLastCommand,
  jumpserverInputBuffer,
  jumpserverUuidToConnectionId
} from './state'
import { createJumpServerExecStream, executeCommandOnJumpServerExec } from './streamManager'
import {
  parseJumpServerUsers,
  hasUserSelectionPrompt,
  resolveMingyuTargetSelection,
  normalizeMingyuLoginUser,
  MINGYU_ENTER_SELECTION_COMMAND,
  buildMingyuArrowNavigationCommands
} from './parser'
import { handleJumpServerUserSelectionWithEvent } from './userSelection'
import {
  hasUsernamePrompt,
  hasPasswordPrompt,
  hasPasswordError,
  hasRetryablePasswordError,
  detectDirectConnectionReason,
  hasNoAssetsPrompt,
  createNoAssetsError,
  hasJumpServerInitialMenuPrompt,
  resolveJumpServerShellProfile,
  hasJumpServerMenuReturn,
  getJumpServerListCommand,
  getJumpServerAuthenticationTargetMismatch,
  createAuthenticationTargetMismatchError
} from './navigator'
import { JUMPSERVER_CONSTANTS } from './constants'
import { handleJumpServerKeyboardInteractive } from './mfa'
import { attachSensitiveInputDiagnostics, recordDebugTranscriptEvent } from '../debugTranscript'

const MAX_TARGET_PASSWORD_RETRY_COUNT = 1

const sendPasswordToStream = (
  password: string,
  navigationPath: JumpServerNavigationPath,
  writePassword: (password: string, meta?: Record<string, unknown>) => void,
  context: string = ''
) => {
  const actualPassword = password || ''
  navigationPath.needsPassword = !!actualPassword
  navigationPath.targetPassword = actualPassword

  setTimeout(() => {
    console.log(`[JumpServer] Sending password${context ? ` (${context})` : ''}`)
    writePassword(actualPassword, { context })
  }, JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
}

const normalizeInteractivePromptText = (prompt: string): string => {
  return prompt.replace(/[<>]/g, '').trim()
}

const hasTargetUsernameValue = (navigationPath: JumpServerNavigationPath): boolean => {
  return typeof navigationPath.targetUsername === 'string' && navigationPath.targetUsername.trim().length > 0
}

const hasTargetPasswordValue = (navigationPath: JumpServerNavigationPath): boolean => {
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

export const setupJumpServerInteraction = (
  stream: any,
  connectionInfo: JumpServerConnectionInfo,
  connectionId: string,
  jumpserverUuid: string,
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
  let outputBuffer = ''
  let connectionPhase: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected' = 'connecting'
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

  const recordJumpServerNavigationEvent = (options: {
    event: string
    actor?: 'user' | 'system' | 'remote'
    phase?: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected' | 'closed'
    direction?: 'in' | 'out' | 'meta'
    text?: string
    bytes?: number
    redacted?: 'none' | 'password' | 'mfa' | 'prompt_detected'
    meta?: Record<string, unknown>
  }) => {
    recordDebugTranscriptEvent({
      rootSessionId: connectionId,
      transport: 'jumpserver',
      source: 'jumpserver-navigation',
      actor: options.actor ?? 'system',
      event: options.event,
      phase: options.phase ?? connectionPhase,
      direction: options.direction,
      text: options.text,
      bytes: options.bytes,
      redacted: options.redacted,
      meta: options.meta
    })
  }

  const setConnectionPhase = (
    nextPhase: 'connecting' | 'inputIp' | 'selectTarget' | 'selectUser' | 'inputUsername' | 'inputPassword' | 'connected',
    reason: string,
    meta?: Record<string, unknown>
  ) => {
    const previousPhase = connectionPhase
    connectionPhase = nextPhase
    recordJumpServerNavigationEvent({
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
      recordJumpServerNavigationEvent({
        event: 'no_progress',
        actor: 'system',
        meta: {
          watchContext: context,
          outputPreview: outputBuffer.slice(-400),
          profile: navigationPath.profile || 'unknown',
          mingyuCommand: navigationPath.mingyuSelectionCommand || '',
          selectedUserId: navigationPath.selectedUserId,
          ...meta,
          context: meta?.context ?? context
        }
      })
      continueMingyuSelectionAfterStall(String(meta?.context ?? context))
    }, JUMPSERVER_CONSTANTS.DATA_SETTLE_DELAY + 2000)
  }

  const noteProgress = (reason: string, meta?: Record<string, unknown>) => {
    clearNoProgressWatchdog()
    if (pendingProgressContext) {
      recordJumpServerNavigationEvent({
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
    if (connectionPhase !== 'selectTarget' || navigationPath.profile !== 'mingyu') {
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
      hasJumpServerMenuReturn(outputBuffer, 'mingyu') ||
      Boolean(detectDirectConnectionReason(outputBuffer))
    )
  }

  const continueMingyuSelectionAfterStall = (context: string) => {
    if (connectionEstablished || connectionFailed) {
      return
    }

    if (connectionPhase !== 'selectTarget' || navigationPath.profile !== 'mingyu') {
      return
    }

    if (sendNextMingyuSelectionCommand(`${context}:no-progress-fallback`)) {
      return
    }

    rejectAsFailure(new Error(`Mingyu target selection made no progress after ${mingyuLastSelectionCommand || 'no command'}`), false)
  }

  const writeNavigationCommand = (command: string, meta?: Record<string, unknown>) => {
    // Use \r for all JumpServer commands including :ssh, as the GateShell expects carriage return
    // to execute commands (not just move the cursor to a new line)
    const actualWrite = command === MINGYU_ENTER_SELECTION_COMMAND ? '\r' : command + '\r'
    recordJumpServerNavigationEvent({
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
    const metaWithPasswordDiagnostics = attachSensitiveInputDiagnostics(connectionId, meta, 'passwordDiagnostics', password)
    recordJumpServerNavigationEvent({
      event: 'write',
      actor: 'user',
      direction: 'out',
      text: '<redacted:password>',
      redacted: 'password',
      bytes: Buffer.byteLength(password + '\r', 'utf8'),
      meta: metaWithPasswordDiagnostics
    })
    armNoProgressWatchdog('write:password', metaWithPasswordDiagnostics)
    stream.write(password + '\r')
  }

  const navigationPath: JumpServerNavigationPath = {
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
      throw new Error(`JumpServer ${transcriptContext} requires event object`)
    }

    const normalizedPrompt = normalizeInteractivePromptText(prompt)

    recordJumpServerNavigationEvent({
      event: 'interactive_prompt',
      actor: 'remote',
      direction: 'in',
      redacted: 'prompt_detected',
      text: normalizedPrompt,
      meta: {
        title,
        inputType,
        context: transcriptContext,
        profile: navigationPath.profile || 'unknown'
      }
    })

    let responsePayload: unknown = null

    await handleJumpServerKeyboardInteractive(
      event,
      connectionId,
      [{ prompt: normalizedPrompt }],
      (responses: unknown) => {
        responsePayload = responses
      },
      {
        onResponse: (responses: unknown) => {
          const firstResponse = Array.isArray(responses) && typeof responses[0] === 'string' ? responses[0] : ''
          const responseMeta =
            inputType === 'password'
              ? attachSensitiveInputDiagnostics(
                  connectionId,
                  {
                    inputType,
                    context: transcriptContext,
                    responseCount: Array.isArray(responses) ? responses.length : 0
                  },
                  'passwordDiagnostics',
                  firstResponse
                )
              : {
                  inputType,
                  context: transcriptContext,
                  responseCount: Array.isArray(responses) ? responses.length : 0
                }

          recordJumpServerNavigationEvent({
            event: 'interactive_response',
            actor: 'user',
            direction: 'out',
            text: inputType === 'password' ? '<redacted:password>' : '<redacted:username>',
            redacted: inputType === 'password' ? 'password' : 'prompt_detected',
            meta: responseMeta
          })
        },
        onCancel: () => {
          recordJumpServerNavigationEvent({
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
    const mismatch = getJumpServerAuthenticationTargetMismatch(outputBuffer, connectionInfo.targetIp, navigationPath.profile)
    if (!mismatch) {
      return false
    }

    recordJumpServerNavigationEvent({
      event: 'authentication_target_mismatch',
      actor: 'system',
      direction: 'meta',
      meta: {
        context,
        expectedTargetIp: mismatch.expectedTargetIp,
        actualTargetIp: mismatch.targetIp,
        authenticationTarget: mismatch.authenticationTarget,
        authenticationSource: mismatch.source,
        profile: navigationPath.profile || 'unknown',
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId,
        outputPreview: outputBuffer.slice(-400)
      }
    })

    rejectAsFailure(createAuthenticationTargetMismatchError(mismatch))
    return true
  }

  const endConnectionIfUnused = () => {
    const hasOtherSessions = Array.from(jumpserverConnections.values()).some((item) => item.conn === conn)
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
    recordJumpServerNavigationEvent({
      event: 'connect_failed',
      actor: 'system',
      phase: 'closed',
      meta: {
        message: error.message,
        closeStream,
        outputPreview: outputBuffer.slice(-400),
        profile: navigationPath.profile || 'unknown',
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

    console.log(`[JumpServer] Mingyu selecting target (${context}): ${command}`)
    writeNavigationCommand(command, {
      context,
      profile: navigationPath.profile || 'unknown',
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

      if (!mingyuListRequested && hasJumpServerInitialMenuPrompt(outputBuffer, 'mingyu')) {
        mingyuListRequested = true
        outputBuffer = ''
        const listCommand = getJumpServerListCommand('mingyu')
        console.log(`[JumpServer] Mingyu menu detected without visible list, requesting assets via ${listCommand}`)
        writeNavigationCommand(listCommand, {
          context: 'mingyu-list-request',
          profile: 'mingyu'
        })
        return true
      }

      return false
    }

    if (hasJumpServerMenuReturn(outputBuffer, 'mingyu')) {
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
      profile: navigationPath.profile,
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
    sendStatusUpdate('Authenticating...', 'info', 'ssh.jumpserver.authenticating')

    if (!options?.preservePhase) {
      setConnectionPhase('inputPassword', context, {
        profile: navigationPath.profile,
        mingyuCommand: navigationPath.mingyuSelectionCommand || '',
        selectedUserId: navigationPath.selectedUserId
      })
    }

    if (options?.retry) {
      targetPasswordRetryCount += 1
      recordJumpServerNavigationEvent({
        event: 'password_retry',
        actor: 'system',
        direction: 'meta',
        redacted: 'password',
        meta: {
          context,
          retryCount: targetPasswordRetryCount,
          profile: navigationPath.profile,
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
      profile: navigationPath.profile,
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
        recordJumpServerNavigationEvent({
          event: 'password_retry',
          actor: 'system',
          direction: 'meta',
          redacted: 'password',
          meta: {
            context,
            retryCount: targetPasswordRetryCount,
            profile: navigationPath.profile,
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
    recordJumpServerNavigationEvent({
      event: 'password_retry_pending',
      actor: 'system',
      direction: 'meta',
      redacted: 'password',
      meta: {
        context,
        retryCount: targetPasswordRetryCount,
        profile: navigationPath.profile,
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
      rejectAsFailure(new Error('JumpServer password authentication failed after password retry, please check if password is correct'))
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
    console.log('Multiple user prompt detected, user selection required')
    sendStatusUpdate('Multiple user accounts detected, please select...', 'info', 'ssh.jumpserver.multipleUsersDetected')
    setConnectionPhase('selectUser', 'user-selection-prompt-detected')
    const users = parseJumpServerUsers(outputBuffer)
    recordJumpServerNavigationEvent({
      event: 'user_selection_prompt',
      actor: 'remote',
      direction: 'in',
      meta: {
        userCount: users.length,
        outputPreview: outputBuffer.slice(-400)
      }
    })
    console.log('Parsed user list:', users)

    if (users.length === 0) {
      console.error('Failed to parse user list, buffer content:', outputBuffer)
      rejectAsFailure(new Error('Failed to parse user list'))
      return true
    }

    outputBuffer = ''

    if (!event) {
      console.error('JumpServer user selection requires event object')
      rejectAsFailure(new Error('User selection requires event object'))
      return true
    }

    handleJumpServerUserSelectionWithEvent(event, connectionId, users)
      .then((selectedUserId) => {
        console.log('User selected account ID:', selectedUserId)
        sendStatusUpdate('Connecting with selected account...', 'info', 'ssh.jumpserver.connectingWithSelectedAccount')
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
        console.error('User selection failed:', err)
        sendStatusUpdate('User selection cancelled', 'error', 'ssh.jumpserver.userSelectionCanceled')
        rejectAsFailure(err as Error)
      })
    return true
  }

  const handleConnectionSuccess = (reason: string) => {
    if (connectionEstablished) return
    connectionEstablished = true
    clearNoProgressWatchdog()
    noteProgress('connection-success', { reason })
    sendStatusUpdate('Successfully connected to target server, you can start operating', 'success', 'ssh.jumpserver.connectedToTarget')
    setConnectionPhase('connected', 'connection-established', { reason })
    recordJumpServerNavigationEvent({
      event: 'connect_success',
      actor: 'system',
      phase: 'connected',
      meta: {
        reason,
        targetIp: connectionInfo.targetIp,
        profile: navigationPath.profile || 'unknown',
        selectedUserId: navigationPath.selectedUserId,
        mingyuCommand: navigationPath.mingyuSelectionCommand || ''
      }
    })
    outputBuffer = ''

    console.log(`[JumpServer] Connection successful: ${connectionId} -> ${connectionInfo.targetIp} (${reason})`)
    jumpserverConnections.set(connectionId, {
      conn,
      stream,
      jumpserverUuid,
      targetIp: connectionInfo.targetIp,
      navigationPath
    })
    jumpserverShellStreams.set(connectionId, stream)
    jumpserverConnectionStatus.set(connectionId, { isVerified: true })

    createJumpServerExecStream(connectionId)
      .then(async (execStream) => {
        const readyResult = {
          hasSudo: false,
          commandList: [] as string[]
        }

        try {
          const commandListResult = await executeCommandOnJumpServerExec(
            execStream,
            'sh -c \'if command -v bash >/dev/null 2>&1; then bash -lc "compgen -A builtin; compgen -A command"; bash -ic "compgen -A alias" 2>/dev/null; else IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -x "$f" ] && printf "%s\\n" "${f##*/}"; done; done; fi\' | sort -u'
          ).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          const sudoCheckResult = await executeCommandOnJumpServerExec(execStream, 'sudo -n true 2>/dev/null && echo true || echo false').then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          if (commandListResult.status === 'fulfilled' && commandListResult.value.success) {
            const stdout = commandListResult.value.stdout || ''
            readyResult.commandList = stdout.split('\n').filter(Boolean)

            if (readyResult.commandList.length === 0) {
              console.warn(`[JumpServer] Warning: Command list is empty`)
            }
          } else if (commandListResult.status === 'fulfilled') {
            console.error('[JumpServer] Failed to get command list:', commandListResult.value.error)
          }

          if (sudoCheckResult.status === 'fulfilled' && sudoCheckResult.value.success) {
            readyResult.hasSudo = (sudoCheckResult.value.stdout || '').trim() === 'true'
          }
        } catch (error) {
          console.error('[JumpServer] Error getting command list:', error)
        }

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, readyResult)
        }
      })
      .catch((error) => {
        console.error(`[JumpServer:ExecStream] Creation failed: ${connectionId}`, error)

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, {
            hasSudo: false,
            commandList: []
          })
          console.log(`[JumpServer:Connect] Sent empty command list to frontend (exec stream creation failed)`)
        } else {
          console.error('[JumpServer:Connect] Cannot send empty command list: window does not exist or is destroyed')
        }
      })

    resolve({ status: 'connected', message: 'Connection successful' })
  }

  stream.on('data', (data: Buffer) => {
    const chunk = sanitizeTranscriptChunk(data)
    outputBuffer += chunk

    const previousProfile = navigationPath.profile ?? 'standard'
    navigationPath.profile = resolveJumpServerShellProfile(outputBuffer, previousProfile)

    recordJumpServerNavigationEvent({
      event: 'data',
      actor: 'remote',
      direction: 'in',
      text: chunk,
      bytes: data.length,
      meta: {
        profile: navigationPath.profile,
        bufferLength: outputBuffer.length
      }
    })
    if (shouldTreatChunkAsSelectionProgress(chunk)) {
      noteProgress('stream-data', {
        chunkLength: chunk.length,
        profile: navigationPath.profile,
        phase: connectionPhase
      })
    }

    if (connectionPhase === 'connecting' && hasJumpServerInitialMenuPrompt(outputBuffer, navigationPath.profile)) {
      console.log('JumpServer menu detected, preparing target navigation')
      sendStatusUpdate('Connecting to target server...', 'info', 'ssh.jumpserver.connectingToTarget')
      recordJumpServerNavigationEvent({
        event: 'menu_detected',
        actor: 'system',
        meta: {
          profile: navigationPath.profile,
          outputPreview: outputBuffer.slice(-400)
        }
      })

      if (navigationPath.profile === 'mingyu') {
        // For mingyu bastion hosts, try to navigate to target using arrow keys first
        // Then let user manually operate the shell
        console.log('JumpServer mingyu menu detected, trying to navigate to target')
        sendStatusUpdate('JumpServer mingyu menu detected. Navigating to target...', 'info', 'ssh.jumpserver.navigatingToTarget')

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
            console.log(`[JumpServer] Mingyu navigating to line ${targetLine} with: ${arrowCommands}`)
            writeNavigationCommand(arrowCommands, {
              context: 'mingyu-arrow-navigation',
              profile: 'mingyu',
              targetLine
            })
          }
        }

        // For mingyu, we cannot detect when the target connection is fully established
        // because mingyu uses a different data channel for the target's output.
        // So we don't send connectedToTarget here - AI Chat will not auto-open for mingyu.
        // The user can manually open AI Chat after login is complete.
        jumpserverConnections.set(connectionId, {
          conn,
          stream,
          jumpserverUuid,
          targetIp: connectionInfo.targetIp,
          navigationPath
        })
        jumpserverShellStreams.set(connectionId, stream)
        jumpserverConnectionStatus.set(connectionId, { isVerified: true, source: 'shared', profile: 'mingyu' })
        // Update mapping for quick lookup by jumpserverUuid (for AI CHAT reuse)
        jumpserverUuidToConnectionId.set(jumpserverUuid, connectionId)
        // Resolve the promise to signal connection is ready
        resolve({ status: 'connected', message: 'Mingyu shell ready for manual operation' })
        return
      }

      setConnectionPhase('inputIp', 'standard-menu-detected', {
        profile: navigationPath.profile
      })
      outputBuffer = ''
      writeNavigationCommand(connectionInfo.targetIp, {
        context: 'target-ip-input',
        targetIp: connectionInfo.targetIp,
        profile: navigationPath.profile
      })
      return
    }

    if (connectionPhase === 'inputIp') {
      if (hasNoAssetsPrompt(outputBuffer)) {
        console.log(`JumpServer asset not found for target IP: ${connectionInfo.targetIp}`)
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
            profile: navigationPath.profile
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
        console.log(`JumpServer target asset requires no password, establishing direct connection (${reason})`)
        handleConnectionSuccess(`No password required - ${reason}`)
      } else {
        const preview = outputBuffer.slice(-200).replace(/\r?\n/g, '\\n')
        console.log(`JumpServer inputIp phase output preview: "${preview}"`)
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
            profile: navigationPath.profile,
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

      if (navigationPath.profile === 'mingyu') {
        tryProgressMingyuSelection('select-target')
      }
      return
    }

    if (connectionPhase === 'selectUser') {
      if (hasUsernamePrompt(outputBuffer)) {
        if (hasTargetUsernameValue(navigationPath)) {
          setConnectionPhase('inputUsername', 'username-prompt-after-user-selection', {
            profile: navigationPath.profile,
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
        console.log(`JumpServer established direct connection after user selection (${reason})`)
        handleConnectionSuccess(`User selection - ${reason}`)
        return
      }

      if (navigationPath.profile === 'mingyu') {
        tryProgressMingyuSelection('user-selection')
      }
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

      if (navigationPath.profile === 'mingyu' && hasJumpServerMenuReturn(outputBuffer, 'mingyu')) {
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

      if (hasPasswordError(outputBuffer, navigationPath.profile)) {
        console.log('JumpServer password authentication failed')

        if (event) {
          event.sender.send('ssh:keyboard-interactive-result', {
            id: connectionId,
            status: 'failed'
          })
        }

        rejectAsFailure(new Error('JumpServer password authentication failed, please check if password is correct'))
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
        console.log(`JumpServer successfully entered target server after password verification (${reason})`)
        handleConnectionSuccess(`After password verification - ${reason}`)
        return
      }

      if (navigationPath.profile === 'mingyu' && hasJumpServerMenuReturn(outputBuffer, 'mingyu')) {
        rejectAsFailure(new Error('Mingyu target selection returned to GateShell menu after password input'))
      }
    }
  })

  stream.stderr.on('data', (data: Buffer) => {
    const text = sanitizeTranscriptChunk(data)
    recordJumpServerNavigationEvent({
      event: 'stderr',
      actor: 'remote',
      direction: 'in',
      text,
      bytes: data.length,
      meta: {
        profile: navigationPath.profile || 'unknown'
      }
    })
    noteProgress('stream-stderr', {
      chunkLength: text.length,
      phase: connectionPhase
    })
    console.error('JumpServer stderr:', data.toString())
  })

  stream.on('close', () => {
    clearNoProgressWatchdog()
    recordJumpServerNavigationEvent({
      event: 'session_close',
      actor: 'system',
      phase: 'closed',
      meta: {
        connectionEstablished,
        connectionFailed,
        previousPhase: connectionPhase,
        profile: navigationPath.profile || 'unknown',
        selectedUserId: navigationPath.selectedUserId,
        mingyuCommand: navigationPath.mingyuSelectionCommand || ''
      }
    })
    console.log(`JumpServer stream closed for connection ${connectionId}`)

    const connData = jumpserverConnections.get(connectionId)
    if (connData) {
      const connToClose = connData.conn

      let isConnStillInUse = false
      for (const [otherId, otherData] of jumpserverConnections.entries()) {
        if (otherId !== connectionId && otherData.conn === connToClose) {
          isConnStillInUse = true
          break
        }
      }

      if (!isConnStillInUse) {
        console.log(`[Bastion Host] All sessions closed, releasing underlying connection: ${connectionId}`)
        connToClose.end()
      } else {
        console.log(`[Bastion Host] Session closed, but underlying connection still in use by other sessions: ${connectionId}`)
      }
    }

    jumpserverShellStreams.delete(connectionId)
    jumpserverConnections.delete(connectionId)
    jumpserverConnectionStatus.delete(connectionId)
    jumpserverLastCommand.delete(connectionId)
    jumpserverInputBuffer.delete(connectionId)
    jumpserverUuidToConnectionId.delete(jumpserverUuid)

    if (connectionPhase !== 'connected' && !connectionFailed) {
      const closeError =
        navigationPath.profile === 'mingyu'
          ? new Error(`Mingyu target connection closed before entering target host (phase: ${connectionPhase})`)
          : new Error('Connection closed before completion')
      rejectAsFailure(closeError, false)
    }
  })

  stream.on('error', (error: Error) => {
    clearNoProgressWatchdog()
    recordJumpServerNavigationEvent({
      event: 'stream_error',
      actor: 'system',
      phase: 'closed',
      meta: {
        message: error.message,
        profile: navigationPath.profile || 'unknown',
        previousPhase: connectionPhase
      }
    })
    console.error('JumpServer stream error:', error)
    rejectAsFailure(error, false)
  })
}

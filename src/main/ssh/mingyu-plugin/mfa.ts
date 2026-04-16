import { ipcMain } from 'electron'
import { keyboardInteractiveOpts } from '../sshHandle'

interface MingyuKeyboardInteractiveHooks {
  onPrompt?: (prompts: Array<{ prompt: string }>) => void
  onResponse?: (responses: unknown) => void
  onTimeout?: () => void
  onCancel?: () => void
}

interface MingyuKeyboardInteractiveOptions {
  timeoutMs?: number
  cacheResponses?: boolean
  requestPayload?: Record<string, unknown>
}

export const handleMingyuKeyboardInteractive = (
  event,
  id,
  prompts,
  finish,
  hooks: MingyuKeyboardInteractiveHooks = {},
  options: MingyuKeyboardInteractiveOptions = {}
) => {
  return new Promise<void>((resolve, reject) => {
    hooks.onPrompt?.(prompts)

    event.sender.send('ssh:keyboard-interactive-request', {
      id,
      prompts: prompts.map((p) => p.prompt),
      ...options.requestPayload
    })

    const timeoutId = setTimeout(() => {
      ipcMain.removeAllListeners(`ssh:keyboard-interactive-response:${id}`)
      ipcMain.removeAllListeners(`ssh:keyboard-interactive-cancel:${id}`)
      finish([])
      hooks.onTimeout?.()
      event.sender.send('ssh:keyboard-interactive-timeout', { id })
      reject(new Error('Two-factor authentication timeout'))
    }, options.timeoutMs ?? 30000)

    ipcMain.once(`ssh:keyboard-interactive-response:${id}`, (_evt, responses) => {
      clearTimeout(timeoutId)
      hooks.onResponse?.(responses)
      finish(responses)
      if (options.cacheResponses !== false) {
        keyboardInteractiveOpts.set(id, responses)
      }
      resolve()
    })

    ipcMain.once(`ssh:keyboard-interactive-cancel:${id}`, () => {
      clearTimeout(timeoutId)
      finish([])
      hooks.onCancel?.()
      reject(new Error('User cancelled two-factor authentication'))
    })
  })
}

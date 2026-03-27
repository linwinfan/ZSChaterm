import { randomUUID } from 'node:crypto'

type UserConfigIpcHandler = (event: { sender?: unknown }, payload: unknown) => void

type UserConfigPayloadLike = {
  requestId?: string
}

type UserConfigResponsePayload<TConfig> = {
  requestId: string
  config: TConfig
}

type UserConfigErrorPayload = {
  requestId: string
  message: string
}

export interface UserConfigIpcMainLike {
  on: (channel: string, handler: UserConfigIpcHandler) => void
  removeListener: (channel: string, handler: UserConfigIpcHandler) => void
}

export interface UserConfigWebContentsLike {
  send: (channel: string, payload: { requestId: string }) => void
  isLoadingMainFrame: () => boolean
  once: (eventName: 'did-finish-load', handler: () => void) => unknown
}

export interface RequestUserConfigFromRendererOptions {
  ipcMain: UserConfigIpcMainLike
  webContents: UserConfigWebContentsLike
  requestIdFactory?: () => string
  timeoutMs?: number
}

const USER_CONFIG_REQUEST_CHANNEL = 'userConfig:get'
const USER_CONFIG_RESPONSE_CHANNEL = 'userConfig:get-response'
const USER_CONFIG_ERROR_CHANNEL = 'userConfig:get-error'
const DEFAULT_TIMEOUT_MS = 30_000

function asUserConfigPayload(payload: unknown): UserConfigPayloadLike | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  return payload as UserConfigPayloadLike
}

function asUserConfigResponsePayload<TConfig>(payload: unknown): UserConfigResponsePayload<TConfig> | undefined {
  const currentPayload = asUserConfigPayload(payload)
  if (!currentPayload || typeof currentPayload.requestId !== 'string' || !('config' in currentPayload)) {
    return undefined
  }

  return payload as UserConfigResponsePayload<TConfig>
}

function asUserConfigErrorPayload(payload: unknown): UserConfigErrorPayload | undefined {
  const currentPayload = asUserConfigPayload(payload)
  if (!currentPayload || typeof currentPayload.requestId !== 'string' || !('message' in currentPayload)) {
    return undefined
  }

  return payload as UserConfigErrorPayload
}

function isMatchingRequest(requestId: string, payload?: UserConfigPayloadLike): boolean {
  return payload?.requestId === requestId
}

function isExpectedSender(event: { sender?: unknown }, webContents: UserConfigWebContentsLike): boolean {
  return !event.sender || event.sender === webContents
}

function toTimeoutError(): Error {
  return new Error('Timed out waiting for userConfig response')
}

function toErrorMessage(errorPayload: UserConfigErrorPayload): string {
  return typeof errorPayload.message === 'string' ? errorPayload.message : 'Failed to load userConfig'
}

function createUserConfigRequest<TConfig>(
  ipcMain: UserConfigIpcMainLike,
  webContents: UserConfigWebContentsLike,
  requestId: string,
  timeoutMs: number
): Promise<TConfig> {
  return new Promise<TConfig>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let isSettled = false
    let requestSent = false

    const finalize = (callback: () => void) => {
      if (isSettled) {
        return
      }

      isSettled = true

      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      ipcMain.removeListener(USER_CONFIG_RESPONSE_CHANNEL, responseHandler)
      ipcMain.removeListener(USER_CONFIG_ERROR_CHANNEL, errorHandler)
      callback()
    }

    const sendRequest = () => {
      if (isSettled || requestSent) {
        return
      }

      requestSent = true
      webContents.send(USER_CONFIG_REQUEST_CHANNEL, { requestId })
    }

    const responseHandler: UserConfigIpcHandler = (event, payload) => {
      const responsePayload = asUserConfigResponsePayload<TConfig>(payload)
      if (!responsePayload) {
        return
      }

      if (!isExpectedSender(event, webContents) || !isMatchingRequest(requestId, responsePayload)) {
        return
      }

      finalize(() => {
        resolve(responsePayload.config)
      })
    }

    const errorHandler: UserConfigIpcHandler = (event, payload) => {
      const errorPayload = asUserConfigErrorPayload(payload)
      if (!errorPayload) {
        return
      }

      if (!isExpectedSender(event, webContents) || !isMatchingRequest(requestId, errorPayload)) {
        return
      }

      finalize(() => {
        reject(new Error(toErrorMessage(errorPayload)))
      })
    }

    timeoutHandle = setTimeout(() => {
      finalize(() => {
        reject(toTimeoutError())
      })
    }, timeoutMs)

    ipcMain.on(USER_CONFIG_RESPONSE_CHANNEL, responseHandler)
    ipcMain.on(USER_CONFIG_ERROR_CHANNEL, errorHandler)

    if (webContents.isLoadingMainFrame()) {
      webContents.once('did-finish-load', sendRequest)
      return
    }

    sendRequest()
  })
}

export function requestUserConfigFromRenderer<TConfig = unknown>(options: RequestUserConfigFromRendererOptions): Promise<TConfig> {
  const { ipcMain, webContents, requestIdFactory = () => randomUUID(), timeoutMs = DEFAULT_TIMEOUT_MS } = options

  return createUserConfigRequest<TConfig>(ipcMain, webContents, requestIdFactory(), timeoutMs)
}

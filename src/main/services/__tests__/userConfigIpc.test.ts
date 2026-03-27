import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestUserConfigFromRenderer, type UserConfigIpcMainLike, type UserConfigWebContentsLike } from '../userConfigIpc'

type ChannelHandler = Parameters<UserConfigIpcMainLike['on']>[1]

type MockIpcMain = UserConfigIpcMainLike & {
  on: ReturnType<typeof vi.fn<UserConfigIpcMainLike['on']>>
  removeListener: ReturnType<typeof vi.fn<UserConfigIpcMainLike['removeListener']>>
  emit: (channel: string, payload: unknown) => void
  listenerCount: (channel: string) => number
}

type MockWebContents = UserConfigWebContentsLike & {
  send: ReturnType<typeof vi.fn<UserConfigWebContentsLike['send']>>
  isLoadingMainFrame: ReturnType<typeof vi.fn<UserConfigWebContentsLike['isLoadingMainFrame']>>
  once: ReturnType<typeof vi.fn<UserConfigWebContentsLike['once']>>
  emit: (eventName: string) => void
}

function createMockIpcMain(): MockIpcMain {
  const listeners = new Map<string, Set<ChannelHandler>>()

  return {
    on: vi.fn<UserConfigIpcMainLike['on']>((channel: string, handler: ChannelHandler) => {
      listeners.set(channel, (listeners.get(channel) ?? new Set()).add(handler))
    }),
    removeListener: vi.fn<UserConfigIpcMainLike['removeListener']>((channel: string, handler: ChannelHandler) => {
      listeners.get(channel)?.delete(handler)
      if (listeners.get(channel)?.size === 0) {
        listeners.delete(channel)
      }
    }),
    emit: (channel: string, payload: unknown) => {
      for (const handler of listeners.get(channel) ?? []) {
        handler({}, payload)
      }
    },
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0
  }
}

function createMockWebContents(options?: { loading?: boolean }): MockWebContents {
  const onceHandlers = new Map<string, () => void>()

  return {
    send: vi.fn<UserConfigWebContentsLike['send']>(),
    isLoadingMainFrame: vi.fn<UserConfigWebContentsLike['isLoadingMainFrame']>(() => options?.loading ?? false),
    once: vi.fn<UserConfigWebContentsLike['once']>((eventName: 'did-finish-load', handler: () => void) => {
      onceHandlers.set(eventName, handler)
    }),
    emit: (eventName: string) => {
      onceHandlers.get(eventName)?.()
      onceHandlers.delete(eventName)
    }
  }
}

describe('requestUserConfigFromRenderer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves only the matching requestId response', async () => {
    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents()
    const expectedConfig = { theme: 'dark' }

    const promise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => 'req-1',
      timeoutMs: 1000
    })

    expect(webContents.send).toHaveBeenCalledWith('userConfig:get', { requestId: 'req-1' })

    ipcMain.emit('userConfig:get-response', {
      requestId: 'other-request',
      config: { theme: 'light' }
    })
    ipcMain.emit('userConfig:get-response', {
      requestId: 'req-1',
      config: expectedConfig
    })

    await expect(promise).resolves.toEqual(expectedConfig)
    expect(ipcMain.listenerCount('userConfig:get-response')).toBe(0)
    expect(ipcMain.listenerCount('userConfig:get-error')).toBe(0)
  })

  it('rejects when renderer returns matching requestId error', async () => {
    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents()

    const promise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => 'req-2',
      timeoutMs: 1000
    })

    ipcMain.emit('userConfig:get-error', {
      requestId: 'req-2',
      message: 'load failed'
    })

    await expect(promise).rejects.toThrow('load failed')
    expect(ipcMain.listenerCount('userConfig:get-response')).toBe(0)
    expect(ipcMain.listenerCount('userConfig:get-error')).toBe(0)
  })

  it('rejects on timeout and cleans up listeners', async () => {
    vi.useFakeTimers()

    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents()
    const promise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => 'req-timeout',
      timeoutMs: 500
    })
    const timeoutExpectation = expect(promise).rejects.toThrow('Timed out waiting for userConfig response')

    await vi.advanceTimersByTimeAsync(500)

    await timeoutExpectation
    expect(ipcMain.listenerCount('userConfig:get-response')).toBe(0)
    expect(ipcMain.listenerCount('userConfig:get-error')).toBe(0)
  })

  it('keeps concurrent requests isolated when responses arrive out of order', async () => {
    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents()
    const requestIds = ['req-a', 'req-b']

    const firstPromise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => requestIds.shift()!,
      timeoutMs: 1000
    })
    const secondPromise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => requestIds.shift()!,
      timeoutMs: 1000
    })

    ipcMain.emit('userConfig:get-response', {
      requestId: 'req-b',
      config: { theme: 'second' }
    })
    ipcMain.emit('userConfig:get-response', {
      requestId: 'req-a',
      config: { theme: 'first' }
    })

    await expect(firstPromise).resolves.toEqual({ theme: 'first' })
    await expect(secondPromise).resolves.toEqual({ theme: 'second' })
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'userConfig:get', { requestId: 'req-a' })
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'userConfig:get', { requestId: 'req-b' })
  })

  it('waits for renderer load before sending request', async () => {
    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents({ loading: true })

    const promise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => 'req-load',
      timeoutMs: 1000
    })

    expect(webContents.send).not.toHaveBeenCalled()

    webContents.emit('did-finish-load')
    await Promise.resolve()

    expect(webContents.send).toHaveBeenCalledWith('userConfig:get', { requestId: 'req-load' })

    ipcMain.emit('userConfig:get-response', {
      requestId: 'req-load',
      config: { theme: 'loaded' }
    })

    await expect(promise).resolves.toEqual({ theme: 'loaded' })
  })

  it('rejects on timeout while waiting for renderer load without sending a late request', async () => {
    vi.useFakeTimers()

    const ipcMain = createMockIpcMain()
    const webContents = createMockWebContents({ loading: true })
    const promise = requestUserConfigFromRenderer({
      ipcMain,
      webContents,
      requestIdFactory: () => 'req-loading-timeout',
      timeoutMs: 500
    })
    const timeoutExpectation = expect(promise).rejects.toThrow('Timed out waiting for userConfig response')

    expect(webContents.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    await timeoutExpectation

    webContents.emit('did-finish-load')
    await Promise.resolve()

    expect(webContents.send).not.toHaveBeenCalled()
    expect(ipcMain.listenerCount('userConfig:get-response')).toBe(0)
    expect(ipcMain.listenerCount('userConfig:get-error')).toBe(0)
  })
})

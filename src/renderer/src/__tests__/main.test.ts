import { beforeEach, describe, expect, it, vi } from 'vitest'

type DeferredPromise = {
  promise: Promise<void>
  resolve: () => void
}

type IpcHandler = (...args: any[]) => any

type TestContext = {
  deferredUnlock?: DeferredPromise
  expectedStorageApi: Record<string, unknown>
  getConfigMock: ReturnType<typeof vi.fn>
  initializeStartupModelCheckMock: ReturnType<typeof vi.fn>
  notificationConfigMock: ReturnType<typeof vi.fn>
  piniaUseMock: ReturnType<typeof vi.fn>
  sendMock: ReturnType<typeof vi.fn>
  shortcutInitMock: ReturnType<typeof vi.fn>
  useMock: ReturnType<typeof vi.fn>
  waitForAppUnlockMock: ReturnType<typeof vi.fn>
  mountMock: ReturnType<typeof vi.fn>
  listeners: Record<string, IpcHandler[]>
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const createDeferredPromise = (): DeferredPromise => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return {
    promise,
    resolve
  }
}

const loadRendererMain = async (options?: {
  alreadyUnlocked?: boolean
  withDeferredUnlock?: boolean
  withElectron?: boolean
}): Promise<TestContext> => {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  document.title = ''

  const listeners: Record<string, IpcHandler[]> = {}
  const getConfigMock = vi.fn()
  const sendMock = vi.fn()
  const shortcutInitMock = vi.fn()
  const initializeStartupModelCheckMock = vi.fn()
  const notificationConfigMock = vi.fn()
  const piniaUseMock = vi.fn()
  const storageStateMock = {
    __esModule: true,
    mockedStorageState: true
  }
  const expectedStorageApi = {
    mockedStorageState: true
  }
  const deferredUnlock = options?.withDeferredUnlock ? createDeferredPromise() : undefined

  const waitForAppUnlockMock = vi.fn().mockImplementation(() => {
    if (deferredUnlock) {
      return deferredUnlock.promise
    }

    if (options?.alreadyUnlocked) {
      return Promise.resolve()
    }

    return Promise.resolve()
  })

  const useMock = vi.fn()
  const mountMock = vi.fn()
  const appInstance = {
    use: useMock,
    mount: mountMock
  }
  useMock.mockReturnValue(appInstance)
  ;(window as any).api = {}
  ;(window as any).electron =
    options?.withElectron === false
      ? undefined
      : {
          ipcRenderer: {
            on: vi.fn((channel: string, handler: IpcHandler) => {
              listeners[channel] ??= []
              listeners[channel].push(handler)
            }),
            send: sendMock
          }
        }

  vi.doMock('vue', () => ({
    createApp: vi.fn(() => appInstance)
  }))

  vi.doMock('pinia', () => ({
    createPinia: vi.fn(() => ({
      use: piniaUseMock
    }))
  }))

  vi.doMock('pinia-plugin-persistedstate', () => ({
    default: vi.fn()
  }))

  vi.doMock('ant-design-vue', () => ({
    notification: {
      config: notificationConfigMock
    }
  }))

  vi.doMock('../App.vue', () => ({
    default: {}
  }))

  vi.doMock('../router', () => ({
    default: { name: 'router-plugin' }
  }))

  vi.doMock('../locales', () => ({
    default: { name: 'i18n-plugin' }
  }))

  vi.doMock('../utils/edition', () => ({
    APP_EDITION: 'cn'
  }))

  vi.doMock('@/services/shortcutService', () => ({
    shortcutService: {
      init: shortcutInitMock
    }
  }))

  vi.doMock('@/services/llmStartupCheck', () => ({
    initializeStartupModelCheck: initializeStartupModelCheckMock
  }))

  vi.doMock('@/components/global/app-lock', () => ({
    waitForAppUnlock: waitForAppUnlockMock
  }))

  vi.doMock('@/services/userConfigStoreService', () => ({
    userConfigStore: {
      getConfig: getConfigMock
    }
  }))

  vi.doMock('@/agent/storage/state', () => storageStateMock)
  vi.doMock('@/utils/permission', () => ({
    getUserInfo: vi.fn()
  }))

  await import('../main')
  await flushPromises()

  return {
    deferredUnlock,
    expectedStorageApi,
    getConfigMock,
    initializeStartupModelCheckMock,
    notificationConfigMock,
    piniaUseMock,
    sendMock,
    shortcutInitMock,
    useMock,
    waitForAppUnlockMock,
    mountMock,
    listeners
  }
}

describe('renderer main entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should delay sensitive listener registration until unlock finishes', async () => {
    const context = await loadRendererMain({ withDeferredUnlock: true })

    expect(context.waitForAppUnlockMock).toHaveBeenCalledTimes(1)
    expect(context.listeners['userConfig:get']).toBeUndefined()
    expect(context.listeners['indexdb-migration:request-data']).toBeUndefined()
    expect(context.listeners['app:register-user-config-ipc']).toHaveLength(1)
    expect(context.listeners['app:register-indexdb-migration-listener']).toHaveLength(1)
    expect(context.notificationConfigMock).toHaveBeenCalledWith({ top: '30px' })
    expect(context.initializeStartupModelCheckMock).toHaveBeenCalledTimes(1)
    expect(context.piniaUseMock).toHaveBeenCalledTimes(1)
    expect(context.useMock).toHaveBeenCalledTimes(4)
    expect(context.mountMock).toHaveBeenCalledWith('#app')
    expect(window.storageAPI).toMatchObject({ mockedStorageState: true })
    expect(window.storageAPI).toMatchObject(context.expectedStorageApi)
    expect(document.title).toBe('Chaterm CN')
  })

  it('should enable post-unlock services after unlock resolves', async () => {
    const context = await loadRendererMain({ withDeferredUnlock: true })

    context.deferredUnlock?.resolve()
    await flushPromises()

    expect(context.listeners['userConfig:get']).toHaveLength(1)
    expect(context.listeners['indexdb-migration:request-data']).toHaveLength(1)
  })

  it('should register listeners only once when unlock signals repeat', async () => {
    const context = await loadRendererMain({ withDeferredUnlock: true })

    const registerUserConfig = context.listeners['app:register-user-config-ipc'][0]
    const registerIndexDbMigration = context.listeners['app:register-indexdb-migration-listener'][0]

    registerUserConfig()
    registerUserConfig()
    registerIndexDbMigration()
    registerIndexDbMigration()
    context.deferredUnlock?.resolve()
    await flushPromises()

    expect(context.listeners['userConfig:get']).toHaveLength(1)
    expect(context.listeners['indexdb-migration:request-data']).toHaveLength(1)
  })

  it('should auto-enable post-unlock services when renderer starts already unlocked', async () => {
    const context = await loadRendererMain({ alreadyUnlocked: true })

    expect(context.listeners['userConfig:get']).toHaveLength(1)
    expect(context.listeners['indexdb-migration:request-data']).toHaveLength(1)
  })

  it('should send userConfig response after registration', async () => {
    const context = await loadRendererMain({ alreadyUnlocked: true })
    const requestId = 'req-1'
    const config = { theme: 'dark' }
    context.getConfigMock.mockResolvedValue(config)

    await context.listeners['userConfig:get'][0]({}, { requestId })

    expect(context.getConfigMock).toHaveBeenCalledTimes(1)
    expect(context.sendMock).toHaveBeenCalledWith('userConfig:get-response', { requestId, config })
  })

  it('should send userConfig error when config loading fails', async () => {
    const context = await loadRendererMain({ alreadyUnlocked: true })
    const requestId = 'req-2'
    context.getConfigMock.mockRejectedValue(new Error('load failed'))

    await context.listeners['userConfig:get'][0]({}, { requestId })

    expect(context.sendMock).toHaveBeenCalledWith('userConfig:get-error', { requestId, message: 'load failed' })
  })
})

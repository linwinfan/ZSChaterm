import { beforeEach, describe, expect, it, vi } from 'vitest'

type EventHandler = (...args: any[]) => void

type MockBrowserWindow = {
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  isFullScreen: ReturnType<typeof vi.fn>
  setFullScreen: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  emit: (eventName: string, ...args: any[]) => void
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    emit: (eventName: string, ...args: any[]) => void
  }
}

const { browserWindowConstructorMock, browserWindowInstances, sessionDefaultSessionMock, shellOpenExternalMock, isDevMock, getEditionMock } =
  vi.hoisted(() => {
    const browserWindowInstances: MockBrowserWindow[] = []

    function createEventStore() {
      return new Map<string, EventHandler[]>()
    }

    function registerOn(eventStore: Map<string, EventHandler[]>, eventName: string, handler: EventHandler) {
      eventStore.set(eventName, [...(eventStore.get(eventName) ?? []), handler])
    }

    function registerOnce(instance: MockBrowserWindow, eventStore: Map<string, EventHandler[]>, eventName: string, handler: EventHandler) {
      const wrappedHandler: EventHandler = (...args: any[]) => {
        eventStore.set(
          eventName,
          (eventStore.get(eventName) ?? []).filter((currentHandler) => currentHandler !== wrappedHandler)
        )
        handler(...args)
      }

      registerOn(eventStore, eventName, wrappedHandler)
      return instance
    }

    function emit(eventStore: Map<string, EventHandler[]>, eventName: string, ...args: any[]) {
      for (const handler of eventStore.get(eventName) ?? []) {
        handler(...args)
      }
    }

    function createBrowserWindowInstance(): MockBrowserWindow {
      const windowEvents = createEventStore()
      const webContentsEvents = createEventStore()

      const instance = {
        show: vi.fn(),
        hide: vi.fn(),
        loadURL: vi.fn().mockResolvedValue(undefined),
        loadFile: vi.fn().mockResolvedValue(undefined),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => false),
        isFullScreen: vi.fn(() => false),
        setFullScreen: vi.fn(),
        isMaximized: vi.fn(() => false),
        unmaximize: vi.fn(),
        on: vi.fn((eventName: string, handler: EventHandler) => {
          registerOn(windowEvents, eventName, handler)
          return instance
        }),
        once: vi.fn((eventName: string, handler: EventHandler) => registerOnce(instance, windowEvents, eventName, handler)),
        emit: (eventName: string, ...args: any[]) => {
          emit(windowEvents, eventName, ...args)
        },
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn((eventName: string, handler: EventHandler) => {
            registerOn(webContentsEvents, eventName, handler)
          }),
          send: vi.fn(),
          getURL: vi.fn(() => 'http://localhost:5173'),
          emit: (eventName: string, ...args: any[]) => {
            emit(webContentsEvents, eventName, ...args)
          }
        }
      }

      return instance
    }

    return {
      browserWindowInstances,
      browserWindowConstructorMock: vi.fn(function BrowserWindowMock() {
        const instance = createBrowserWindowInstance()
        browserWindowInstances.push(instance)
        return instance
      }),
      sessionDefaultSessionMock: {
        webRequest: {
          onBeforeRequest: vi.fn()
        }
      },
      shellOpenExternalMock: vi.fn(),
      isDevMock: { dev: false },
      getEditionMock: vi.fn(() => 'cn')
    }
  })

vi.mock('electron', () => ({
  BrowserWindow: browserWindowConstructorMock,
  shell: {
    openExternal: shellOpenExternalMock
  },
  session: {
    defaultSession: sessionDefaultSessionMock
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isDevMock
}))

vi.mock('../../resources/icon.png?asset', () => ({
  default: 'mock-icon'
}))

vi.mock('./config/edition', () => ({
  getEdition: getEditionMock
}))

describe('createMainWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    browserWindowInstances.length = 0
    isDevMock.dev = false
    getEditionMock.mockReturnValue('cn')
    Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
  })

  it('registers a ready-to-show handler and keeps the window hidden until then', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]

    expect(browserWindowConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ show: false }))
    expect(createdWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function))
    expect(createdWindow.show).not.toHaveBeenCalled()
  })

  it('shows the window when ready-to-show fires', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]
    createdWindow.emit('ready-to-show')

    expect(createdWindow.show).toHaveBeenCalledTimes(1)
  })

  it('shows the window on did-finish-load fallback when ready-to-show did not fire', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]
    createdWindow.webContents.emit('did-finish-load')

    expect(createdWindow.show).toHaveBeenCalledTimes(1)
  })

  it('shows the window only once when ready-to-show and did-finish-load both fire', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]
    createdWindow.emit('ready-to-show')
    createdWindow.webContents.emit('did-finish-load')

    expect(createdWindow.show).toHaveBeenCalledTimes(1)
  })

  it('does not show again when the window is already visible', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]
    createdWindow.isVisible.mockReturnValue(true)

    createdWindow.emit('ready-to-show')
    createdWindow.webContents.emit('did-finish-load')

    expect(createdWindow.show).not.toHaveBeenCalled()
  })

  it('does not show a destroyed window', async () => {
    const { createMainWindow } = await import('./windowManager')

    await createMainWindow()

    const createdWindow = browserWindowInstances[0]
    createdWindow.isDestroyed.mockReturnValue(true)

    createdWindow.emit('ready-to-show')
    createdWindow.webContents.emit('did-finish-load')

    expect(createdWindow.show).not.toHaveBeenCalled()
  })
})

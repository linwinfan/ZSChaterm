import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApi = {
  getAppLockStatus: vi.fn(),
  setAppLockPassword: vi.fn(),
  verifyAppLockPassword: vi.fn(),
  lockApp: vi.fn()
}

global.window = {
  api: mockApi
} as any

import {
  hasAppLockPassword,
  initializeAppLock,
  isAppLockInitialized,
  isAppUnlocked,
  lockApp,
  resetAppLockState,
  setAppLockPassword,
  showAppLockDialog,
  verifyAppLockPassword,
  waitForAppUnlock
} from '../appLockState'

describe('appLockState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAppLockState()
  })

  it('should initialize from main process status', async () => {
    mockApi.getAppLockStatus.mockResolvedValue({
      hasPassword: true,
      isUnlocked: false
    })

    const status = await initializeAppLock()

    expect(mockApi.getAppLockStatus).toHaveBeenCalledTimes(1)
    expect(status).toEqual({ hasPassword: true, isUnlocked: false })
    expect(hasAppLockPassword.value).toBe(true)
    expect(isAppUnlocked.value).toBe(false)
    expect(isAppLockInitialized.value).toBe(true)
    expect(showAppLockDialog.value).toBe(true)
  })

  it('should reuse the same initialization promise while loading', async () => {
    let resolveStatus: ((value: { hasPassword: boolean; isUnlocked: boolean }) => void) | undefined
    mockApi.getAppLockStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      })
    )

    const firstPromise = initializeAppLock()
    const secondPromise = initializeAppLock()

    expect(mockApi.getAppLockStatus).toHaveBeenCalledTimes(1)

    resolveStatus?.({ hasPassword: true, isUnlocked: false })

    await expect(firstPromise).resolves.toEqual({ hasPassword: true, isUnlocked: false })
    await expect(secondPromise).resolves.toEqual({ hasPassword: true, isUnlocked: false })
  })

  it('should resolve waiters after unlock succeeds', async () => {
    mockApi.getAppLockStatus.mockResolvedValue({
      hasPassword: true,
      isUnlocked: false
    })
    mockApi.verifyAppLockPassword.mockResolvedValue({
      success: true,
      isUnlocked: true
    })

    const waitPromise = waitForAppUnlock()
    await Promise.resolve()

    await verifyAppLockPassword('secret-123')
    await expect(waitPromise).resolves.toBeUndefined()
    expect(showAppLockDialog.value).toBe(false)
    expect(isAppUnlocked.value).toBe(true)
  })

  it('should update state after setting password', async () => {
    mockApi.setAppLockPassword.mockResolvedValue({
      success: true,
      hasPassword: true,
      isUnlocked: true
    })

    const result = await setAppLockPassword('secret-123')

    expect(result).toEqual({ hasPassword: true, isUnlocked: true })
    expect(hasAppLockPassword.value).toBe(true)
    expect(isAppUnlocked.value).toBe(true)
    expect(showAppLockDialog.value).toBe(false)
  })

  it('should keep dialog open when password verification fails', async () => {
    mockApi.verifyAppLockPassword.mockResolvedValue({
      success: false,
      isUnlocked: false
    })

    const result = await verifyAppLockPassword('wrong-pass')

    expect(result).toEqual({ success: false, isUnlocked: false })
    expect(hasAppLockPassword.value).toBe(true)
    expect(isAppUnlocked.value).toBe(false)
    expect(showAppLockDialog.value).toBe(true)
  })

  it('should update state after locking app', async () => {
    mockApi.lockApp.mockResolvedValue({
      success: true,
      hasPassword: true,
      isUnlocked: false
    })

    const result = await lockApp()

    expect(result).toEqual({ hasPassword: true, isUnlocked: false })
    expect(hasAppLockPassword.value).toBe(true)
    expect(isAppUnlocked.value).toBe(false)
    expect(showAppLockDialog.value).toBe(true)
  })
})

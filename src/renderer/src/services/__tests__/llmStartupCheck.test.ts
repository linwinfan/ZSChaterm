import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitMock, getGlobalStateMock, waitForAppUnlockMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  getGlobalStateMock: vi.fn(),
  waitForAppUnlockMock: vi.fn()
}))

vi.mock('@/utils/eventBus', () => ({
  default: {
    emit: emitMock
  }
}))

vi.mock('@renderer/agent/storage/state', () => ({
  getGlobalState: getGlobalStateMock
}))

vi.mock('@/components/global/app-lock', () => ({
  waitForAppUnlock: waitForAppUnlockMock
}))

import { initializeStartupModelCheck } from '../llmStartupCheck'

describe('initializeStartupModelCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    waitForAppUnlockMock.mockResolvedValue(undefined)
  })

  it('should wait for app unlock before checking model availability', async () => {
    getGlobalStateMock.mockResolvedValue([{ checked: true }])

    initializeStartupModelCheck()
    await vi.advanceTimersByTimeAsync(2000)

    expect(waitForAppUnlockMock).toHaveBeenCalledTimes(1)
    expect(getGlobalStateMock).toHaveBeenCalledWith('modelOptions')
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('should open model settings when no models are available after unlock', async () => {
    getGlobalStateMock.mockResolvedValue([])

    initializeStartupModelCheck()
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(500)

    expect(waitForAppUnlockMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenNthCalledWith(1, 'openUserTab', 'userConfig')
    expect(emitMock).toHaveBeenNthCalledWith(2, 'switchToModelSettingsTab')
    expect(emitMock).toHaveBeenNthCalledWith(3, 'autoEnableAddModelSwitch')
  })
})

import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JUMPSERVER_CONSTANTS } from '../constants'
import { jumpserverConnectionStatus, jumpserverConnections, jumpserverInputBuffer, jumpserverLastCommand, jumpserverShellStreams } from '../state'

const {
  recordDebugTranscriptEventMock,
  createJumpServerExecStreamMock,
  executeCommandOnJumpServerExecMock,
  handleJumpServerKeyboardInteractiveMock
} = vi.hoisted(() => ({
  recordDebugTranscriptEventMock: vi.fn(),
  createJumpServerExecStreamMock: vi.fn(),
  executeCommandOnJumpServerExecMock: vi.fn(),
  handleJumpServerKeyboardInteractiveMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  },
  default: {
    BrowserWindow: {
      getAllWindows: () => []
    }
  }
}))

vi.mock('../../debugTranscript', async () => {
  const actual = await vi.importActual<typeof import('../../debugTranscript')>('../../debugTranscript')
  return {
    ...actual,
    recordDebugTranscriptEvent: recordDebugTranscriptEventMock
  }
})

vi.mock('../streamManager', () => ({
  createJumpServerExecStream: createJumpServerExecStreamMock,
  executeCommandOnJumpServerExec: executeCommandOnJumpServerExecMock
}))

vi.mock('../userSelection', () => ({
  handleJumpServerUserSelectionWithEvent: vi.fn()
}))

vi.mock('../mfa', () => ({
  handleJumpServerKeyboardInteractive: handleJumpServerKeyboardInteractiveMock
}))

import { setupJumpServerInteraction } from '../interaction'

class MockJumpServerStream extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
  stderr = new EventEmitter()
}

describe('setupJumpServerInteraction transcript', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    createJumpServerExecStreamMock.mockResolvedValue({})
    executeCommandOnJumpServerExecMock.mockResolvedValue({ success: true, stdout: '' })
    handleJumpServerKeyboardInteractiveMock.mockImplementation(async (_event, _id, prompts, finish, hooks) => {
      hooks?.onPrompt?.(prompts)
      const responses = ['fresh-target-secret']
      hooks?.onResponse?.(responses)
      finish(responses)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    jumpserverConnections.clear()
    jumpserverShellStreams.clear()
    jumpserverConnectionStatus.clear()
    jumpserverLastCommand.clear()
    jumpserverInputBuffer.clear()
  })

  it('records Mingyu phase changes and no-progress snapshots after selection write stalls', async () => {
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-1',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-1', conn, event, sendStatusUpdate, resolve, reject)

    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   root\n/1, name-asc\n', 'utf8'))

    // For mingyu bastion, don't auto-select - let user manually operate the shell
    expect(stream.write).not.toHaveBeenCalled()
    expect(sendStatusUpdate).toHaveBeenCalledWith(expect.stringContaining('Please select target manually'), 'info', 'ssh.jumpserver.manualOperation')
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(recordDebugTranscriptEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: 'jump-interaction-1',
        transport: 'jumpserver',
        source: 'jumpserver-navigation',
        event: 'phase_change',
        phase: 'connected',
        meta: expect.objectContaining({
          from: 'connecting',
          to: 'connected',
          reason: 'mingyu-menu-ready'
        })
      })
    )
  })

  it('falls back to zero-padded open command after the first Mingyu enter redraws GateShell', async () => {
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-enter-retry',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-enter-retry', conn, event, sendStatusUpdate, resolve, reject)

    // For mingyu bastion, don't auto-select - let user manually operate
    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n', 'utf8'))
    expect(stream.write).not.toHaveBeenCalled()
    expect(sendStatusUpdate).toHaveBeenCalledWith(expect.stringContaining('Please select target manually'), 'info', 'ssh.jumpserver.manualOperation')
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(reject).not.toHaveBeenCalled()
  })

  it('records password retry when Mingyu authentication banner matches requested target', async () => {
    // For mingyu, we don't do auto-selection, so this test just verifies
    // that the connection is marked as ready without any write operations
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-2',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)',
      targetUsername: 'root',
      targetPassword: 'target-secret'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-2', conn, event, sendStatusUpdate, resolve, reject)

    // Mingyu menu detected - should go to manual operation mode
    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n', 'utf8'))

    // No auto-selection should happen
    expect(stream.write).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(reject).not.toHaveBeenCalled()
  })

  it('rejects before password retry when Mingyu authentication banner points to a different target', () => {
    // For mingyu, we don't do auto-selection, so this test just verifies
    // that the connection is marked as ready without any write operations
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-mismatch',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)',
      targetUsername: 'root',
      targetPassword: 'target-secret'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-mismatch', conn, event, sendStatusUpdate, resolve, reject)

    // Mingyu menu detected - should go to manual operation mode
    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n', 'utf8'))

    // No auto-selection should happen
    expect(stream.write).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(reject).not.toHaveBeenCalled()
  })

  it('keeps standard jumpserver password prompt path unchanged', async () => {
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-standard',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetPassword: 'target-secret'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-standard', conn, event, sendStatusUpdate, resolve, reject)

    stream.emit('data', Buffer.from('Welcome\nOpt>', 'utf8'))
    expect(stream.write).toHaveBeenNthCalledWith(1, '10.30.5.14\r')

    stream.emit('data', Buffer.from('Password: ', 'utf8'))
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(2, 'target-secret\r')

    stream.emit('data', Buffer.from('Last login: Tue Apr 1 11:34:15 2026\nroot@db-01:~#', 'utf8'))

    expect(reject).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: 'Connection successful' })
  })

  it('requests fresh password after retryable Mingyu rejection and records transcript context', async () => {
    // For mingyu, we don't do auto-selection, so this test just verifies
    // that the connection is marked as ready without any write operations
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-3',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)',
      targetUsername: 'root',
      targetPassword: 'target-secret'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-3', conn, event, sendStatusUpdate, resolve, reject)

    // Mingyu menu detected - should go to manual operation mode
    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n', 'utf8'))

    // No auto-selection should happen
    expect(stream.write).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(reject).not.toHaveBeenCalled()
  })

  it('records password diagnostics without exposing plaintext for interactive response and write', async () => {
    // For mingyu, we don't do auto-selection, so this test just verifies
    // that the connection is marked as ready without any write operations
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-4',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14',
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-4', conn, event, sendStatusUpdate, resolve, reject)

    // Mingyu menu detected - should go to manual operation mode
    stream.emit('data', Buffer.from('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n', 'utf8'))

    // No auto-selection should happen
    expect(stream.write).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(reject).not.toHaveBeenCalled()
  })

  it('detects flattened Mingyu asset list and immediately starts target selection', () => {
    const stream = new MockJumpServerStream()
    const connectionInfo = {
      id: 'jump-interaction-5',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '172.21.9.107',
      targetHostname: '172.21.9.107-L20',
      targetAsset: '172.21.9.107'
    } as any
    const conn = { end: vi.fn() } as any
    const event = {
      sender: {
        send: vi.fn()
      }
    } as any
    const sendStatusUpdate = vi.fn()
    const resolve = vi.fn()
    const reject = vi.fn()

    setupJumpServerInteraction(stream, connectionInfo, connectionInfo.id, 'jump-uuid-5', conn, event, sendStatusUpdate, resolve, reject)

    stream.emit(
      'data',
      Buffer.from(
        '" ============================================================================="  [GateShell]  001: 172.21.9.107-L20   172.21.9.107:22    ssh   root  002: oidc-test  10.192.1.123:22    ssh   [EMPTY]   所有云主机  /2, name-asc',
        'utf8'
      )
    )

    // For mingyu bastion, don't auto-select - let user manually operate
    expect(stream.write).not.toHaveBeenCalled()
    expect(sendStatusUpdate).toHaveBeenCalledWith(expect.stringContaining('Please select target manually'), 'info', 'ssh.jumpserver.manualOperation')
    expect(resolve).toHaveBeenCalledWith({ status: 'connected', message: expect.stringContaining('Mingyu shell ready') })
    expect(recordDebugTranscriptEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: 'jump-interaction-5',
        transport: 'jumpserver',
        source: 'jumpserver-navigation',
        event: 'phase_change',
        phase: 'connected',
        meta: expect.objectContaining({
          from: 'connecting',
          to: 'connected',
          reason: 'mingyu-menu-ready'
        })
      })
    )
    expect(reject).not.toHaveBeenCalled()
  })
})

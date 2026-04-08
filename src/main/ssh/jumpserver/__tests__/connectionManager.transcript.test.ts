import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordDebugTranscriptEventMock, ensureDebugTranscriptSessionMock, attemptSecondaryConnectionMock, setupJumpServerInteractionMock } =
  vi.hoisted(() => ({
    recordDebugTranscriptEventMock: vi.fn(),
    ensureDebugTranscriptSessionMock: vi.fn(() => '/tmp/chaterm-jumpserver-test.ndjson'),
    attemptSecondaryConnectionMock: vi.fn().mockResolvedValue(undefined),
    setupJumpServerInteractionMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  default: {
    app: {
      getAppPath: () => process.cwd()
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn()
    },
    BrowserWindow: {
      getAllWindows: () => []
    }
  }
}))

vi.mock('ssh2', () => {
  const { EventEmitter } = require('events')

  class MockClient extends EventEmitter {
    connect = vi.fn(() => {
      Promise.resolve().then(() => {
        this.emit('ready')
      })
    })

    shell = vi.fn((_options, callback) => {
      callback(null, {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        stderr: { on: vi.fn() }
      })
    })

    end = vi.fn()
  }

  return {
    Client: MockClient
  }
})

vi.mock('../../sshHandle', () => ({
  attemptSecondaryConnection: attemptSecondaryConnectionMock,
  keyboardInteractiveOpts: new Map<string, string[]>(),
  sftpConnections: new Map(),
  connectionStatus: new Map()
}))

vi.mock('../../proxy', () => ({
  createProxySocket: vi.fn()
}))

vi.mock('../../debugTranscript', () => ({
  ensureDebugTranscriptSession: ensureDebugTranscriptSessionMock,
  recordDebugTranscriptEvent: recordDebugTranscriptEventMock
}))

vi.mock('../interaction', () => ({
  setupJumpServerInteraction: setupJumpServerInteractionMock
}))

vi.mock('../mfa', () => ({
  handleJumpServerKeyboardInteractive: vi.fn()
}))

import { handleJumpServerConnection } from '../connectionManager'

describe('handleJumpServerConnection transcript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureDebugTranscriptSessionMock.mockReturnValue('/tmp/chaterm-jumpserver-test.ndjson')
    attemptSecondaryConnectionMock.mockResolvedValue(undefined)
    setupJumpServerInteractionMock.mockImplementation(
      (_stream, _connectionInfo, _connectionId, _jumpserverUuid, _conn, _event, _sendStatusUpdate, resolve) => {
        resolve({ status: 'connected', message: 'Connection successful' })
      }
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('marks secondary connection transcript events as noise', async () => {
    const result = await handleJumpServerConnection({
      id: 'jump-connection-1',
      host: 'jump.example.internal',
      port: 22,
      username: 'alice',
      password: 'secret',
      targetIp: '10.30.5.14'
    } as any)

    await Promise.resolve()

    expect(result).toEqual({
      status: 'connected',
      message: 'Connection successful'
    })
    expect(ensureDebugTranscriptSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: 'jump-connection-1',
        transport: 'jumpserver',
        source: 'connection'
      })
    )
    expect(attemptSecondaryConnectionMock).toHaveBeenCalled()
    expect(recordDebugTranscriptEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: 'jump-connection-1',
        transport: 'jumpserver',
        source: 'secondary',
        event: 'secondary_connect_start',
        noise: true
      })
    )
    expect(recordDebugTranscriptEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: 'jump-connection-1',
        transport: 'jumpserver',
        source: 'secondary',
        event: 'secondary_connect_complete',
        noise: true
      })
    )
  })
})

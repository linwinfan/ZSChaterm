import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { navigateToJumpServerAsset } from '../streamManager'
import { JUMPSERVER_CONSTANTS, type JumpServerNavigationPath } from '../constants'

interface MockJumpServerStream extends EventEmitter {
  write: ReturnType<typeof vi.fn>
  emitData: (chunk: string) => void
}

const createMockStream = (): MockJumpServerStream => {
  const stream = new EventEmitter() as MockJumpServerStream
  stream.write = vi.fn()
  stream.emitData = (chunk: string) => {
    stream.emit('data', Buffer.from(chunk, 'utf8'))
  }
  return stream
}

describe('jumpserver streamManager navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps standard jumpserver navigation by writing target IP first', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = { needsPassword: false }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-1')

    stream.emitData('Welcome\nOpt>')
    expect(stream.write).toHaveBeenCalledWith('10.30.5.14\r')

    stream.emitData('Connecting to 10.30.5.14\n')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('selects Mingyu target with :ssh direct command format', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: false,
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-2')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   root\n/1, name-asc\n')

    // Use \n for :ssh commands to avoid \r being interpreted as carriage return
    expect(stream.write).toHaveBeenCalledWith(':ssh root@10.30.5.14:22\n')
    expect(navigationPath.profile).toBe('mingyu')
    expect(navigationPath.mingyuSelector).toBe('001')
    expect(navigationPath.mingyuSelectionCommand).toBe(':ssh root@10.30.5.14:22')
    expect(navigationPath.targetUsername).toBe('root')

    stream.emitData('ssh -l root 10.30.5.14 -p 22\n')
    stream.emitData('Last login: Tue Mar 31\n')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('requests Mingyu asset list before selecting target when menu has no visible entries', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: false,
      targetHostname: 'db-01'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-3')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, 'r\r')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   root\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(2, ':ssh root@10.30.5.14:22\n')

    stream.emitData('ssh -l root 10.30.5.14 -p 22\n')
    stream.emitData('root@db-01:~#')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('uses :ssh direct command format without needing fallback', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: false,
      targetHostname: 'db-01',
      targetAsset: 'db-01(10.30.5.14:22)'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-4')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   root\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':ssh root@10.30.5.14:22\n')

    stream.emitData('ssh -l root 10.30.5.14 -p 22\n')
    stream.emitData('root@db-01:~#')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('falls back to open command for [EMPTY] loginUser when :ssh format shows no progress', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetUsername: 'root',
      targetPassword: 'secret',
      targetHostname: 'oidc-test'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.192.1.123', navigationPath, 'jumpserver-4b')

    // Entry with [EMPTY] loginUser should use fallback open command
    stream.emitData('[GateShell]\n002: oidc-test          10.192.1.123:22    ssh   [EMPTY]   所有云主机\n/2, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':2\r')

    stream.emitData(':')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.DATA_SETTLE_DELAY + 2001)
    expect(stream.write).toHaveBeenNthCalledWith(2, '\r')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(3, 'open 002\r')

    const rejectionExpectation = expect(navigationPromise).rejects.toThrow(
      'JumpServer exec stream: Mingyu target selection returned to GateShell menu (open 002)'
    )
    stream.emitData('[GateShell]\n')

    await rejectionExpectation
  })

  it('retries saved password when Mingyu authentication banner still points to requested target', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetUsername: 'root',
      targetPassword: 'secret',
      targetHostname: 'db-01'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-5')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':1\r')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(2, '\r')

    stream.emitData('<<USERNAME>>')
    expect(stream.write).toHaveBeenNthCalledWith(3, 'root\r')

    stream.emitData('<<PASSWORD>>')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(4, 'secret\r')

    stream.emitData("==>Waiting for connection ...\n(GateShell) root@db-01_10.30.5.14:22's Authentication")
    expect(stream.write).toHaveBeenCalledTimes(4)

    stream.emitData('| [root@db-01_10.30.5.14:22] Password: ')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(5, 'secret\r')

    stream.emitData('Last login: Tue Apr 1 11:34:15 2026\nroot@db-01:~#')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('rejects before password retry when Mingyu authentication banner points to a different target', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetUsername: 'root',
      targetPassword: 'secret',
      targetHostname: 'db-01'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-mismatch')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':1\r')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(2, '\r')

    stream.emitData('<<USERNAME>>')
    expect(stream.write).toHaveBeenNthCalledWith(3, 'root\r')

    stream.emitData('<<PASSWORD>>')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(4, 'secret\r')

    stream.emitData("==>Waiting for connection ...\n(GateShell) root@oidc-test_10.192.1.123:22's Authentication")
    stream.emitData('| [root@oidc-test_10.192.1.123:22] Password: ')

    await expect(navigationPromise).rejects.toThrow('expected 10.30.5.14, got 10.192.1.123')
    expect(stream.write).toHaveBeenCalledTimes(4)
  })

  it('keeps standard jumpserver password prompt path unchanged', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetPassword: 'secret'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-standard-password')

    stream.emitData('Welcome\nOpt>')
    expect(stream.write).toHaveBeenNthCalledWith(1, '10.30.5.14\r')

    stream.emitData('Password: ')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(2, 'secret\r')

    stream.emitData('Last login: Tue Apr 1 11:34:15 2026\nroot@db-01:~#')

    await expect(navigationPromise).resolves.toBeUndefined()
  })

  it('rejects when Mingyu really returns to GateShell menu after password input', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetUsername: 'root',
      targetPassword: 'secret',
      targetHostname: 'db-01'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-6')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':1\r')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(2, '\r')

    stream.emitData('<<USERNAME>>')
    expect(stream.write).toHaveBeenNthCalledWith(3, 'root\r')

    stream.emitData('<<PASSWORD>>')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(4, 'secret\r')

    stream.emitData('[GateShell]\n')

    await expect(navigationPromise).rejects.toThrow('JumpServer exec stream: Mingyu target selection returned to GateShell menu after password input')
  })

  it('rejects with fresh-input-required when Mingyu reports retryable password failure', async () => {
    const stream = createMockStream()
    const navigationPath: JumpServerNavigationPath = {
      needsPassword: true,
      targetUsername: 'root',
      targetPassword: 'secret',
      targetHostname: 'db-01'
    }

    const navigationPromise = navigateToJumpServerAsset(stream, '10.30.5.14', navigationPath, 'jumpserver-7')

    stream.emitData('[GateShell]\n001: db-01   10.30.5.14:22    ssh   [EMPTY]\n/1, name-asc\n')
    expect(stream.write).toHaveBeenNthCalledWith(1, ':1\r')

    stream.emitData('[GateShell]\n')
    expect(stream.write).toHaveBeenNthCalledWith(2, '\r')

    stream.emitData('<<USERNAME>>')
    expect(stream.write).toHaveBeenNthCalledWith(3, 'root\r')

    stream.emitData('<<PASSWORD>>')
    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
    expect(stream.write).toHaveBeenNthCalledWith(4, 'secret\r')

    stream.emitData('Permission denied, please try again.')

    await expect(navigationPromise).rejects.toThrow('JumpServer exec stream: Password rejected and fresh input is required')
  })
})

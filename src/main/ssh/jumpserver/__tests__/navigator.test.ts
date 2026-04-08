import { describe, it, expect } from 'vitest'
import {
  createAuthenticationTargetMismatchError,
  detectDirectConnectionReason,
  detectJumpServerShellProfile,
  extractJumpServerAuthenticationTarget,
  getJumpServerAuthenticationTargetMismatch,
  getJumpServerExitCommand,
  getJumpServerListCommand,
  getJumpServerNextPageCommand,
  hasJumpServerCommandPrompt,
  hasJumpServerInitialMenuPrompt,
  hasJumpServerMenuReturn,
  hasNoAssetsPrompt,
  hasPasswordError,
  hasPasswordPrompt,
  hasRetryablePasswordError,
  resolveJumpServerShellProfile
} from '../navigator'

describe('jumpserver navigator', () => {
  describe('profile detection', () => {
    it('detects standard profile from Opt prompt', () => {
      expect(detectJumpServerShellProfile('Welcome\nOpt>')).toBe('standard')
    })

    it('detects mingyu profile from GateShell prompt', () => {
      expect(detectJumpServerShellProfile('Welcome\n[GateShell]')).toBe('mingyu')
    })

    it('keeps current profile when new output is inconclusive', () => {
      expect(resolveJumpServerShellProfile('plain output', 'mingyu')).toBe('mingyu')
    })
  })

  describe('prompt detection', () => {
    it('detects initial menu for standard and mingyu', () => {
      expect(hasJumpServerInitialMenuPrompt('Opt>')).toBe(true)
      expect(hasJumpServerInitialMenuPrompt('[GateShell]')).toBe(true)
    })

    it('detects flattened Mingyu asset list as initial menu', () => {
      const flattenedAssetList =
        '" ============================================================================="  [GateShell]  001: 172.21.9.107-L20   172.21.9.107:22    ssh   root  002: oidc-test  10.192.1.123:22    ssh   [EMPTY]   所有云主机  /2, name-asc'
      expect(hasJumpServerInitialMenuPrompt(flattenedAssetList, 'mingyu')).toBe(true)
    })

    it('detects command prompt for standard host and mingyu menu', () => {
      expect(hasJumpServerCommandPrompt('[Host]>')).toBe(true)
      expect(hasJumpServerCommandPrompt('[GateShell]', 'mingyu')).toBe(true)
    })
  })

  describe('command helpers', () => {
    it('returns profile-aware commands', () => {
      expect(getJumpServerListCommand('standard')).toBe('p')
      expect(getJumpServerListCommand('mingyu')).toBe('r')
      expect(getJumpServerNextPageCommand('standard')).toBe('n')
      expect(getJumpServerNextPageCommand('mingyu')).toBeNull()
      expect(getJumpServerExitCommand('standard')).toBe('q')
      expect(getJumpServerExitCommand('mingyu')).toBe(':q')
    })
  })

  describe('authentication target detection', () => {
    it('extracts Mingyu authentication target from recent password prompt context', () => {
      const authenticationContext =
        "==>Waiting for connection ...\n(GateShell) root@172.21.9.107-L20_172.21.9.107:22's Authentication\n| [root@172.21.9.107-L20_172.21.9.107:22] Password: "

      expect(extractJumpServerAuthenticationTarget(authenticationContext, 'mingyu')).toEqual({
        source: 'password-prompt',
        authenticationTarget: 'root@172.21.9.107-L20_172.21.9.107:22',
        targetIp: '172.21.9.107'
      })
    })

    it('returns mismatch only when Mingyu authentication target ip differs from expected target', () => {
      const mismatchContext =
        "==>Waiting for connection ...\n(GateShell) root@oidc-test_10.192.1.123:22's Authentication\n| [root@oidc-test_10.192.1.123:22] Password: "

      expect(getJumpServerAuthenticationTargetMismatch(mismatchContext, '172.21.9.107', 'mingyu')).toEqual({
        source: 'password-prompt',
        authenticationTarget: 'root@oidc-test_10.192.1.123:22',
        targetIp: '10.192.1.123',
        expectedTargetIp: '172.21.9.107'
      })
      expect(getJumpServerAuthenticationTargetMismatch(mismatchContext, '10.192.1.123', 'mingyu')).toBeNull()
      expect(getJumpServerAuthenticationTargetMismatch('| [root@db-01] Password: ', '10.192.1.123', 'mingyu')).toBeNull()
      expect(getJumpServerAuthenticationTargetMismatch(mismatchContext, '172.21.9.107', 'standard')).toBeNull()
    })

    it('creates mismatch error message with expected and actual target ip', () => {
      expect(
        createAuthenticationTargetMismatchError({
          source: 'password-prompt',
          authenticationTarget: 'root@oidc-test_10.192.1.123:22',
          targetIp: '10.192.1.123',
          expectedTargetIp: '172.21.9.107'
        }).message
      ).toContain('expected 172.21.9.107, got 10.192.1.123')
    })
  })

  describe('password error detection', () => {
    it('detects explicit password error message', () => {
      expect(hasPasswordError('password auth error')).toBe(true)
      expect(hasPasswordError('permission denied', 'mingyu')).toBe(true)
    })

    it('keeps standard menu fallback only for standard profile', () => {
      expect(hasPasswordError('[Host]>', 'standard')).toBe(true)
      expect(hasPasswordError('[GateShell]', 'mingyu')).toBe(false)
    })

    it('detects mingyu menu return separately from password error', () => {
      expect(hasJumpServerMenuReturn('[GateShell]', 'mingyu')).toBe(true)
      expect(hasPasswordError('[GateShell]', 'mingyu')).toBe(false)
    })

    it('does not treat GateShell authentication banner as menu return', () => {
      const authenticationBanner = "(GateShell) root@oidc-test_10.192.1.123:22's Authentication"
      expect(hasJumpServerMenuReturn(authenticationBanner, 'mingyu')).toBe(false)
      expect(hasJumpServerCommandPrompt(authenticationBanner, 'mingyu')).toBe(false)
      expect(hasPasswordPrompt(authenticationBanner)).toBe(false)
    })

    it('keeps Mingyu session list as menu surface', () => {
      const sessionList =
        '" Press <j>/<k> or <DOWN>/<UP> to move and then <ENTER> for clone.\n" Num: user@host:port (sessions) time\n  GateShell\n  1: root@db-01:22 (1) 11:34:15'
      expect(hasJumpServerMenuReturn(sessionList, 'mingyu')).toBe(true)
    })

    it('treats please-try-again password rejection as retryable instead of terminal failure', () => {
      expect(hasRetryablePasswordError('Permission denied, please try again.')).toBe(true)
      expect(hasPasswordError('Permission denied, please try again.', 'mingyu')).toBe(false)
    })

    it('ignores unrelated output', () => {
      expect(hasPasswordError('Connecting to 10.0.0.1')).toBe(false)
    })
  })

  describe('direct connection detection', () => {
    it('detects shell prompt after successful login', () => {
      expect(detectDirectConnectionReason('root@example:~#')).toBe('Prompt root@example:~#')
    })

    it('does not treat jumpserver menu as target shell prompt', () => {
      expect(detectDirectConnectionReason('[GateShell]')).toBeNull()
      expect(detectDirectConnectionReason('[Host]>')).toBeNull()
    })
  })

  describe('hasNoAssetsPrompt', () => {
    it('detects english message', () => {
      expect(hasNoAssetsPrompt('No Assets')).toBe(true)
      expect(hasNoAssetsPrompt('no assets found')).toBe(true)
    })

    it('detects chinese message', () => {
      expect(hasNoAssetsPrompt('没有资产')).toBe(true)
    })

    it('detects japanese message', () => {
      expect(hasNoAssetsPrompt('資産なし')).toBe(true)
    })

    it('detects korean message', () => {
      expect(hasNoAssetsPrompt('자산이 없습니다')).toBe(true)
    })

    it('returns false for unrelated text', () => {
      expect(hasNoAssetsPrompt('Assets list loaded')).toBe(false)
    })
  })
})

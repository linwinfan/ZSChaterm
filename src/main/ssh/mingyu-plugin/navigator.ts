/**
 * Mingyu Navigator - Mingyu 堡垒机导航逻辑
 * 从 jumpserver/navigator.ts 复制并解耦
 */

// import type { MingyuShellProfile } from './constants'

const STANDARD_INITIAL_PROMPT = 'Opt>'
const STANDARD_HOST_PROMPT = '[Host]>'
const MINGYU_MENU_PROMPT = '[GateShell]'
const MINGYU_SESSION_LIST_MARKERS = ['Press <j>/<k>', 'Press </> for search', 'Num: user@host:port (sessions) time']
const MINGYU_ASSET_LIST_MARKERS = ['Use "r" to refresh lists.', 'Use ":{number}<Enter>" to jump to line {number}.', '/2, name-asc', '/1, name-asc']
const MINGYU_AUTHENTICATION_BANNER_REGEX = /^\(GateShell\)\s+.+\bAuthentication\b/im
const MINGYU_AUTHENTICATION_TARGET_REGEX = /\(GateShell\)\s+([^\r\n]+?)'s Authentication\b/gim
const MINGYU_AUTHENTICATION_PASSWORD_TARGET_REGEX = /\|\s*\[([^\]]+)\]\s*Password:/gim
const IPV4_REGEX = /(?:\d{1,3}\.){3}\d{1,3}/g
const MINGYU_AUTHENTICATION_CONTEXT_WINDOW = 2000

const EXPLICIT_PASSWORD_ERROR_KEYWORDS = ['password auth error', 'authentication failed', 'permission denied', '密码错误', '密码认证失败']
const RETRYABLE_PASSWORD_ERROR_KEYWORDS = ['please try again', '请重试', '重新输入密码']

export interface JumpServerAuthenticationTarget {
  source: 'authentication-banner' | 'password-prompt'
  authenticationTarget: string
  targetIp: string
}

export interface JumpServerAuthenticationTargetMismatch extends JumpServerAuthenticationTarget {
  expectedTargetIp: string
}

const getLastRegexCapture = (regex: RegExp, text: string): string | null => {
  regex.lastIndex = 0
  let match: RegExpExecArray | null = regex.exec(text)
  let lastCapture: string | null = null

  while (match) {
    const capturedTarget = match[1]?.trim()
    if (capturedTarget) {
      lastCapture = capturedTarget
    }
    match = regex.exec(text)
  }

  return lastCapture
}

const extractLastIpv4 = (text: string): string | null => {
  const ipv4Matches = text.match(IPV4_REGEX)
  return ipv4Matches?.at(-1) ?? null
}

const getRecentAuthenticationContext = (text: string): string => {
  return text.slice(-MINGYU_AUTHENTICATION_CONTEXT_WINDOW)
}

const extractAuthenticationTargetFromRecentContext = (text: string): JumpServerAuthenticationTarget | null => {
  if (!text) {
    return null
  }

  const recentContext = getRecentAuthenticationContext(text)
  const passwordPromptTarget = getLastRegexCapture(MINGYU_AUTHENTICATION_PASSWORD_TARGET_REGEX, recentContext)
  const authenticationBannerTarget = getLastRegexCapture(MINGYU_AUTHENTICATION_TARGET_REGEX, recentContext)
  const authenticationTarget = passwordPromptTarget ?? authenticationBannerTarget
  const source = passwordPromptTarget ? 'password-prompt' : authenticationBannerTarget ? 'authentication-banner' : null

  if (!authenticationTarget || !source) {
    return null
  }

  const targetIp = extractLastIpv4(authenticationTarget)
  if (!targetIp) {
    return null
  }

  return {
    source,
    authenticationTarget,
    targetIp
  }
}

export const extractMingyuAuthenticationTarget = (text: string): JumpServerAuthenticationTarget | null => {
  return extractAuthenticationTargetFromRecentContext(text)
}

export const getMingyuAuthenticationTargetMismatch = (text: string, expectedTargetIp: string): JumpServerAuthenticationTargetMismatch | null => {
  const normalizedExpectedTargetIp = expectedTargetIp.trim()
  if (!normalizedExpectedTargetIp) {
    return null
  }

  const authenticationTarget = extractMingyuAuthenticationTarget(text)
  if (!authenticationTarget || authenticationTarget.targetIp === normalizedExpectedTargetIp) {
    return null
  }

  return {
    ...authenticationTarget,
    expectedTargetIp: normalizedExpectedTargetIp
  }
}

export const createAuthenticationTargetMismatchError = (mismatch: JumpServerAuthenticationTargetMismatch): Error => {
  return new Error(
    `Mingyu authentication target mismatch: expected ${mismatch.expectedTargetIp}, got ${mismatch.targetIp} (${mismatch.authenticationTarget})`
  )
}

const getTrimmedMingyuLines = (text: string): string[] => {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0007/g, '').trim())
    .filter(Boolean)
}

const hasMingyuInitialMenuSurface = (text: string): boolean => {
  if (!text) {
    return false
  }

  if (text.includes(MINGYU_MENU_PROMPT)) {
    return true
  }

  const lines = getTrimmedMingyuLines(text)
  return (
    lines.some((line) => line === 'GateShell') ||
    MINGYU_SESSION_LIST_MARKERS.some((marker) => text.includes(marker)) ||
    MINGYU_ASSET_LIST_MARKERS.some((marker) => text.includes(marker))
  )
}

const hasMingyuMenuReturnSurface = (text: string): boolean => {
  if (!text || MINGYU_AUTHENTICATION_BANNER_REGEX.test(text)) {
    return false
  }

  return hasMingyuInitialMenuSurface(text)
}

/**
 * Detect shell profile for Mingyu bastion hosts
 */
export const detectMingyuShellProfile = (text: string): 'mingyu' | 'standard' | null => {
  if (!text) return null
  if (text.includes('GateShell') || text.includes(MINGYU_MENU_PROMPT)) {
    return 'mingyu'
  }
  if (text.includes(STANDARD_INITIAL_PROMPT) || text.includes(STANDARD_HOST_PROMPT)) {
    return 'standard'
  }
  return null
}

export const resolveMingyuShellProfile = (text: string, currentProfile: 'standard' | 'mingyu' = 'standard'): 'standard' | 'mingyu' => {
  return detectMingyuShellProfile(text) ?? currentProfile
}

export const hasMingyuInitialMenuPrompt = (text: string): boolean => {
  return hasMingyuInitialMenuSurface(text)
}

export const hasMingyuCommandPrompt = (text: string): boolean => {
  // const resolvedProfile = profile ?? detectMingyuShellProfile(text)

  // if (resolvedProfile === 'mingyu') {
  //   return hasMingyuMenuReturnSurface(text)
  // }

  // return text.includes(STANDARD_HOST_PROMPT) || text.includes(STANDARD_INITIAL_PROMPT)
  return hasMingyuMenuReturnSurface(text)
}

export const hasMingyuMenuReturn = (text: string): boolean => {
  return hasMingyuCommandPrompt(text)
}

export const getMingyuListCommand = (): string => {
  return 'r'
}

export const getMingyuNextPageCommand = (): string | null => {
  return null
}

export const getMingyuExitCommand = (): string => {
  return ':q'
}

/**
 * Detect if output contains password prompt
 */
export const hasUsernamePrompt = (text: string): boolean => {
  return /<<\s*USERNAME\s*>>/i.test(text)
}

export const hasDialogPasswordPrompt = (text: string): boolean => {
  return /<<\s*PASSWORD\s*>>/i.test(text)
}

export const hasPasswordPrompt = (text: string): boolean => {
  return text.includes('Password:') || text.includes('password:') || hasDialogPasswordPrompt(text)
}

/**
 * Detect if output contains password error information
 */
export const hasRetryablePasswordError = (text: string): boolean => {
  const normalized = text.toLowerCase()
  return RETRYABLE_PASSWORD_ERROR_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))
}

export const hasPasswordError = (text: string): boolean => {
  const normalized = text.toLowerCase()

  if (hasRetryablePasswordError(text)) {
    return false
  }

  if (EXPLICIT_PASSWORD_ERROR_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return true
  }

  const resolvedProfile = detectMingyuShellProfile(text)
  return resolvedProfile === 'standard' ? hasMingyuCommandPrompt(text) : false
}

/**
 * Detect if successfully connected to target server
 * @returns If connection success indicator is detected, returns reason description; otherwise returns null
 */
export const detectDirectConnectionReason = (text: string): string | null => {
  if (!text) return null

  const indicators = ['Connecting to', '连接到', 'Last login:', 'Last failed login:']

  for (const indicator of indicators) {
    if (text.includes(indicator)) {
      return `Keyword ${indicator.trim()}`
    }
  }

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed === STANDARD_HOST_PROMPT || trimmed.endsWith(STANDARD_INITIAL_PROMPT) || trimmed === MINGYU_MENU_PROMPT) continue

    const isPrompt =
      (trimmed.endsWith('$') || trimmed.endsWith('#') || trimmed.endsWith(']$') || trimmed.endsWith(']#') || trimmed.endsWith('>$')) &&
      (trimmed.includes('@') || trimmed.includes(':~') || trimmed.startsWith('['))

    if (isPrompt) {
      return `Prompt ${trimmed}`
    }
  }

  return null
}

export const hasNoAssetsPrompt = (text: string): boolean => {
  if (!text) return false
  const normalized = text.toLowerCase()

  if (normalized.includes('no assets')) {
    return true
  }

  return text.includes('没有资产') || text.includes('資産なし') || text.includes('자산이 없')
}

export const createNoAssetsError = (): Error => {
  const error = new Error('Asset not found, please refresh assets')
  ;(error as any).messageKey = 'ssh.mingyu.assetNotFound'
  return error
}

import type { Client } from 'ssh2'

export interface ProxyConfig {
  type?: 'HTTP' | 'HTTPS' | 'SOCKS4' | 'SOCKS5'
  host?: string
  port?: number
  enableProxyIdentity?: boolean
  username?: string
  password?: string
  timeout?: number
}

export type JumpServerShellProfile = 'standard' | 'mingyu'

export const MINGYU_ENTER_SELECTION_COMMAND = '__ENTER__'
export const MINGYU_ARROW_DOWN_SELECTION_COMMAND = '__ARROW_DOWN__'
export const MINGYU_ARROW_UP_SELECTION_COMMAND = '__ARROW_UP__'

export interface JumpServerNavigationPath {
  selectedUserId?: number
  needsPassword: boolean
  targetPassword?: string
  profile?: JumpServerShellProfile
  mingyuSelector?: string
  mingyuSelectionCommand?: string
  mingyuTargetOrdinal?: number
  mingyuCurrentOrdinal?: number
  targetHostname?: string
  targetAsset?: string
  targetUsername?: string
}

export interface JumpServerConnectionData {
  conn: Client
  stream?: any
  jumpserverUuid?: string
  targetIp?: string
  navigationPath?: JumpServerNavigationPath
}

export interface JumpServerMarkedCommand {
  marker: string
  output: string
  completed: boolean
  rawChunks: Uint8Array[]
  rawBytes: number
  raw: Uint8Array[]
  lastActivity: number
  idleTimer: NodeJS.Timeout | null
}

export interface JumpServerExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  exitSignal?: string
}

export interface JumpServerConnectionInfo {
  id: string
  assetUuid?: string
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  targetIp: string
  targetHostname?: string
  targetAsset?: string
  targetUsername?: string
  targetPassword?: string
  terminalType?: string
  needProxy: boolean
  connIdentToken: string
  proxyConfig?: ProxyConfig
}

export const JUMPSERVER_CONSTANTS = {
  PASSWORD_INPUT_DELAY: 100,
  DATA_COLLECTION_DELAY: 50,
  COMMAND_EXEC_TIMEOUT: 30000,
  NAVIGATION_TIMEOUT: 60000,
  DATA_SETTLE_DELAY: 100,
  MINGYU_VISUAL_NAVIGATION_MAX_STEPS: 12,
  MINGYU_VISUAL_NAVIGATION_MAX_WARMUP_STEPS: 4,
  MINGYU_VISUAL_BUFFER_LIMIT: 12000
} as const

export const MAX_JUMPSERVER_MFA_ATTEMPTS = 3

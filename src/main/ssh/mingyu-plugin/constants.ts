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

//export type MingyuShellProfile = 'mingyu'

export const MINGYU_ENTER_SELECTION_COMMAND = '__ENTER__'
export const MINGYU_ARROW_DOWN_SELECTION_COMMAND = '__ARROW_DOWN__'
export const MINGYU_ARROW_UP_SELECTION_COMMAND = '__ARROW_UP__'

export interface MingyuNavigationPath {
  mingyuUuid: string
  selectedUserId?: number
  needsPassword: boolean
  targetPassword?: string
  //profile?: MingyuShellProfile
  mingyuSelector?: string
  mingyuSelectionCommand?: string
  mingyuTargetOrdinal?: number
  mingyuCurrentOrdinal?: number
  targetHostname?: string
  targetAsset?: string
  targetUsername?: string
}

export interface MingyuConnectionData {
  conn: Client
  stream?: any
  mingyuUuid?: string
  targetIp?: string
  navigationPath?: MingyuNavigationPath
}

export interface MingyuMarkedCommand {
  marker: string
  output: string
  completed: boolean
  rawChunks: Uint8Array[]
  rawBytes: number
  raw: Uint8Array[]
  lastActivity: number
  idleTimer: NodeJS.Timeout | null
}

export interface MingyuExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  exitSignal?: string
}

export interface MingyuConnectionInfo {
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

export const MINGYU_CONSTANTS = {
  PASSWORD_INPUT_DELAY: 100,
  DATA_COLLECTION_DELAY: 50,
  COMMAND_EXEC_TIMEOUT: 30000,
  NAVIGATION_TIMEOUT: 60000,
  DATA_SETTLE_DELAY: 100,
  MINGYU_VISUAL_NAVIGATION_MAX_STEPS: 12,
  MINGYU_VISUAL_NAVIGATION_MAX_WARMUP_STEPS: 4,
  MINGYU_VISUAL_BUFFER_LIMIT: 12000
} as const

export const MAX_MINGYU_MFA_ATTEMPTS = 3

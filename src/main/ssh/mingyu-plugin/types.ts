/**
 * Mingyu 连接信息
 */
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

export interface ProxyConfig {
  host: string
  port: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  type?: 'HTTP' | 'HTTPS' | 'SOCKS4' | 'SOCKS5'
}

export interface MingyuConnectResult {
  status: 'connected' | 'error'
  sessionId?: string
  message?: string
  [key: string]: unknown
}

export interface MingyuShellArgs {
  id: string
  terminalType?: string
}

export interface MingyuShellResult {
  status: 'success' | 'error'
  message?: string
  [key: string]: unknown
}

export interface MingyuWriteArgs {
  id: string
  data: string
  marker?: string
  lineCommand?: string
  isBinary?: boolean
}

export interface MingyuResizeArgs {
  id: string
  rows: number
  cols: number
}

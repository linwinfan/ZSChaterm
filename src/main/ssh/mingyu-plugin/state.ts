/**
 * Mingyu 独立状态管理
 */

import type { Client } from 'ssh2'

export interface MingyuConnectionData {
  conn: Client
  stream?: unknown
  mingyuUuid?: string
  targetIp?: string
  navigationPath?: MingyuNavigationPath
}

export interface MingyuNavigationPath {
  selectedUserId?: number
  needsPassword: boolean
  targetPassword?: string
  //profile?: 'mingyu'
  mingyuSelector?: string
  mingyuSelectionCommand?: string
  mingyuTargetOrdinal?: number
  mingyuCurrentOrdinal?: number
  targetHostname?: string
  targetAsset?: string
  targetUsername?: string
}

// 连接状态 Map
export const mingyuConnections = new Map<string, MingyuConnectionData>()

// Shell 流 Map
export const mingyuShellStreams = new Map<string, unknown>()

// Exec 流 Map
export const mingyuExecStreams = new Map<string, unknown>()

// 标记命令 Map
export const mingyuMarkedCommands = new Map<string, unknown>()

// 最后命令 Map
export const mingyuLastCommand = new Map<string, string>()

// 输入缓冲区 Map
export const mingyuInputBuffer = new Map<string, string>()

// 连接状态 Map
export const mingyuConnectionStatus = new Map<string, unknown>()

// UUID 到连接 ID 的映射
export const mingyuUuidToConnectionId = new Map<string, string>()

// Track which Mingyu connections have already sent connectedToTarget (for AI Chat auto-open)
export const mingyuConnectedToTargetSent = new Set<string>()

const mingyuExecStreamPromises = new Map<string, Promise<any>>()

export const getExecStreamPromise = (connectionId: string) => mingyuExecStreamPromises.get(connectionId)
export const setExecStreamPromise = (connectionId: string, promise: Promise<any>) => mingyuExecStreamPromises.set(connectionId, promise)
export const deleteExecStreamPromise = (connectionId: string) => mingyuExecStreamPromises.delete(connectionId)

/**
 * Mingyu 独立状态管理
 */
import { type MingyuConnectionData, type MingyuMarkedCommand } from './constants'

// 连接状态 Map
export const mingyuConnections = new Map<string, MingyuConnectionData>()

// Shell 流 Map
export const mingyuShellStreams = new Map<string, unknown>()

// Exec 流 Map
export const mingyuExecStreams = new Map<string, unknown>()

export const mingyuMarkedCommands = new Map<string, MingyuMarkedCommand>()

// 最后命令 Map
export const mingyuLastCommand = new Map<string, string>()

// 最后写入时间 Map (用于命令去重)
export const markedCmdLastWriteTime = new Map<string, number>()

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

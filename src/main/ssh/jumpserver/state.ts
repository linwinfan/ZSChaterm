import { type JumpServerConnectionData, type JumpServerMarkedCommand } from './constants'

export const jumpserverConnections = new Map<string, JumpServerConnectionData>()
export const jumpserverShellStreams = new Map<string, any>()
export const jumpserverExecStreams = new Map<string, any>()
const jumpserverExecStreamPromises = new Map<string, Promise<any>>()
export const jumpserverMarkedCommands = new Map<string, JumpServerMarkedCommand>()
export const jumpserverLastCommand = new Map<string, string>()
export const jumpserverInputBuffer = new Map<string, string>()
export const jumpserverConnectionStatus = new Map<string, { [key: string]: any }>()
// Mapping from jumpserverUuid to connectionId for quick lookup
export const jumpserverUuidToConnectionId = new Map<string, string>()

export const getExecStreamPromise = (connectionId: string) => jumpserverExecStreamPromises.get(connectionId)
export const setExecStreamPromise = (connectionId: string, promise: Promise<any>) => jumpserverExecStreamPromises.set(connectionId, promise)
export const deleteExecStreamPromise = (connectionId: string) => jumpserverExecStreamPromises.delete(connectionId)

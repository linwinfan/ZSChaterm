/**
 * Mingyu Handle - AI Agent 使用的简化接口
 *
 * 提供给 AI Agent 调用的核心函数，类似于 jumpserverHandle.ts 的简化版
 * 此文件仅包含 AI Agent 必需的 3 个函数：shellWrite, exec, disconnect
 */

import {
  mingyuConnections,
  mingyuShellStreams,
  mingyuExecStreams,
  mingyuMarkedCommands,
  mingyuLastCommand,
  mingyuInputBuffer,
  mingyuConnectionStatus
} from './state'

// Re-export state for use by other modules
export { mingyuShellStreams, mingyuConnections, mingyuConnectionStatus }

/**
 * Command execution result
 */
export interface MingyuExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  exitSignal?: string
}

/**
 * Write data to Mingyu shell stream
 * This sets up markedCommands for command output collection (required for AI Chat)
 */
export const mingyuShellWrite = (sessionId: string, data: string, marker?: string): void => {
  const stream = mingyuShellStreams.get(sessionId) as { write: (data: string) => void } | undefined
  if (!stream) {
    console.warn('[MingyuHandle] Write to non-existent shell session:', sessionId)
    return
  }

  // Set markedCommands for command output collection
  if (mingyuMarkedCommands.has(sessionId)) {
    mingyuMarkedCommands.delete(sessionId)
  }
  if (marker) {
    mingyuMarkedCommands.set(sessionId, {
      marker,
      output: '',
      completed: false,
      rawChunks: [],
      rawBytes: 0,
      raw: [],
      lastActivity: Date.now(),
      idleTimer: null
    })
  }

  if (!mingyuInputBuffer.has(sessionId)) {
    mingyuInputBuffer.set(sessionId, '')
  }

  stream.write(data)
}

/**
 * Execute command via SSH exec channel on Mingyu bastion
 * This bypasses the shell menu and executes directly on the target
 */
export const mingyuExec = async (sessionId: string, command: string): Promise<MingyuExecResult> => {
  const connectionData = mingyuConnections.get(sessionId)
  if (!connectionData) {
    throw new Error(`No Mingyu connection for id=${sessionId}`)
  }

  const conn = connectionData.conn
  if (!conn) {
    throw new Error(`No SSH Client in Mingyu connection for id=${sessionId}`)
  }

  console.log(`[MingyuHandle] exec: executing via conn.exec() for id=${sessionId}, command=${command}`)

  return new Promise((resolve) => {
    conn.exec(command, (err: any, stream: any) => {
      if (err) {
        console.error(`[MingyuHandle] exec error:`, err)
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1
        })
        return
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      stream.on('close', (code: number, _signal: string) => {
        console.log(`[MingyuHandle] exec completed: exitCode=${code ?? 0}`)
        resolve({
          stdout,
          stderr,
          exitCode: code as number
        })
      })
    })
  })
}

/**
 * Disconnect Mingyu shell session
 */
export const mingyuDisconnect = async (sessionId: string): Promise<{ status: string; message: string }> => {
  const status = mingyuConnectionStatus.get(sessionId) as { source?: string } | undefined
  const stream = mingyuShellStreams.get(sessionId) as { end: () => void } | undefined

  if (stream) {
    stream.end()
    mingyuShellStreams.delete(sessionId)
  }

  // Clean up exec streams
  const execStream = mingyuExecStreams.get(sessionId)
  if (execStream) {
    ;(execStream as any).end()
    mingyuExecStreams.delete(sessionId)
  }

  const connData = mingyuConnections.get(sessionId)
  if (connData) {
    if (connData.mingyuUuid) {
      const { mingyuUuidToConnectionId } = require('./state')
      mingyuUuidToConnectionId.delete(connData.mingyuUuid)
    }
    if (status?.source !== 'shared') {
      connData.conn.end()
    }
    mingyuConnections.delete(sessionId)
  }

  // Clean up marked commands
  const markedCmd = mingyuMarkedCommands.get(sessionId)
  if (markedCmd && markedCmd.idleTimer) {
    clearTimeout(markedCmd.idleTimer)
  }
  mingyuMarkedCommands.delete(sessionId)

  // Clean up other state
  mingyuLastCommand.delete(sessionId)
  mingyuInputBuffer.delete(sessionId)
  mingyuConnectionStatus.delete(sessionId)

  const { mingyuConnectedToTargetSent } = require('./state')
  mingyuConnectedToTargetSent.delete(sessionId)

  console.log(`[MingyuHandle] Disconnected session: ${sessionId}`)
  return { status: 'success', message: 'Mingyu connection disconnected' }
}

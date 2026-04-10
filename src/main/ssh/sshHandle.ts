import { BrowserWindow, dialog, ipcMain } from 'electron'
import { Client } from 'ssh2'
import type { SFTPWrapper } from 'ssh2'
import { spawn } from 'child_process'
import { Duplex } from 'stream'
import type { CommandGenerationContext } from '@shared/WebviewMessage'

// Move the import to after the function definition to avoid circular dependency
import { detectShellType, ShellType } from './agentHandle'

function safeAppPath(): string {
  try {
    const { app } = require('electron') as { app?: { getAppPath?: () => string } }
    if (app?.getAppPath) return app.getAppPath()
  } catch {}
  return process.cwd()
}

const appPath = safeAppPath()
const packagePath = path.join(appPath, 'package.json')

// Try to read package.json from appPath first, fallback to __dirname if not exists
let packageInfo
try {
  if (fs.existsSync(packagePath)) {
    packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  } else {
    const fallbackPath = path.join(__dirname, '../../package.json')
    packageInfo = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))
  }
} catch (error) {
  console.error('Failed to read package.json:', error)
  // Provide a default packageInfo object if both paths fail
  packageInfo = { name: 'chaterm', version: 'unknown' }
}
import { createProxySocket } from './proxy'
import { buildErrorResponse } from './jumpserver/errorUtils'
import { getJumpServerExitCommand, hasJumpServerCommandPrompt } from './jumpserver/navigator'

// Shell prompt detection regex - matches shell prompts ending with $ or #
// Supports formats like: [root@host ~]#, user@host:~$, root@host#, etc.
const SHELL_PROMPT_REGEX = /[$#]\s*$/m
import {
  ensureDebugTranscriptSession,
  recordDebugTranscriptEvent,
  type DebugTranscriptActor,
  type DebugTranscriptDirection,
  type DebugTranscriptRedaction,
  type DebugTranscriptSource,
  type DebugTranscriptTransport
} from './debugTranscript'

import {
  jumpserverConnections,
  handleJumpServerConnection,
  jumpserverShellStreams,
  jumpserverExecStreams,
  jumpserverMarkedCommands,
  jumpserverConnectionStatus,
  jumpserverLastCommand,
  createJumpServerExecStream
} from './jumpserverHandle'

// Track which JumpServer connections have already sent connectedToTarget
// Key: connectionId, Value: true
const jumpserverConnectedToTargetSent = new Set<string>()
import path from 'path'
import fs from 'fs'
import { SSHAgentManager } from './ssh-agent/ChatermSSHAgent'
import { getAlgorithmsByAssetType } from './algorithms'
import { connectBastionByType, shellBastionSession, resizeBastionSession, writeBastionSession, disconnectBastionSession } from './bastionPlugin'

// Hybrid buffer strategy configuration
const FLUSH_CONFIG = {
  INSTANT_SIZE: 16, // < 16 bytes: send immediately (user input)
  INSTANT_DELAY: 0, // 0ms
  SMALL_SIZE: 256, // < 256 bytes: short delay
  SMALL_DELAY: 10, // 10ms
  LARGE_SIZE: 1024, // < 1KB: medium delay
  LARGE_DELAY: 30, // 30ms
  BULK_DELAY: 50 // >= 1KB: long delay (bulk output)
}

// Helper function to determine delay based on buffer size
const getDelayByBufferSize = (size: number): number => {
  if (size < FLUSH_CONFIG.INSTANT_SIZE) {
    return FLUSH_CONFIG.INSTANT_DELAY
  } else if (size < FLUSH_CONFIG.SMALL_SIZE) {
    return FLUSH_CONFIG.SMALL_DELAY
  } else if (size < FLUSH_CONFIG.LARGE_SIZE) {
    return FLUSH_CONFIG.LARGE_DELAY
  } else {
    return FLUSH_CONFIG.BULK_DELAY
  }
}

// Store SSH connections
export const sshConnections = new Map()

// SSH connection reuse pool: stores connections that have passed MFA authentication
interface ReusableConnection {
  conn: any // SSH Client
  sessions: Set<string> // Set of session IDs using this connection
  host: string
  port: number
  username: string
  hasMfaAuth: boolean // Flag indicating whether MFA authentication has been completed
}
const sshConnectionPool = new Map<string, ReusableConnection>()

// Generate unique key for connection pool
const getConnectionPoolKey = (host: string, port: number, username: string): string => {
  return `${host}:${port}:${username}`
}

interface SftpConnectionInfo {
  isSuccess: boolean
  sftp?: any
  error?: string
}
export const sftpConnections = new Map<string, SftpConnectionInfo>()

// Execute command result
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  exitSignal?: string
}

// Store shell session streams
const shellStreams = new Map()
const markedCommands = new Map()

const KeyboardInteractiveAttempts = new Map()
export const connectionStatus = new Map()

type TranscriptPhase = 'connecting' | 'connected' | 'closed'

const recordTranscriptEvent = (options: {
  rootSessionId: string
  transport: DebugTranscriptTransport
  source: DebugTranscriptSource
  actor: DebugTranscriptActor
  event: string
  phase?: TranscriptPhase
  direction?: DebugTranscriptDirection
  text?: string
  bytes?: number
  redacted?: DebugTranscriptRedaction
  noise?: boolean
  meta?: Record<string, unknown>
  sessionId?: string
}) => {
  recordDebugTranscriptEvent({
    rootSessionId: options.rootSessionId,
    sessionId: options.sessionId,
    transport: options.transport,
    source: options.source,
    actor: options.actor,
    event: options.event,
    phase: options.phase,
    direction: options.direction,
    text: options.text,
    bytes: options.bytes,
    redacted: options.redacted,
    noise: options.noise,
    meta: options.meta
  })
}

const resolveTranscriptTransport = (sshType?: string): DebugTranscriptTransport => {
  return sshType === 'jumpserver' ? 'jumpserver' : 'ssh'
}

const recordSecondaryTranscriptEvent = (
  connectionInfo: Record<string, any>,
  options: {
    actor: DebugTranscriptActor
    event: string
    phase?: TranscriptPhase
    direction?: DebugTranscriptDirection
    text?: string
    bytes?: number
    redacted?: DebugTranscriptRedaction
    meta?: Record<string, unknown>
    sessionId?: string
  }
) => {
  recordTranscriptEvent({
    ...options,
    rootSessionId: connectionInfo.id,
    transport: resolveTranscriptTransport(connectionInfo.sshType),
    source: 'secondary',
    noise: true
  })
}

const attachConnectionLifecycleLogging = (connectionId: string, transport: DebugTranscriptTransport, conn: Client) => {
  conn.on('close', () => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source: 'connection',
      actor: 'system',
      event: 'connection_close',
      phase: 'closed'
    })
  })

  conn.on('error', (error: Error) => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source: 'connection',
      actor: 'system',
      event: 'connection_error',
      phase: 'closed',
      meta: { message: error.message }
    })
  })
}

const attachShellTranscriptLogging = (connectionId: string, transport: DebugTranscriptTransport, stream: any, source: DebugTranscriptSource) => {
  stream.on('data', (data: Buffer) => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source,
      actor: 'remote',
      event: 'data',
      phase: 'connected',
      direction: 'in',
      text: data.toString('utf8'),
      bytes: data.length
    })
  })

  stream.stderr?.on('data', (data: Buffer) => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source,
      actor: 'remote',
      event: 'stderr',
      phase: 'connected',
      direction: 'in',
      text: data.toString('utf8'),
      bytes: data.length,
      meta: { stderr: true }
    })
  })

  stream.on('close', () => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source,
      actor: 'system',
      event: 'shell_close',
      phase: 'closed'
    })
  })

  stream.on('error', (error: Error) => {
    recordTranscriptEvent({
      rootSessionId: connectionId,
      transport,
      source,
      actor: 'system',
      event: 'shell_error',
      phase: 'closed',
      meta: { message: error.message }
    })
  })
}

const getOutboundTranscriptPayload = (data: string, isBinary: boolean, lineCommand?: string) => {
  if (isBinary) {
    return {
      text: undefined,
      bytes: Buffer.byteLength(data, 'binary'),
      meta: { isBinary: true }
    }
  }

  return {
    text: data,
    bytes: Buffer.byteLength(data, 'utf8'),
    meta: lineCommand ? { lineCommand } : undefined
  }
}

const getMfaPromptText = (prompts: Array<{ prompt: string }>) => prompts.map((item) => item.prompt).join('\n')

const getMfaResponseCount = (responses: unknown): number => {
  return Array.isArray(responses) ? responses.length : 0
}

const getTranscriptAuthMethod = (connectionInfo: Record<string, any>): 'password' | 'privateKey' | 'unknown' => {
  if (connectionInfo.privateKey) {
    return 'privateKey'
  }
  if (connectionInfo.password) {
    return 'password'
  }
  return 'unknown'
}

const recordConnectionReady = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connect_ready',
    phase: 'connected',
    meta
  })
}

const recordMfaEvent = (options: {
  rootSessionId: string
  transport: DebugTranscriptTransport
  event: string
  text?: string
  redacted?: DebugTranscriptRedaction
  meta?: Record<string, unknown>
}) => {
  recordTranscriptEvent({
    rootSessionId: options.rootSessionId,
    transport: options.transport,
    source: 'mfa',
    actor: options.event === 'mfa_prompt' ? 'remote' : 'user',
    event: options.event,
    phase: 'connecting',
    direction: options.event === 'mfa_prompt' ? 'in' : 'out',
    text: options.text,
    redacted: options.redacted,
    meta: options.meta
  })
}

const recordShellWrite = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  source: DebugTranscriptSource,
  data: string,
  isBinary: boolean,
  lineCommand?: string
) => {
  const payload = getOutboundTranscriptPayload(data, isBinary, lineCommand)
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source,
    actor: 'user',
    event: 'write',
    phase: 'connected',
    direction: 'out',
    text: payload.text,
    bytes: payload.bytes,
    meta: payload.meta
  })
}

const isPasswordLikePrompt = (text?: string) => {
  return typeof text === 'string' && /(password|passphrase|验证码|动态码|verification|otp|token)/i.test(text)
}

const getMfaTranscriptRedaction = (text?: string): DebugTranscriptRedaction => {
  return isPasswordLikePrompt(text) ? 'mfa' : 'none'
}

const recordMfaPrompt = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  prompts: Array<{ prompt: string }>,
  meta?: Record<string, unknown>
) => {
  const promptText = getMfaPromptText(prompts)
  recordMfaEvent({
    rootSessionId: connectionId,
    transport,
    event: 'mfa_prompt',
    text: promptText,
    redacted: getMfaTranscriptRedaction(promptText),
    meta
  })
}

const recordMfaResponse = (connectionId: string, transport: DebugTranscriptTransport, responses: unknown, meta?: Record<string, unknown>) => {
  recordMfaEvent({
    rootSessionId: connectionId,
    transport,
    event: 'mfa_response',
    text: getMfaResponseCount(responses) > 0 ? '<redacted:mfa>' : '',
    redacted: 'mfa',
    meta: {
      responseCount: getMfaResponseCount(responses),
      ...meta
    }
  })
}

const recordMfaCancel = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaEvent({
    rootSessionId: connectionId,
    transport,
    event: 'mfa_cancel',
    meta
  })
}

const recordMfaTimeout = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaEvent({
    rootSessionId: connectionId,
    transport,
    event: 'mfa_timeout',
    meta
  })
}

const recordMfaResult = (connectionId: string, transport: DebugTranscriptTransport, status: 'success' | 'failed', meta?: Record<string, unknown>) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'mfa',
    actor: 'system',
    event: 'mfa_result',
    phase: status === 'success' ? 'connected' : 'connecting',
    meta: {
      status,
      ...meta
    }
  })
}

const recordDisconnectRequest = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'user',
    event: 'disconnect_request',
    phase: 'closed',
    direction: 'out'
  })
}

const recordSecondarySummary = (connectionInfo: Record<string, any>, event: string, meta?: Record<string, unknown>) => {
  recordSecondaryTranscriptEvent(connectionInfo, {
    actor: 'system',
    event,
    phase: 'connected',
    meta
  })
}

const recordSecondaryWrite = (
  connectionInfo: Record<string, any>,
  event: string,
  text: string,
  redacted?: DebugTranscriptRedaction,
  meta?: Record<string, unknown>
) => {
  recordSecondaryTranscriptEvent(connectionInfo, {
    actor: 'user',
    event,
    phase: 'connecting',
    direction: 'out',
    text,
    redacted,
    meta
  })
}

const recordSecondaryError = (connectionInfo: Record<string, any>, event: string, message: string, meta?: Record<string, unknown>) => {
  recordSecondaryTranscriptEvent(connectionInfo, {
    actor: 'system',
    event,
    phase: 'closed',
    meta: {
      message,
      ...meta
    }
  })
}

const recordSecondaryConnectionStart = (connectionInfo: Record<string, any>, ident: string) => {
  recordSecondarySummary(connectionInfo, 'secondary_connect_start', {
    host: connectionInfo.host,
    port: connectionInfo.port || 22,
    username: connectionInfo.username,
    ident
  })
}

const recordSecondaryConnectionReady = (connectionInfo: Record<string, any>) => {
  recordSecondarySummary(connectionInfo, 'secondary_connect_ready')
}

const recordSecondaryConnectionClose = (connectionInfo: Record<string, any>) => {
  recordSecondarySummary(connectionInfo, 'secondary_connect_close')
}

const recordSecondaryConnectionError = (connectionInfo: Record<string, any>, error: Error) => {
  recordSecondaryError(connectionInfo, 'secondary_connect_error', error.message)
}

const recordSecondaryExecResult = (connectionInfo: Record<string, any>, event: string, meta?: Record<string, unknown>) => {
  recordSecondarySummary(connectionInfo, event, meta)
}

const recordSecondaryKeyboardReuse = (connectionInfo: Record<string, any>) => {
  recordSecondarySummary(connectionInfo, 'secondary_mfa_reuse')
}

const recordSecondaryMfaPrompt = (connectionInfo: Record<string, any>) => {
  recordSecondaryWrite(connectionInfo, 'secondary_mfa_prompt_reuse', '<redacted:mfa>', 'mfa')
}

const recordSecondaryMfaResponse = (connectionInfo: Record<string, any>, count: number) => {
  recordSecondaryWrite(connectionInfo, 'secondary_mfa_response_reuse', '<redacted:mfa>', 'mfa', { responseCount: count })
}

const recordSecondarySftpAvailability = (connectionInfo: Record<string, any>, available: boolean, error?: string) => {
  recordSecondarySummary(connectionInfo, 'secondary_sftp_result', {
    sftpAvailable: available,
    error: error || ''
  })
}

const recordSecondaryCommandList = (connectionInfo: Record<string, any>, count: number) => {
  recordSecondaryExecResult(connectionInfo, 'secondary_command_list_result', { count })
}

const recordSecondarySudo = (connectionInfo: Record<string, any>, hasSudo: boolean) => {
  recordSecondaryExecResult(connectionInfo, 'secondary_sudo_result', { hasSudo })
}

const recordSecondarySkip = (connectionInfo: Record<string, any>, reason: string) => {
  recordSecondarySummary(connectionInfo, 'secondary_skip', { reason })
}

const recordSecondaryReadyData = (connectionInfo: Record<string, any>, meta?: Record<string, unknown>) => {
  recordSecondarySummary(connectionInfo, 'secondary_ready_data_sent', meta)
}

const recordSshReusePool = (connectionId: string, poolKey: string) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport: 'ssh',
    source: 'connection',
    actor: 'system',
    event: 'connection_pool_store',
    phase: 'connected',
    meta: { poolKey }
  })
}

const recordSshReusePoolCleanup = (connectionId: string, poolKey: string, reason: 'close' | 'error', message?: string) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport: 'ssh',
    source: 'connection',
    actor: 'system',
    event: 'connection_pool_cleanup',
    phase: 'closed',
    meta: {
      poolKey,
      reason,
      message: message || ''
    }
  })
}

const recordShellBridgeClose = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_bridge_close',
    phase: 'closed'
  })
}

const recordShellBridgeStderr = (connectionId: string, transport: DebugTranscriptTransport, text: string) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'remote',
    event: 'stderr',
    phase: 'connected',
    direction: 'in',
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    meta: { stderr: true }
  })
}

const recordShellBridgeData = (connectionId: string, transport: DebugTranscriptTransport, data: Buffer) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'remote',
    event: 'data',
    phase: 'connected',
    direction: 'in',
    text: data.toString('utf8'),
    bytes: data.length
  })
}

const recordShellStreamError = (connectionId: string, transport: DebugTranscriptTransport, error: Error) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_error',
    phase: 'closed',
    meta: { message: error.message }
  })
}

const recordShellReadyByTransport = (connectionId: string, transport: DebugTranscriptTransport, method?: 'shell' | 'exec') => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_ready',
    phase: 'connected',
    meta: method ? { method } : undefined
  })
}

const recordShellFallbackByTransport = (connectionId: string, transport: DebugTranscriptTransport, command: string, message: string) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_fallback',
    phase: 'connecting',
    meta: {
      command,
      message
    }
  })
}

const recordShellErrorByTransport = (connectionId: string, transport: DebugTranscriptTransport, error: Error) => {
  recordShellStreamError(connectionId, transport, error)
}

const recordShellWriteByTransport = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  data: string,
  isBinary: boolean,
  lineCommand?: string
) => {
  recordShellWrite(connectionId, transport, 'main-shell', data, isBinary, lineCommand)
}

const recordConnectReadyByTransport = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordConnectionReady(connectionId, transport, meta)
}

const recordConnectErrorByTransport = (connectionId: string, transport: DebugTranscriptTransport, error: Error) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connect_error',
    phase: 'closed',
    meta: { message: error.message }
  })
}

const recordConnectionReuseByTransport = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connection_reused',
    phase: 'connected',
    meta
  })
}

const recordDisconnectRequestByTransport = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordDisconnectRequest(connectionId, transport)
}

const recordMfaPromptByTransport = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  prompts: Array<{ prompt: string }>,
  meta?: Record<string, unknown>
) => {
  recordMfaPrompt(connectionId, transport, prompts, meta)
}

const recordMfaResponseByTransport = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  responses: unknown,
  meta?: Record<string, unknown>
) => {
  recordMfaResponse(connectionId, transport, responses, meta)
}

const recordMfaResultByTransport = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  status: 'success' | 'failed',
  meta?: Record<string, unknown>
) => {
  recordMfaResult(connectionId, transport, status, meta)
}

const recordMfaTimeoutByTransport = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaTimeout(connectionId, transport, meta)
}

const recordMfaCancelByTransport = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaCancel(connectionId, transport, meta)
}

const recordConnectRetryByTransport = (connectionId: string, transport: DebugTranscriptTransport, attempt: number) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connect_retry',
    phase: 'connecting',
    meta: { attempt }
  })
}

const recordTranscriptReadyByTransport = (connectionInfo: Record<string, any>, transport: DebugTranscriptTransport) => {
  const filePath = ensureDebugTranscriptSession({
    rootSessionId: connectionInfo.id,
    transport,
    source: 'connection',
    meta: {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      assetType: connectionInfo.asset_type || '',
      authMethod: getTranscriptAuthMethod(connectionInfo),
      needProxy: !!connectionInfo.needProxy,
      sshType: connectionInfo.sshType || 'ssh'
    }
  })
  recordTranscriptEvent({
    rootSessionId: connectionInfo.id,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'transcript_ready',
    phase: 'connecting',
    meta: { filePath }
  })
}

const recordTranscriptStartByTransport = (connectionInfo: Record<string, any>, transport: DebugTranscriptTransport) => {
  recordTranscriptReadyByTransport(connectionInfo, transport)
  recordTranscriptEvent({
    rootSessionId: connectionInfo.id,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connect_start',
    phase: 'connecting',
    meta: {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      authMethod: getTranscriptAuthMethod(connectionInfo),
      needProxy: !!connectionInfo.needProxy
    }
  })
}

const recordTranscriptStart = (connectionInfo: Record<string, any>) => {
  const transport = resolveTranscriptTransport(connectionInfo.sshType)
  recordTranscriptStartByTransport(connectionInfo, transport)
}

const recordConnectionReadyForInfo = (connectionInfo: Record<string, any>) => {
  recordConnectReadyByTransport(connectionInfo.id, resolveTranscriptTransport(connectionInfo.sshType))
}

const recordConnectionReuseForInfo = (connectionInfo: Record<string, any>, meta?: Record<string, unknown>) => {
  recordConnectionReuseByTransport(connectionInfo.id, resolveTranscriptTransport(connectionInfo.sshType), meta)
}

const recordConnectionErrorForInfo = (connectionInfo: Record<string, any>, error: Error) => {
  recordConnectErrorByTransport(connectionInfo.id, resolveTranscriptTransport(connectionInfo.sshType), error)
}

const recordConnectionRetryForInfo = (connectionInfo: Record<string, any>, attempt: number) => {
  recordConnectRetryByTransport(connectionInfo.id, resolveTranscriptTransport(connectionInfo.sshType), attempt)
}

const recordShellBridgeReadyForTransport = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_bridge_ready',
    phase: 'connected'
  })
}

const recordShellBridgeCloseForTransport = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordShellBridgeClose(connectionId, transport)
}

const recordShellBridgeStderrForTransport = (connectionId: string, transport: DebugTranscriptTransport, text: string) => {
  recordShellBridgeStderr(connectionId, transport, text)
}

const recordShellBridgeDataForTransport = (connectionId: string, transport: DebugTranscriptTransport, data: Buffer) => {
  recordShellBridgeData(connectionId, transport, data)
}

const recordConnectionLifecycleForTransport = (connectionId: string, transport: DebugTranscriptTransport, conn: Client) => {
  attachConnectionLifecycleLogging(connectionId, transport, conn)
}

const recordShellTranscriptForTransport = (connectionId: string, transport: DebugTranscriptTransport, stream: any, source: DebugTranscriptSource) => {
  attachShellTranscriptLogging(connectionId, transport, stream, source)
}

const recordShellBridgeOpen = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_bridge_open',
    phase: 'connected'
  })
}

const recordConnectionTranscriptOpen = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'connection',
    actor: 'system',
    event: 'connection_open',
    phase: 'connecting'
  })
}

const recordShellSessionAttach = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_session_attach',
    phase: 'connected'
  })
}

const recordShellSessionDetach = (connectionId: string, transport: DebugTranscriptTransport) => {
  recordTranscriptEvent({
    rootSessionId: connectionId,
    transport,
    source: 'main-shell',
    actor: 'system',
    event: 'shell_session_detach',
    phase: 'closed'
  })
}

const recordShellSessionWrite = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  data: string,
  isBinary: boolean,
  lineCommand?: string
) => {
  recordShellWriteByTransport(connectionId, transport, data, isBinary, lineCommand)
}

const recordConnectPoolStore = (connectionId: string, poolKey: string) => {
  recordSshReusePool(connectionId, poolKey)
}

const recordConnectPoolCleanup = (connectionId: string, poolKey: string, reason: 'close' | 'error', message?: string) => {
  recordSshReusePoolCleanup(connectionId, poolKey, reason, message)
}

const recordSecondSummary = (connectionInfo: Record<string, any>, event: string, meta?: Record<string, unknown>) => {
  recordSecondarySummary(connectionInfo, event, meta)
}

const recordSecondError = (connectionInfo: Record<string, any>, event: string, message: string, meta?: Record<string, unknown>) => {
  recordSecondaryError(connectionInfo, event, message, meta)
}

const recordSecondSftp = (connectionInfo: Record<string, any>, available: boolean, error?: string) => {
  recordSecondarySftpAvailability(connectionInfo, available, error)
}

const recordSecondStart = (connectionInfo: Record<string, any>, ident: string) => {
  recordSecondaryConnectionStart(connectionInfo, ident)
}

const recordSecondReady = (connectionInfo: Record<string, any>) => {
  recordSecondaryConnectionReady(connectionInfo)
}

const recordSecondClose = (connectionInfo: Record<string, any>) => {
  recordSecondaryConnectionClose(connectionInfo)
}

const recordSecondConnError = (connectionInfo: Record<string, any>, error: Error) => {
  recordSecondaryConnectionError(connectionInfo, error)
}

const recordSecondSkip = (connectionInfo: Record<string, any>, reason: string) => {
  recordSecondarySkip(connectionInfo, reason)
}

const recordSecondReadyData = (connectionInfo: Record<string, any>, meta?: Record<string, unknown>) => {
  recordSecondaryReadyData(connectionInfo, meta)
}

const recordSecondReuse = (connectionInfo: Record<string, any>) => {
  recordSecondaryKeyboardReuse(connectionInfo)
}

const recordSecondPrompt = (connectionInfo: Record<string, any>) => {
  recordSecondaryMfaPrompt(connectionInfo)
}

const recordSecondResponse = (connectionInfo: Record<string, any>, count: number) => {
  recordSecondaryMfaResponse(connectionInfo, count)
}

const recordSecondCommandList = (connectionInfo: Record<string, any>, count: number) => {
  recordSecondaryCommandList(connectionInfo, count)
}

const recordSecondSudo = (connectionInfo: Record<string, any>, hasSudo: boolean) => {
  recordSecondarySudo(connectionInfo, hasSudo)
}

const promptMfaTranscript = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  prompts: Array<{ prompt: string }>,
  meta?: Record<string, unknown>
) => {
  recordMfaPromptByTransport(connectionId, transport, prompts, meta)
}

const responseMfaTranscript = (connectionId: string, transport: DebugTranscriptTransport, responses: unknown, meta?: Record<string, unknown>) => {
  recordMfaResponseByTransport(connectionId, transport, responses, meta)
}

const resultMfaTranscript = (
  connectionId: string,
  transport: DebugTranscriptTransport,
  status: 'success' | 'failed',
  meta?: Record<string, unknown>
) => {
  recordMfaResultByTransport(connectionId, transport, status, meta)
}

const cancelMfaTranscript = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaCancelByTransport(connectionId, transport, meta)
}

const timeoutMfaTranscript = (connectionId: string, transport: DebugTranscriptTransport, meta?: Record<string, unknown>) => {
  recordMfaTimeoutByTransport(connectionId, transport, meta)
}

// Set KeyboardInteractive authentication timeout (milliseconds)
const KeyboardInteractiveTimeout = 300000 // 5 minutes timeout
const MaxKeyboardInteractiveAttempts = 5 // Max KeyboardInteractive attempts

const EventEmitter = require('events')
const connectionEvents = new EventEmitter()

// Cache
export const keyboardInteractiveOpts = new Map<string, string[]>()

export const getReusableSshConnection = (host: string, port: number, username: string) => {
  const poolKey = getConnectionPoolKey(host, port, username)
  const reusableConn = sshConnectionPool.get(poolKey)
  if (!reusableConn || !reusableConn.hasMfaAuth) {
    return null
  }

  const client = reusableConn.conn as Client | undefined
  if (!client || (client as any)?._sock?.destroyed) {
    sshConnectionPool.delete(poolKey)
    return null
  }

  return {
    poolKey,
    conn: client
  }
}

export const registerReusableSshSession = (poolKey: string, sessionId: string) => {
  const reusableConn = sshConnectionPool.get(poolKey)
  if (reusableConn) {
    reusableConn.sessions.add(sessionId)
  }
}

export const releaseReusableSshSession = (poolKey: string, sessionId: string) => {
  const reusableConn = sshConnectionPool.get(poolKey)
  if (reusableConn) {
    reusableConn.sessions.delete(sessionId)
  }
}

export const handleRequestKeyboardInteractive = (event, id, prompts, finish) => {
  return new Promise((_resolve, reject) => {
    const transport: DebugTranscriptTransport = 'ssh'

    // Get current retry count
    const attemptCount = KeyboardInteractiveAttempts.get(id) || 0

    // Check if maximum retry attempts exceeded
    if (attemptCount >= MaxKeyboardInteractiveAttempts) {
      KeyboardInteractiveAttempts.delete(id)
      resultMfaTranscript(id, transport, 'failed', {
        attempt: attemptCount,
        reason: 'max_attempts_reached'
      })
      // Send final failure event
      event.sender.send('ssh:keyboard-interactive-result', {
        id,
        attempts: attemptCount,
        status: 'failed',
        final: true
      })
      reject(new Error('Maximum authentication attempts reached'))
      return
    }

    // Set retry count
    KeyboardInteractiveAttempts.set(id, attemptCount + 1)
    promptMfaTranscript(id, transport, prompts, {
      attempt: attemptCount + 1
    })

    // Send MFA request to frontend
    event.sender.send('ssh:keyboard-interactive-request', {
      id,
      prompts: prompts.map((p) => p.prompt)
    })

    // Set timeout
    const timeoutId = setTimeout(() => {
      // Remove listener
      ipcMain.removeAllListeners(`ssh:keyboard-interactive-response:${id}`)
      ipcMain.removeAllListeners(`ssh:keyboard-interactive-cancel:${id}`)

      // Cancel authentication
      finish([])
      KeyboardInteractiveAttempts.delete(id)
      timeoutMfaTranscript(id, transport, {
        attempt: attemptCount + 1
      })
      resultMfaTranscript(id, transport, 'failed', {
        attempt: attemptCount + 1,
        reason: 'timeout'
      })
      event.sender.send('ssh:keyboard-interactive-timeout', { id })
      reject(new Error('Authentication timed out, please try connecting again'))
    }, KeyboardInteractiveTimeout)

    // Listen for user response
    ipcMain.once(`ssh:keyboard-interactive-response:${id}`, (_evt, responses) => {
      clearTimeout(timeoutId) // Clear timeout timer
      responseMfaTranscript(id, transport, responses, {
        attempt: attemptCount + 1
      })
      finish(responses)

      // Listen for connection status changes to determine verification result
      const statusHandler = (status) => {
        if (status.isVerified) {
          // Verification successful
          keyboardInteractiveOpts.set(id, responses)
          KeyboardInteractiveAttempts.delete(id)
          resultMfaTranscript(id, transport, 'success', {
            attempt: attemptCount + 1
          })
          event.sender.send('ssh:keyboard-interactive-result', {
            id,
            status: 'success'
          })
        } else {
          // Verification failed
          const currentAttempts = KeyboardInteractiveAttempts.get(id) || 0
          resultMfaTranscript(id, transport, 'failed', {
            attempt: currentAttempts,
            reason: 'verification_failed'
          })
          event.sender.send('ssh:keyboard-interactive-result', {
            id,
            attempts: currentAttempts,
            status: 'failed'
          })
          // SSH connection will automatically retrigger keyboard-interactive event for retry
        }
        connectionEvents.removeListener(`connection-status-changed:${id}`, statusHandler)
      }

      connectionEvents.once(`connection-status-changed:${id}`, statusHandler)
    })

    // Listen for user cancellation
    ipcMain.once(`ssh:keyboard-interactive-cancel:${id}`, () => {
      KeyboardInteractiveAttempts.delete(id)
      clearTimeout(timeoutId)
      finish([])
      cancelMfaTranscript(id, transport, {
        attempt: attemptCount + 1
      })
      resultMfaTranscript(id, transport, 'failed', {
        attempt: attemptCount + 1,
        reason: 'cancelled'
      })
      reject(new Error('Authentication cancelled'))
    })
  })
}

export const attemptSecondaryConnection = async (event, connectionInfo, ident) => {
  const { id, host, port, username, password, privateKey, passphrase, needProxy, proxyConfig, asset_type } = connectionInfo

  recordSecondStart(connectionInfo, ident)

  // Check if this is a network switch connection
  const isSwitch = asset_type?.startsWith('person-switch-')
  const switchBrand = isSwitch ? (asset_type === 'person-switch-cisco' ? 'cisco' : 'huawei') : null

  // For switches, skip secondary connection logic and return minimal ready data
  if (isSwitch && switchBrand) {
    recordSecondSkip(connectionInfo, 'switch-short-circuit')
    const readyResult = {
      isSwitch: true,
      switchBrand,
      hasSudo: false,
      commandList: []
    }
    recordSecondReadyData(connectionInfo, {
      isSwitch: true,
      switchBrand,
      hasSudo: false,
      commandCount: 0
    })
    event.sender.send(`ssh:connect:data:${id}`, readyResult)
    if (keyboardInteractiveOpts.has(id)) {
      keyboardInteractiveOpts.delete(id)
    }
    return
  }

  const conn = new Client()
  const algorithms = getAlgorithmsByAssetType(asset_type)
  const connectConfig: any = {
    host,
    port: port || 22,
    username,
    keepaliveInterval: 10000,
    readyTimeout: KeyboardInteractiveTimeout,
    ident: ident,
    algorithms
  }

  if (privateKey) {
    connectConfig.privateKey = privateKey
    if (passphrase) connectConfig.passphrase = passphrase
  } else if (password) {
    connectConfig.password = password
  }

  if (needProxy) {
    console.log('proxyConfig:', proxyConfig)
    connectConfig.sock = await createProxySocket(proxyConfig, host, port)
  }

  // Send initialization command result
  const readyResult: {
    hasSudo?: boolean
    commandList?: string[]
  } = {}

  let execCount = 0
  const totalCounts = 2
  const hasOpt = keyboardInteractiveOpts.has(id)
  const sendReadyData = (stopCount) => {
    execCount++
    if (execCount === totalCounts || stopCount) {
      recordSecondReadyData(connectionInfo, {
        stopCount: !!stopCount,
        hasSudo: readyResult.hasSudo ?? false,
        commandCount: readyResult.commandList?.length ?? 0,
        sftpAvailable: connectionStatus.get(id)?.sftpAvailable === true
      })
      event.sender.send(`ssh:connect:data:${id}`, readyResult)
      if (hasOpt) {
        keyboardInteractiveOpts.delete(id)
      }
    }
  }

  if (hasOpt) {
    connectConfig.tryKeyboard = true
    conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
      const cached = keyboardInteractiveOpts.get(id)
      recordSecondReuse(connectionInfo)
      recordSecondPrompt(connectionInfo)
      recordSecondResponse(connectionInfo, Array.isArray(cached) ? cached.length : 0)
      finish(cached || [])
    })
  }

  const sftpAsync = (conn) => {
    return new Promise<void>((resolve) => {
      recordSecondSummary(connectionInfo, 'secondary_sftp_check_start')
      conn.sftp((err, sftp) => {
        if (err || !sftp) {
          console.log(`SFTPCheckError [${id}]`, err)
          connectionStatus.set(id, {
            sftpAvailable: false,
            sftpError: err?.message || 'SFTP object is empty'
          })
          sftpConnections.set(id, { isSuccess: false, error: `sftp init error: "${err?.message || 'SFTP object is empty'}"` })
          recordSecondSftp(connectionInfo, false, err?.message || 'SFTP object is empty')
          resolve()
        } else {
          console.log(`startSftp [${id}]`)
          sftp.readdir('.', (readDirErr) => {
            if (readDirErr) {
              console.log(`SFTPCheckFailed [${id}]`)
              connectionStatus.set(id, {
                sftpAvailable: false,
                sftpError: readDirErr.message
              })
              recordSecondSftp(connectionInfo, false, readDirErr.message)
              sftp.end()
            } else {
              console.log(`SFTPCheckSuccess [${id}]`)
              sftpConnections.set(id, { isSuccess: true, sftp: sftp })
              connectionStatus.set(id, { sftpAvailable: true })
              recordSecondSftp(connectionInfo, true)
            }
            resolve()
          })
        }
      })
    })
  }

  conn
    .on('ready', async () => {
      recordSecondReady(connectionInfo)
      // Perform sftp check
      try {
        await sftpAsync(conn)
      } catch (e) {
        connectionStatus.set(id, {
          sftpAvailable: false,
          sftpError: 'SFTP connection failed'
        })
        recordSecondSftp(connectionInfo, false, 'SFTP connection failed')
      }

      // Perform cmd check
      try {
        let stdout = ''
        let stderr = ''
        recordSecondSummary(connectionInfo, 'secondary_command_list_start')
        conn.exec(
          'sh -c \'if command -v bash >/dev/null 2>&1; then bash -lc "compgen -A builtin; compgen -A command"; bash -ic "compgen -A alias" 2>/dev/null; else IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -x "$f" ] && printf "%s\\n" "${f##*/}"; done; done; fi\' | sort -u',
          (err, stream) => {
            if (err) {
              readyResult.commandList = []
              recordSecondError(connectionInfo, 'secondary_command_list_error', err.message)
              sendReadyData(false)
            } else {
              stream
                .on('data', (data: Buffer) => {
                  stdout += data.toString('utf8')
                })
                .stderr.on('data', (data: Buffer) => {
                  stderr += data.toString('utf8')
                })
                .on('close', () => {
                  if (stderr) {
                    readyResult.commandList = []
                    recordSecondError(connectionInfo, 'secondary_command_list_stderr', stderr.slice(-400))
                  } else {
                    readyResult.commandList = stdout.split('\n').filter(Boolean)
                  }
                  recordSecondCommandList(connectionInfo, readyResult.commandList.length)
                  sendReadyData(false)
                })
            }
          }
        )
      } catch (e) {
        readyResult.commandList = []
        recordSecondError(connectionInfo, 'secondary_command_list_error', e instanceof Error ? e.message : String(e))
        sendReadyData(false)
      }

      // Perform sudo check
      try {
        recordSecondSummary(connectionInfo, 'secondary_sudo_check_start')
        conn.exec('sudo -n true 2>/dev/null && echo true || echo false', (err, stream) => {
          if (err) {
            readyResult.hasSudo = false
            recordSecondError(connectionInfo, 'secondary_sudo_check_error', err.message)
            sendReadyData(false)
          } else {
            stream
              .on('data', (data: Buffer) => {
                const result = data.toString('utf8').trim()
                readyResult.hasSudo = result === 'true'
              })
              .stderr.on('data', () => {
                readyResult.hasSudo = false
              })
              .on('close', () => {
                recordSecondSudo(connectionInfo, !!readyResult.hasSudo)
                sendReadyData(false)
              })
          }
        })
      } catch (e) {
        readyResult.hasSudo = false
        recordSecondError(connectionInfo, 'secondary_sudo_check_error', e instanceof Error ? e.message : String(e))
        sendReadyData(false)
      }
    })
    .on('close', () => {
      recordSecondClose(connectionInfo)
    })
    .on('error', (err) => {
      recordSecondConnError(connectionInfo, err)
      sftpConnections.set(id, { isSuccess: false, error: `sftp connection error: "${err.message}"` })
      readyResult.hasSudo = false
      readyResult.commandList = []
      sendReadyData(true)
      connectionStatus.set(id, {
        sftpAvailable: false,
        sftpError: err.message
      })
    })
  sshConnections.set(id + '-second', conn) // Save connection object
  conn.connect(connectConfig)
}

function splitCommand(cmd: string): string[] {
  return cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"(.*)"$/, '$1')) || []
}

export async function createProxyCommandSocket(commandStr: string, host: string, port: number): Promise<any> {
  const replaced = commandStr.replace(/%h/g, host).replace(/%p/g, String(port))

  // Use shell: true to handle cmd.exe /c command under Windows
  const isWindowsCmd = process.platform === 'win32' && replaced.trim().startsWith('cmd.exe /c')

  let proc
  if (isWindowsCmd) {
    proc = spawn(replaced, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      shell: true
    })
  } else if (replaced.trim().startsWith('sh -c ')) {
    let cmdString = replaced.trim().slice(6).trim()

    if ((cmdString.startsWith('"') && cmdString.endsWith('"')) || (cmdString.startsWith("'") && cmdString.endsWith("'"))) {
      cmdString = cmdString.slice(1, -1)
    }
    proc = spawn('sh', ['-c', cmdString], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    })
  } else {
    // segmentation parameters
    const [cmd, ...args] = splitCommand(replaced)
    proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    })
  }

  // Create bidirectional packaging flow
  const socketProxy = new Duplex({
    read() {
      /* No-op: Data is pushed externally from process stdout */
    },
    write(chunk, encoding, callback) {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.write(chunk, encoding, callback)
      } else {
        callback(new Error('ProxyCommand stdin is not writable'))
      }
    }
  })

  // Bridge the stdout data of the child process to the wrapper stream
  proc.stdout.on('data', (chunk) => {
    if (!socketProxy.push(chunk)) {
      proc.stdout.pause()
    }
  })

  // backpressure handling
  socketProxy.on('drain', () => {
    if (proc.stdout.isPaused()) {
      proc.stdout.resume()
    }
  })

  const cleanup = () => {
    if (proc && !proc.killed) proc.kill()
    if (!socketProxy.destroyed) socketProxy.destroy()
  }

  proc.stdout.on('end', () => socketProxy.push(null))
  proc.on('error', (err) => socketProxy.emit('error', err))
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      socketProxy.emit('error', new Error(`Exit code ${code}`))
    }
  })

  socketProxy.on('close', cleanup)
  socketProxy.on('finish', () => {
    if (proc.stdin && proc.stdin.writable) proc.stdin.end()
  })
  ;(socketProxy as any).writable = true
  ;(socketProxy as any).readable = true

  return socketProxy
}
const handleAttemptConnection = async (event, connectionInfo, resolve, reject, retryCount) => {
  const {
    id,
    host,
    port,
    username,
    password,
    privateKey,
    passphrase,
    agentForward,
    needProxy,
    proxyConfig,
    connIdentToken,
    asset_type,
    proxyCommand
  } = connectionInfo
  retryCount++

  const transport = resolveTranscriptTransport(connectionInfo.sshType)

  connectionStatus.set(id, { isVerified: false }) // Update connection status
  const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
  const ident = `${packageInfo.name}_${packageInfo.version}` + identToken

  // Check connection reuse pool: only attempt reuse when using keyboard-interactive authentication
  const poolKey = getConnectionPoolKey(host, port || 22, username)
  const reusableConn = sshConnectionPool.get(poolKey)

  if (reusableConn && reusableConn.hasMfaAuth) {
    console.log(`[SSH Reuse] Detected reusable MFA connection: ${poolKey}`)

    // Use existing connection
    const conn = reusableConn.conn

    // Mark current session as connected
    sshConnections.set(id, conn)
    connectionStatus.set(id, { isVerified: true })
    reusableConn.sessions.add(id)
    recordConnectionReuseForInfo(connectionInfo, { poolKey, reused: true })
    recordConnectReadyByTransport(id, transport, { reused: true, poolKey })

    // Trigger connection success event
    connectionEvents.emit(`connection-status-changed:${id}`, { isVerified: true })

    // Execute secondary connection (sudo check, SFTP, etc.)
    attemptSecondaryConnection(event, connectionInfo, ident)

    console.log(`[SSH Reuse] Successfully reused connection, skipping MFA authentication`)
    resolve({ status: 'connected', message: 'Connection successful (reused)' })
    return
  }

  const conn = new Client()
  recordConnectionTranscriptOpen(id, transport)
  recordConnectionLifecycleForTransport(id, transport, conn)

  conn.on('ready', () => {
    sshConnections.set(id, conn) // Save connection object
    connectionStatus.set(id, { isVerified: true })
    connectionEvents.emit(`connection-status-changed:${id}`, { isVerified: true })
    recordConnectionReadyForInfo(connectionInfo)

    // Check if keyboard-interactive authentication was used
    // Must check before attemptSecondaryConnection as it will clear keyboardInteractiveOpts
    const hasKeyboardInteractive = keyboardInteractiveOpts.has(id)

    // If keyboard-interactive authentication was used, immediately save to connection pool for future reuse
    if (hasKeyboardInteractive) {
      const poolKey = getConnectionPoolKey(host, port || 22, username)
      console.log(`[SSH Connection Pool] Saving MFA authenticated connection: ${poolKey}`)

      sshConnectionPool.set(poolKey, {
        conn: conn,
        sessions: new Set([id]),
        host: host,
        port: port || 22,
        username: username,
        hasMfaAuth: true
      })
      recordConnectPoolStore(id, poolKey)

      // Listen for connection close event to clean up connection pool
      conn.on('close', () => {
        console.log(`[SSH Connection Pool] Connection closed, cleaning up reuse pool: ${poolKey}`)
        recordConnectPoolCleanup(id, poolKey, 'close')
        sshConnectionPool.delete(poolKey)
      })

      conn.on('error', (err) => {
        console.error(`[SSH Connection Pool] Connection error, cleaning up reuse pool: ${poolKey}`, err.message)
        recordConnectPoolCleanup(id, poolKey, 'error', err.message)
        sshConnectionPool.delete(poolKey)
      })
    }

    // Execute secondary connection (this will clear keyboardInteractiveOpts, so must be placed after the check)
    attemptSecondaryConnection(event, connectionInfo, ident)

    resolve({ status: 'connected', message: 'Connection successful' })
  })

  conn.on('error', (err) => {
    connectionStatus.set(id, { isVerified: false })

    connectionEvents.emit(`connection-status-changed:${id}`, { isVerified: false })
    if (err.level === 'client-authentication' && KeyboardInteractiveAttempts.has(id)) {
      console.log('Authentication failed. Retrying...')

      if (retryCount < MaxKeyboardInteractiveAttempts) {
        recordConnectionRetryForInfo(connectionInfo, retryCount)
        handleAttemptConnection(event, connectionInfo, resolve, reject, retryCount)
      } else {
        const maxRetryError = new Error('Maximum retries reached, authentication failed')
        recordConnectionErrorForInfo(connectionInfo, maxRetryError)
        reject(maxRetryError)
      }
    } else {
      console.log('Connection error:', err)
      recordConnectionErrorForInfo(connectionInfo, err)
      reject(new Error(err.message))
    }
  })

  // Configure connection settings
  const algorithms = getAlgorithmsByAssetType(asset_type)
  const connectConfig: any = {
    host,
    port: port || 22,
    username,
    keepaliveInterval: 10000, // Keep connection alive
    tryKeyboard: true, // Enable keyboard interactive authentication
    readyTimeout: KeyboardInteractiveTimeout, // Connection timeout, 30 seconds
    algorithms
  }

  connectConfig.ident = ident

  if (agentForward) {
    const manager = SSHAgentManager.getInstance()
    // If using Agent authentication
    connectConfig.agent = manager.getAgent()
    connectConfig.agentForward = true
  }

  conn.on('keyboard-interactive', async (_name, _instructions, _instructionsLang, prompts, finish) => {
    try {
      // Wait for user response
      await handleRequestKeyboardInteractive(event, id, prompts, finish)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log('SSH keyboard-interactive error:', errorMessage)

      // Only close connection when max retries exceeded, user cancelled, or timeout
      if (errorMessage.includes('Maximum authentication attempts') || errorMessage.includes('cancelled') || errorMessage.includes('timed out')) {
        conn.end() // Close connection
        reject(err)
      }
      // For other errors, let SSH connection handle naturally, may retrigger keyboard-interactive
    }
  })

  try {
    if (privateKey) {
      // Authenticate with private key
      connectConfig.privateKey = privateKey
      if (passphrase) {
        connectConfig.passphrase = passphrase
      }
    } else if (password) {
      // Authenticate with password
      connectConfig.password = password
    } else {
      const authError = new Error('No valid authentication method provided')
      recordConnectionErrorForInfo(connectionInfo, authError)
      reject(authError)
      return
    }

    try {
      if (proxyCommand) {
        connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, port || 22)
        delete connectConfig.host
        delete connectConfig.port
      } else if (needProxy) {
        connectConfig.sock = await createProxySocket(proxyConfig, host, port)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      const tunnelError = new Error(`Failed to establish a transport layer tunnel: ${errorMessage}`)
      recordConnectionErrorForInfo(connectionInfo, tunnelError)
      return reject(tunnelError)
    }
    conn.connect(connectConfig) // Attempt to connect
  } catch (err) {
    console.error('Connection configuration error:', err)
    const configError = new Error(`Connection configuration error: ${err}`)
    recordConnectionErrorForInfo(connectionInfo, configError)
    reject(configError)
  }
}
export const getUniqueRemoteName = async (sftp: SFTPWrapper, remoteDir: string, originalName: string, isDir: boolean): Promise<string> => {
  const list = await new Promise<{ filename: string; longname: string; attrs: any }[]>((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => (err ? reject(err) : resolve(list as any)))
  })
  let existing = new Set(list.map((f) => f.filename))

  if (isDir) {
    existing = new Set(list.filter((f) => f.attrs.isDirectory()).map((f) => f.filename))
  }

  let finalName = originalName
  const { name, ext } = path.parse(originalName)
  let count = 1

  while (existing.has(finalName)) {
    finalName = `${name}${ext}.${count}`
    count++
  }

  return finalName
}

export const getSftpConnection = (id: string): any => {
  const sftpConnectionInfo = sftpConnections.get(id)

  if (!sftpConnectionInfo) {
    console.log('Sftp connection not found')
    return null
  }

  if (!sftpConnectionInfo.isSuccess || !sftpConnectionInfo.sftp) {
    console.log(`SFTP not available: ${sftpConnectionInfo.error || 'Unknown error'}`)
    return null
  }

  return sftpConnectionInfo.sftp
}

export const cleanSftpConnection = (id) => {
  // Clean up SFTP
  if (sftpConnections.get(id)) {
    const sftp = getSftpConnection(id)
    sftp.end()
    sftpConnections.delete(id)
    if (sshConnections.get(id + '-second')) {
      const connSec = sshConnections.get(id + '-second')
      connSec.end()
      sshConnections.delete(id + '-second')
    }
  }
}

export const registerSSHHandlers = () => {
  // Handle connection
  ipcMain.handle('ssh:connect', async (_event, connectionInfo) => {
    const { sshType } = connectionInfo

    if (sshType === 'jumpserver') {
      // Route to JumpServer connection
      try {
        const result = await handleJumpServerConnection(connectionInfo, _event)
        return result
      } catch (error: unknown) {
        return buildErrorResponse(error)
      }
    }

    const bastionResult = await connectBastionByType(sshType, connectionInfo, _event)
    if (bastionResult !== null) {
      return bastionResult
    }

    recordTranscriptStart(connectionInfo)

    // Default to SSH connection when sshType is missing or explicitly 'ssh'
    const retryCount = 0
    return new Promise((resolve, reject) => {
      handleAttemptConnection(_event, connectionInfo, resolve, reject, retryCount)
    })
  })

  ipcMain.handle('ssh:sftp:conn:check', async (_event, { id }) => {
    if (connectionStatus.has(id)) {
      const status = connectionStatus.get(id)
      return status?.sftpAvailable === true
    }
    return false
  })

  ipcMain.handle('ssh:shell', async (event, { id, terminalType }) => {
    // Check if it's a JumpServer connection
    if (jumpserverConnections.has(id)) {
      // Use JumpServer shell handling
      const stream = jumpserverShellStreams.get(id)
      if (!stream) {
        return { status: 'error', message: 'JumpServer connection not found' }
      }

      recordShellSessionAttach(id, 'jumpserver')
      recordShellBridgeOpen(id, 'jumpserver')

      // Clear old listeners
      stream.removeAllListeners('data')

      let buffer = ''
      let flushTimer: NodeJS.Timeout | null = null
      let rawChunks: Buffer[] = []
      let rawBytes = 0
      const flushBuffer = () => {
        if (!buffer && rawBytes === 0) return
        const chunk = buffer
        buffer = ''
        const raw = rawBytes ? Buffer.concat(rawChunks, rawBytes) : undefined

        rawChunks = []
        rawBytes = 0
        if (raw) {
          recordShellBridgeDataForTransport(id, 'jumpserver', raw)
        }

        // Detect shell prompt for JumpServer connections that didn't send connectedToTarget
        // This handles mingyu-type connections where the target shell prompt arrives via main-shell stream
        if (!jumpserverConnectedToTargetSent.has(id) && SHELL_PROMPT_REGEX.test(chunk)) {
          jumpserverConnectedToTargetSent.add(id)
          const connData = jumpserverConnections.get(id)
          const jumpserverUuid = connData?.jumpserverUuid
          if (jumpserverUuid) {
            event.sender.send('jumpserver:status-update', {
              id: id,
              message: 'Successfully connected to target server, you can start operating',
              messageKey: 'ssh.jumpserver.connectedToTarget',
              type: 'success',
              timestamp: new Date().toLocaleTimeString()
            })
          }
        }

        event.sender.send(`ssh:shell:data:${id}`, { data: chunk, raw, marker: '' })
        flushTimer = null
      }

      const scheduleFlush = () => {
        // Clear existing timer to prevent multiple timers
        if (flushTimer) {
          clearTimeout(flushTimer)
        }

        const delay = getDelayByBufferSize(buffer.length)

        if (delay === 0) {
          // Send immediately for small data (likely user input)
          flushBuffer()
        } else {
          // Schedule delayed flush for larger data
          flushTimer = setTimeout(flushBuffer, delay)
        }
      }

      stream.on('data', (data) => {
        const dataStr = data.toString('utf8')
        const lastCommand = jumpserverLastCommand.get(id)
        const exitCommands = ['exit', 'logout', '\x04']

        const connData = jumpserverConnections.get(id)
        const shellProfile = connData?.navigationPath?.profile ?? 'standard'

        // JumpServer menu exit detection
        if (lastCommand && exitCommands.includes(lastCommand) && hasJumpServerCommandPrompt(dataStr, shellProfile)) {
          const exitCommand = getJumpServerExitCommand(shellProfile)
          jumpserverLastCommand.delete(id)
          recordShellSessionWrite(id, 'jumpserver', exitCommand + '\r', false, exitCommand)
          stream.write(exitCommand + '\r', (err) => {
            if (err) console.error(`[JumpServer ${id}] Failed to send "${exitCommand}":`, err)
            else console.log(`[JumpServer ${id}] Sent "${exitCommand}" to terminate session.`)
            stream.end()
            connData?.conn?.end()
          })
          return
        }

        const markedCmd = jumpserverMarkedCommands.get(id)
        if (markedCmd !== undefined) {
          if (markedCmd.marker === 'Chaterm:command') {
            recordShellBridgeDataForTransport(id, 'jumpserver', data)
            event.sender.send(`ssh:shell:data:${id}`, {
              data: dataStr,
              raw: data,
              marker: markedCmd.marker
            })
            return
          }
          markedCmd.output += dataStr
          markedCmd.rawChunks.push(data)
          markedCmd.rawBytes += data.length
          markedCmd.lastActivity = Date.now()
          if (markedCmd.idleTimer) clearTimeout(markedCmd.idleTimer)
          markedCmd.idleTimer = setTimeout(() => {
            if (markedCmd && !markedCmd.completed) {
              markedCmd.completed = true
              const markedRaw = markedCmd.rawBytes ? Buffer.concat(markedCmd.rawChunks, markedCmd.rawBytes) : undefined
              if (markedRaw) {
                recordShellBridgeDataForTransport(id, 'jumpserver', markedRaw)
              }
              event.sender.send(`ssh:shell:data:${id}`, {
                data: markedCmd.output,
                raw: markedRaw,
                marker: markedCmd.marker
              })
              jumpserverMarkedCommands.delete(id)
            }
          }, 200)
        } else {
          // Only add to shared buffer for non-marked data
          rawChunks.push(data)
          rawBytes += data.length
          buffer += dataStr
          scheduleFlush()
        }
      })

      stream.stderr.on('data', (data) => {
        recordShellBridgeStderrForTransport(id, 'jumpserver', data.toString('utf8'))
        event.sender.send(`ssh:shell:stderr:${id}`, data.toString('utf8'))
      })

      stream.on('close', () => {
        flushBuffer()
        recordShellBridgeCloseForTransport(id, 'jumpserver')
        recordShellSessionDetach(id, 'jumpserver')
        console.log(`JumpServer shell stream closed for id=${id}`)
        event.sender.send(`ssh:shell:close:${id}`)
        jumpserverShellStreams.delete(id)
        jumpserverConnectedToTargetSent.delete(id)
      })

      return { status: 'success', message: 'JumpServer Shell ready' }
    }

    const bastionShellResult = await shellBastionSession(event, id, terminalType)
    if (bastionShellResult !== null) {
      return bastionShellResult
    }

    // Default SSH shell handling
    const conn = sshConnections.get(id)
    if (!conn) {
      return { status: 'error', message: 'Not connected to the server' }
    }

    const transport: DebugTranscriptTransport = 'ssh'
    const termType = terminalType || 'vt100'
    const delayMs = 300
    const fallbackExecs = ['bash', 'sh']

    const isConnected = () => conn && conn['_sock'] && !conn['_sock'].destroyed

    const handleStream = (stream, method: 'shell' | 'exec') => {
      shellStreams.set(id, stream)
      recordShellSessionAttach(id, transport)
      recordShellReadyByTransport(id, transport, method)
      recordShellTranscriptForTransport(id, transport, stream, 'main-shell')

      let buffer = ''
      let flushTimer: NodeJS.Timeout | null = null
      let rawChunks: Buffer[] = []
      let rawBytes = 0
      const flushBuffer = () => {
        if (!buffer && rawBytes === 0) return

        const chunk = buffer
        buffer = ''

        const raw = rawBytes ? Buffer.concat(rawChunks, rawBytes) : undefined

        rawChunks = []
        rawBytes = 0
        if (raw) {
          recordShellBridgeDataForTransport(id, transport, raw)
        }
        event.sender.send(`ssh:shell:data:${id}`, { data: chunk, raw, marker: '' })
        flushTimer = null
      }

      const scheduleFlush = () => {
        // Clear existing timer to prevent multiple timers
        if (flushTimer) {
          clearTimeout(flushTimer)
        }

        const delay = getDelayByBufferSize(buffer.length)

        if (delay === 0) {
          // Send immediately for small data (likely user input)
          flushBuffer()
        } else {
          // Schedule delayed flush for larger data
          flushTimer = setTimeout(flushBuffer, delay)
        }
      }

      stream.on('data', (data) => {
        const markedCmd = markedCommands.get(id)
        const chunk = data.toString('utf8')

        if (markedCmd !== undefined) {
          markedCmd.output += chunk
          markedCmd.rawChunks.push(data)
          markedCmd.rawBytes += data.length
          markedCmd.lastActivity = Date.now()
          if (markedCmd.idleTimer) clearTimeout(markedCmd.idleTimer)
          markedCmd.idleTimer = setTimeout(() => {
            if (markedCmd && !markedCmd.completed) {
              markedCmd.completed = true
              const markedRaw = markedCmd.rawBytes ? Buffer.concat(markedCmd.rawChunks, markedCmd.rawBytes) : undefined
              if (markedRaw) {
                recordShellBridgeDataForTransport(id, transport, markedRaw)
              }
              event.sender.send(`ssh:shell:data:${id}`, {
                data: markedCmd.output,
                raw: markedRaw,
                marker: markedCmd.marker
              })
              markedCommands.delete(id)
            }
          }, 200)
        } else {
          // Only add to shared buffer for non-marked data
          rawChunks.push(data)
          rawBytes += data.length
          buffer += chunk
          scheduleFlush()
        }
      })

      stream.stderr?.on('data', (data) => {
        recordShellBridgeStderrForTransport(id, transport, data.toString('utf8'))
        event.sender.send(`ssh:shell:stderr:${id}`, data.toString('utf8'))
      })

      stream.on('close', () => {
        flushBuffer()
        recordShellBridgeCloseForTransport(id, transport)
        recordShellSessionDetach(id, transport)
        console.log(`Shell stream closed for id=${id} (${method})`)
        event.sender.send(`ssh:shell:close:${id}`)
        shellStreams.delete(id)
      })
    }

    const tryExecFallback = (execList: string[], resolve, reject) => {
      const [cmd, ...rest] = execList
      if (!cmd) {
        const shellError = new Error('shell and exec run failed')
        recordShellErrorByTransport(id, transport, shellError)
        return reject(shellError)
      }

      recordShellFallbackByTransport(id, transport, cmd, 'shell start failed, trying exec fallback')
      conn.exec(cmd, { pty: true }, (execErr, execStream) => {
        if (execErr) {
          console.warn(`[${id}] exec(${cmd}) Failed: ${execErr.message}`)
          recordShellErrorByTransport(id, transport, execErr)
          return tryExecFallback(rest, resolve, reject)
        }

        console.info(`[${id}] use exec(${cmd}) Successfully started the terminal`)
        handleStream(execStream, 'exec')
        resolve({ status: 'success', message: `The terminal has been started（exec:${cmd}）` })
      })
    }

    return new Promise((resolve, reject) => {
      if (!isConnected()) {
        const disconnectedError = new Error('Connection disconnected, unable to start terminal')
        recordShellErrorByTransport(id, transport, disconnectedError)
        return reject(disconnectedError)
      }

      setTimeout(() => {
        if (!isConnected()) {
          const delayedDisconnectError = new Error('The connection has been disconnected after a delay')
          recordShellErrorByTransport(id, transport, delayedDisconnectError)
          return reject(delayedDisconnectError)
        }

        recordShellBridgeReadyForTransport(id, transport)
        conn.shell({ term: termType }, (err, stream) => {
          if (err) {
            console.warn(`[${id}] shell() start error: ${err.message}`)
            recordShellErrorByTransport(id, transport, err)
            return tryExecFallback(fallbackExecs, resolve, reject)
          }

          console.info(`[${id}] shell() Successfully started`)
          handleStream(stream, 'shell')
          resolve({ status: 'success', message: 'Shell has started' })
        })
      }, delayMs)
    })
  })

  // Resize handling
  ipcMain.handle('ssh:shell:resize', async (_event, { id, cols, rows }) => {
    // Check if it's a JumpServer connection
    if (jumpserverConnections.has(id)) {
      const stream = jumpserverShellStreams.get(id)
      if (!stream) {
        return { status: 'error', message: 'JumpServer Shell not found' }
      }

      try {
        stream.setWindow(rows, cols, 0, 0)
        return { status: 'success', message: `JumpServer window size set to ${cols}x${rows}` }
      } catch (error: unknown) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }

    const bastionResizeResult = await resizeBastionSession(id, cols, rows)
    if (bastionResizeResult !== null) {
      return bastionResizeResult
    }

    // Default SSH handling
    const stream = shellStreams.get(id)
    if (!stream) {
      return { status: 'error', message: 'Shell not found' }
    }

    try {
      // Set SSH shell window size
      stream.setWindow(rows, cols, 0, 0)
      return { status: 'success', message: `Window size set to  ${cols}x${rows}` }
    } catch (error: unknown) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on('ssh:shell:write', (_event, { id, data, marker, lineCommand, isBinary }) => {
    // Check if it's a JumpServer connection
    if (jumpserverConnections.has(id)) {
      const stream = jumpserverShellStreams.get(id)
      if (stream) {
        recordShellWriteByTransport(id, 'jumpserver', data, !!isBinary, lineCommand)
        if (isBinary) {
          const buf = Buffer.from(data, 'binary')
          stream.write(buf)
        } else {
          // Use lineCommand for command detection, if not, fallback to data-trim()
          const command = lineCommand || data.trim()
          if (['exit', 'logout', '\x04'].includes(command)) {
            jumpserverLastCommand.set(id, command)
          } else {
            jumpserverLastCommand.delete(id)
          }
          if (jumpserverMarkedCommands.has(id)) {
            jumpserverMarkedCommands.delete(id)
          }
          if (marker) {
            jumpserverMarkedCommands.set(id, {
              marker,
              output: '',
              rawChunks: [] as Uint8Array[],
              rawBytes: 0,
              raw: [] as Uint8Array[],
              completed: false,
              lastActivity: Date.now(),
              idleTimer: null
            })
          }

          stream.write(data)
        }
      } else {
        console.warn('Attempting to write to non-existent JumpServer stream:', id)
      }
      return
    }

    if (writeBastionSession(id, data, marker, lineCommand, isBinary)) {
      return
    }

    // Default SSH handling
    const stream = shellStreams.get(id)
    if (stream) {
      recordShellWriteByTransport(id, 'ssh', data, !!isBinary, lineCommand)
      // console.log(`ssh:shell:write (default) raw data: "${data}"`)
      // For default SSH connections, don't detect exit commands, let terminal handle exit naturally
      if (markedCommands.has(id)) {
        markedCommands.delete(id)
      }
      if (marker) {
        markedCommands.set(id, {
          marker,
          output: '',
          rawChunks: [] as Uint8Array[],
          rawBytes: 0,
          raw: [] as Uint8Array[],
          completed: false,
          lastActivity: Date.now(),
          idleTimer: null
        })
      }

      if (isBinary) {
        const buf = Buffer.from(data, 'binary')
        stream.write(buf)
      } else {
        stream.write(data)
      }
    } else {
      console.warn('Attempting to write to non-existent stream:', id)
    }
  })

  /**
   * Execute command on JumpServer asset (simulate exec via shell stream)
   * @param id - Connection ID
   * @param cmd - Command to execute
   * @returns Execution result (compatible with standard exec format)
   */
  async function executeCommandOnJumpServerAsset(
    id: string,
    cmd: string
  ): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    exitSignal?: string
    error?: string
  }> {
    // Get or create dedicated exec stream (not user interaction stream)
    let execStream: any
    try {
      execStream = await createJumpServerExecStream(id)
    } catch (error) {
      return {
        success: false,
        error: `Failed to create exec stream: ${error instanceof Error ? error.message : String(error)}`,
        stdout: '',
        stderr: '',
        exitCode: undefined,
        exitSignal: undefined
      }
    }

    if (!execStream) {
      return {
        success: false,
        error: 'JumpServer exec stream not available',
        stdout: '',
        stderr: '',
        exitCode: undefined,
        exitSignal: undefined
      }
    }

    return new Promise((resolve) => {
      const timestamp = Date.now()
      const marker = `__CHATERM_EXEC_END_${timestamp}__`
      const exitCodeMarker = `__CHATERM_EXIT_CODE_${timestamp}__`
      let outputBuffer = ''
      let timeoutHandle: NodeJS.Timeout

      // Output listener
      const dataHandler = (data: Buffer) => {
        outputBuffer += data.toString('utf8')

        // End marker detected
        if (outputBuffer.includes(marker)) {
          cleanup()

          try {
            // Extract output content (remove command echo and markers)
            const lines = outputBuffer.split('\n')

            // Find command line position (command echo)
            const commandIndex = lines.findIndex((line) => line.trim().includes(cmd.trim()))

            // Find end marker position
            const markerIndex = lines.findIndex((line) => line.includes(marker))

            // Extract command output (between command line and marker)
            const outputLines = lines.slice(commandIndex + 1, markerIndex)
            const stdout = outputLines.join('\n').trim()

            // Extract exit code (from content after exitCodeMarker)
            const exitCodePattern = new RegExp(`${exitCodeMarker}(\\d+)`)
            const exitCodeMatch = outputBuffer.match(exitCodePattern)
            const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0

            resolve({
              success: exitCode === 0,
              stdout,
              stderr: '',
              exitCode,
              exitSignal: undefined
            })
          } catch (parseError) {
            // Return raw output on parse failure
            resolve({
              success: false,
              error: `Failed to parse command output: ${parseError}`,
              stdout: outputBuffer,
              stderr: '',
              exitCode: undefined,
              exitSignal: undefined
            })
          }
        }
      }

      // Cleanup function
      const cleanup = () => {
        execStream.removeListener('data', dataHandler)
        clearTimeout(timeoutHandle)
      }

      // Timeout protection (30 seconds)
      timeoutHandle = setTimeout(() => {
        cleanup()
        resolve({
          success: false,
          error: 'Command execution timeout (30s)',
          stdout: outputBuffer,
          stderr: '',
          exitCode: undefined,
          exitSignal: undefined
        })
      }, 30000)

      // Register listener
      execStream.on('data', dataHandler)

      // Send command (capture exit code)
      // Use bash trick: command; echo marker; echo exitcode_marker$?
      const fullCommand = `${cmd}; echo "${marker}"; echo "${exitCodeMarker}$?"\r`
      execStream.write(fullCommand)
    })
  }

  ipcMain.handle('ssh:conn:exec', async (_event, { id, cmd }) => {
    // Detect if it's a JumpServer connection, handle with priority
    if (jumpserverShellStreams.has(id)) {
      return executeCommandOnJumpServerAsset(id, cmd)
    }

    // Standard SSH connection handling
    const conn = sshConnections.get(id)
    if (!conn) {
      return {
        success: false,
        error: `No SSH connection for id=${id}`,
        stdout: '',
        stderr: '',
        exitCode: undefined,
        exitSignal: undefined
      }
    }

    return new Promise((resolve) => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          return resolve({
            success: false,
            error: err.message,
            stdout: '',
            stderr: '',
            exitCode: undefined,
            exitSignal: undefined
          })
        }

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let exitCode = undefined
        let exitSignal = undefined

        stream.on('data', (chunk) => {
          stdoutChunks.push(chunk)
        })

        stream.stderr.on('data', (chunk) => {
          stderrChunks.push(chunk)
        })

        stream.on('exit', (code, signal) => {
          exitCode = code ?? undefined
          exitSignal = signal ?? undefined
        })

        stream.on('close', (code, signal) => {
          const finalCode = exitCode !== undefined ? exitCode : code
          const finalSignal = exitSignal !== undefined ? exitSignal : signal

          const stdout = Buffer.concat(stdoutChunks).toString('utf8')
          const stderr = Buffer.concat(stderrChunks).toString('utf8')

          resolve({
            success: true,
            stdout,
            stderr,
            exitCode: finalCode ?? undefined,
            exitSignal: finalSignal ?? undefined
          })
        })

        // Handle stream errors
        stream.on('error', (streamErr) => {
          // Optimization: use same concatenation method on error
          const stdout = Buffer.concat(stdoutChunks).toString('utf8')
          const stderr = Buffer.concat(stderrChunks).toString('utf8')

          resolve({
            success: false,
            error: streamErr.message,
            stdout,
            stderr,
            exitCode: undefined,
            exitSignal: undefined
          })
        })
      })
    })
  })

  ipcMain.handle('ssh:disconnect', async (_event, { id }) => {
    // Check if it's a JumpServer connection
    if (jumpserverConnections.has(id)) {
      recordDisconnectRequestByTransport(id, 'jumpserver')
      const stream = jumpserverShellStreams.get(id)
      if (stream) {
        // For bastion hosts (JumpServer), we need to send exit command first
        // to properly notify the bastion that the session is closing.
        // Without this, the bastion may keep the session alive and next
        // connection will show "Reusing existing connection" message.
        try {
          stream.write('exit\r')
        } catch (e) {
          // Ignore write errors, proceed to close anyway
        }
        stream.end()
        jumpserverShellStreams.delete(id)
      }

      // Clean up exec stream
      const execStream = jumpserverExecStreams.get(id)
      if (execStream) {
        console.log(`Cleaning up JumpServer exec stream: ${id}`)
        execStream.end()
        jumpserverExecStreams.delete(id)
      }

      const connData = jumpserverConnections.get(id)
      if (connData) {
        const connToClose = connData.conn

        // Check if other sessions are using the same connection
        let isConnStillInUse = false
        for (const [otherId, otherData] of jumpserverConnections.entries()) {
          if (otherId !== id && otherData.conn === connToClose) {
            isConnStillInUse = true
            break
          }
        }

        // Only close underlying connection when no other sessions are using it
        if (!isConnStillInUse) {
          console.log(`[JumpServer] All sessions closed, releasing underlying connection: ${id}`)
          connToClose.end()
        } else {
          console.log(`[JumpServer] Session disconnected, but underlying connection still in use by other sessions: ${id}`)
        }
        cleanSftpConnection(id)
        jumpserverConnections.delete(id)
        jumpserverConnectionStatus.delete(id)
        return { status: 'success', message: 'JumpServer connection disconnected' }
      }

      return { status: 'warning', message: 'No active JumpServer connection' }
    }

    const bastionDisconnectResult = await disconnectBastionSession(id)
    if (bastionDisconnectResult !== null) {
      return bastionDisconnectResult
    }

    // Default SSH handling
    recordDisconnectRequestByTransport(id, 'ssh')
    const stream = shellStreams.get(id)
    if (stream) {
      stream.end()
      shellStreams.delete(id)
    }

    const conn = sshConnections.get(id)
    if (conn) {
      // Check if this connection is in the reuse pool
      let poolKey: string | null = null
      let reusableConn: ReusableConnection | null = null

      // Iterate through connection pool to find matching connection
      sshConnectionPool.forEach((value, key) => {
        if (value.conn === conn) {
          poolKey = key
          reusableConn = value
        }
      })

      if (poolKey && reusableConn) {
        // Remove current session from session set
        ;(reusableConn as ReusableConnection).sessions.delete(id)

        // If no other sessions are using this connection, close connection and clean up pool
        if ((reusableConn as ReusableConnection).sessions.size === 0) {
          console.log(`[SSH Connection Pool] All sessions closed, releasing connection: ${poolKey}`)
          recordConnectPoolCleanup(id, poolKey, 'close')
          conn.end()
          sshConnectionPool.delete(poolKey)
        }
      } else {
        // Regular connection not in reuse pool, close directly
        conn.end()
      }
      cleanSftpConnection(id)
      sshConnections.delete(id)
      sftpConnections.delete(id)
      return { status: 'success', message: 'Disconnected' }
    }
    return { status: 'warning', message: 'No active connection' }
  })

  ipcMain.handle('ssh:recordTerminalState', async (_event, params) => {
    const { id, state } = params

    const connection = sshConnections.get(id)
    if (connection) {
      connection.terminalState = state
    }
    return { success: true }
  })

  ipcMain.handle('ssh:recordCommand', async (_event, params) => {
    const { id, command, timestamp } = params

    // Record command
    const connection = sshConnections.get(id)
    if (connection) {
      if (!connection.commandHistory) {
        connection.commandHistory = []
      }
      connection.commandHistory.push({ command, timestamp })
    }
    return { success: true }
  })

  // Select File
  ipcMain.handle('dialog:open-file', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Select File',
      properties: ['openFile']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Select Directory
  ipcMain.handle('dialog:open-directory', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Select Directory',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:save-file', async (event, { fileName }) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Save the file to...',
      defaultPath: fileName,
      buttonLabel: 'Save',
      filters: [{ name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('ssh:agent:enable-and-configure', async (_event: any, { enabled }: { enabled: boolean }) => {
    const manager = SSHAgentManager.getInstance()

    try {
      const result = await manager.enableAgent(enabled)
      console.log('SSH Agent enabled:', result.SSH_AUTH_SOCK)
      return { success: true }
    } catch (error: any) {
      console.error('Error in agent:enable-and-configure:', error)
      return { success: false }
    }
  })

  ipcMain.handle('ssh:agent:add-key', async (_e, { keyData, passphrase, comment }) => {
    try {
      const manager = SSHAgentManager.getInstance()
      const keyId = await manager.addKey(keyData, passphrase, comment)
      return { success: true, keyId }
    } catch (error: any) {
      console.error('Error in agent:add-key:', error)
      return { success: false, error: error.message }
    }
  })
  ipcMain.handle('ssh:agent:remove-key', async (_e, { keyId }) => {
    try {
      const manager = SSHAgentManager.getInstance()
      const removeStatus = manager.removeKey(keyId)
      return { success: removeStatus }
    } catch (error: any) {
      console.error('Error in agent:add-key:', error)
      return { success: false, error: error.message }
    }
  })
  ipcMain.handle('ssh:agent:list-key', async (_e) => {
    try {
      const manager = SSHAgentManager.getInstance()
      const keyIdMapList = manager.listKeys()
      return { success: true, keys: keyIdMapList }
    } catch (error: any) {
      console.error('Error in agent:add-key:', error)
      return { success: false, error: error.message }
    }
  })
  ipcMain.handle('ssh:get-system-info', async (_event, { id }) => {
    try {
      const systemInfo = await getSystemInfo(id)
      return { success: true, data: systemInfo }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get system info'
      }
    }
  })

  // zmodem
  ipcMain.handle('zmodem:pickUploadFiles', async (evt) => {
    const win = require('electron').BrowserWindow.fromWebContents(evt.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (canceled) return []

    return filePaths.map((p) => ({
      name: path.basename(p),
      lastModified: fs.statSync(p).mtimeMs,
      data: new Uint8Array(fs.readFileSync(p))
    }))
  })

  ipcMain.handle('zmodem:pickSavePath', async (evt, defaultName) => {
    const win = require('electron').BrowserWindow.fromWebContents(evt.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName
    })
    return canceled ? null : filePath
  })

  const activeStreams = new Map()

  ipcMain.handle('zmodem:openStream', (_event, savePath) => {
    try {
      const stream = fs.createWriteStream(savePath)
      const streamId = Math.random().toString(36).slice(2)
      activeStreams.set(streamId, stream)
      return streamId
    } catch (err) {
      console.error('Failed to open stream:', err)
      return null
    }
  })

  ipcMain.handle('zmodem:writeChunk', (_event, streamId, chunk) => {
    const stream = activeStreams.get(streamId)
    if (stream) {
      stream.write(Buffer.from(chunk))
    }
  })

  ipcMain.handle('zmodem:closeStream', (_event, streamId) => {
    const stream = activeStreams.get(streamId)
    if (stream) {
      stream.end()
      activeStreams.delete(streamId)
    }
  })
}

const getSystemInfo = async (id: string): Promise<CommandGenerationContext> => {
  let conn = sshConnections.get(id)
  if (!conn) {
    const connData = jumpserverConnections.get(id)
    conn = connData?.conn
  }
  if (!conn) {
    throw new Error('No active SSH connection found')
  }

  // Detect shell type to use appropriate system info script
  const shellType = await detectShellType(id)

  // Platform-specific system information scripts
  const systemInfoScripts = {
    [ShellType.BASH]: `uname -a | sed 's/^/OS_VERSION:/' && echo "DEFAULT_SHELL:$SHELL" && echo "HOME_DIR:$HOME" && hostname | sed 's/^/HOSTNAME:/' && whoami | sed 's/^/USERNAME:/' && (sudo -n true 2>/dev/null && echo "SUDO_CHECK:has sudo permission" || echo "SUDO_CHECK:no sudo permission")`,
    [ShellType.POWERSHELL]:
      `Write-Host "OS_VERSION: $(Get-WmiObject -Class Win32_OperatingSystem).Caption $((Get-WmiObject -Class Win32_OperatingSystem).Version)"; ` +
      `Write-Host "DEFAULT_SHELL:PowerShell"; ` +
      `Write-Host "HOME_DIR:$env:USERPROFILE"; ` +
      `Write-Host "HOSTNAME:$env:COMPUTERNAME"; ` +
      `Write-Host "USERNAME:$env:USERNAME"; ` +
      `Write-Host "SUDO_CHECK:$(if (([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) { 'has sudo permission' } else { 'no sudo permission' })"`
  }

  const systemInfoScript = systemInfoScripts[shellType] || systemInfoScripts[ShellType.BASH]

  const inferPlatformFromOsVersion = (osVersion: string, shell: string): string => {
    const v = (osVersion || '').toLowerCase()
    if (shell.toLowerCase().includes('powershell')) return 'win32'
    if (v.includes('darwin')) return 'darwin'
    if (v.includes('linux')) return 'linux'
    if (v.includes('mingw') || v.includes('msys') || v.includes('cygwin')) return 'win32'
    if (v.includes('windows') || v.includes('microsoft')) return 'win32'
    return 'unknown'
  }

  return new Promise((resolve, reject) => {
    const ptyConfig = { pty: shellType !== ShellType.POWERSHELL }
    conn.exec(systemInfoScript, ptyConfig, (err, stream) => {
      if (err) {
        return reject(err)
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
      })

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8')
      })

      stream.on('close', () => {
        if (stderr) {
          return reject(new Error(stderr))
        }

        const lines = stdout.trim().split('\n')
        const result: CommandGenerationContext = {
          platform: 'unknown',
          shell: 'bash',
          osVersion: '',
          hostname: '',
          username: '',
          homeDir: '',
          sudoPermission: false
        }

        lines.forEach((line) => {
          if (line.startsWith('OS_VERSION:')) {
            result.osVersion = line.replace('OS_VERSION:', '')
          } else if (line.startsWith('DEFAULT_SHELL:')) {
            result.shell = line.replace('DEFAULT_SHELL:', '')
          } else if (line.startsWith('HOME_DIR:')) {
            result.homeDir = line.replace('HOME_DIR:', '')
          } else if (line.startsWith('HOSTNAME:')) {
            result.hostname = line.replace('HOSTNAME:', '')
          } else if (line.startsWith('USERNAME:')) {
            result.username = line.replace('USERNAME:', '')
          } else if (line.startsWith('SUDO_CHECK:')) {
            result.sudoPermission = line.includes('has sudo permission')
          }
        })

        result.platform = inferPlatformFromOsVersion(result.osVersion || '', result.shell || '')
        if (!result.shell) {
          result.shell = 'bash'
        }

        resolve(result)
      })
    })
  })
}

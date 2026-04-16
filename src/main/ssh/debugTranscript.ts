import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

export type DebugTranscriptTransport = 'ssh' | 'jumpserver' | 'mingyu'
export type DebugTranscriptSource = 'connection' | 'main-shell' | 'jumpserver-navigation' | 'secondary' | 'exec' | 'mfa' | 'mingyu-navigation'
export type DebugTranscriptActor = 'user' | 'system' | 'remote'
export type DebugTranscriptDirection = 'in' | 'out' | 'meta'
export type DebugTranscriptRedaction = 'none' | 'password' | 'mfa' | 'prompt_detected'

export interface DebugTranscriptEvent {
  rootSessionId: string
  sessionId?: string
  transport: DebugTranscriptTransport
  source: DebugTranscriptSource
  actor: DebugTranscriptActor
  event: string
  phase?: string
  direction?: DebugTranscriptDirection
  text?: string
  bytes?: number
  redacted?: DebugTranscriptRedaction
  noise?: boolean
  meta?: Record<string, unknown>
}

interface DebugTranscriptSession {
  rootSessionId: string
  filePath: string
  startAt: number
  seq: number
  queue: Promise<void>
  redactOutboundByPrompt: boolean
  fingerprintSalt: string
}

const transcriptSessions = new Map<string, DebugTranscriptSession>()
const transcriptDir = path.join(os.tmpdir(), 'chaterm-transcripts')
const promptRedactionPattern = /(password|passphrase|verification\s*code|one[-\s]*time|otp|token|验证码|动态码|口令|密码)/i
const sensitiveMetaKeys = new Set(['password', 'privateKey', 'passphrase', 'proxyPassword', 'verificationCode', 'responses'])

const sanitizeFileName = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)

const normalizeText = (text: string): string => {
  return Array.from(text)
    .map((char) => {
      if (char === '\n' || char === '\r' || char === '\t') {
        return char
      }

      const code = char.charCodeAt(0)
      if (code < 32 || code === 127) {
        return `\\u${code.toString(16).padStart(4, '0')}`
      }

      return char
    })
    .join('')
}

const sanitizeMeta = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMeta(item))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, innerValue] of Object.entries(value)) {
      result[key] = sensitiveMetaKeys.has(key) ? '<redacted:meta>' : sanitizeMeta(innerValue)
    }
    return result
  }

  if (typeof value === 'string') {
    return normalizeText(value)
  }

  return value
}

const hasFullWidthAt = (value: string) => value.includes('＠')
const hasAsciiAt = (value: string) => value.includes('@')
const hasFullWidthSpace = (value: string) => value.includes('\u3000')
const hasWhitespace = (value: string) => /\s|\u3000/u.test(value)
const hasNonAscii = (value: string) => /[^\u0000-\u007f]/u.test(value)
const hasZeroWidth = (value: string) => /[\u200B-\u200D\uFEFF]/u.test(value)

export interface SensitiveInputDiagnostics {
  fingerprint: string
  length: number
  byteLength: number
  containsAsciiAt: boolean
  containsFullWidthAt: boolean
  containsWhitespace: boolean
  containsFullWidthSpace: boolean
  containsNonAscii: boolean
  containsZeroWidth: boolean
  normalizedNfcChanged: boolean
  normalizedNfkcChanged: boolean
}

export const createSensitiveInputDiagnostics = (rootSessionId: string, value: string): SensitiveInputDiagnostics => {
  const session = ensureSession(rootSessionId, 'jumpserver')
  const normalizedValue = value ?? ''
  const fingerprint = crypto
    .createHash('sha256')
    .update(session.fingerprintSalt)
    .update('\u0000')
    .update(normalizedValue, 'utf8')
    .digest('hex')
    .slice(0, 16)

  return {
    fingerprint,
    length: normalizedValue.length,
    byteLength: Buffer.byteLength(normalizedValue, 'utf8'),
    containsAsciiAt: hasAsciiAt(normalizedValue),
    containsFullWidthAt: hasFullWidthAt(normalizedValue),
    containsWhitespace: hasWhitespace(normalizedValue),
    containsFullWidthSpace: hasFullWidthSpace(normalizedValue),
    containsNonAscii: hasNonAscii(normalizedValue),
    containsZeroWidth: hasZeroWidth(normalizedValue),
    normalizedNfcChanged: normalizedValue.normalize('NFC') !== normalizedValue,
    normalizedNfkcChanged: normalizedValue.normalize('NFKC') !== normalizedValue
  }
}

export const attachSensitiveInputDiagnostics = (
  rootSessionId: string,
  meta: Record<string, unknown> | undefined,
  fieldName: string,
  value: string
) => {
  return {
    ...(meta ?? {}),
    [fieldName]: createSensitiveInputDiagnostics(rootSessionId, value)
  }
}

export const isSensitiveInputDiagnostics = (value: unknown): value is SensitiveInputDiagnostics => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.length === 'number' &&
    typeof candidate.byteLength === 'number' &&
    typeof candidate.containsAsciiAt === 'boolean' &&
    typeof candidate.containsFullWidthAt === 'boolean' &&
    typeof candidate.containsWhitespace === 'boolean' &&
    typeof candidate.containsFullWidthSpace === 'boolean' &&
    typeof candidate.containsNonAscii === 'boolean' &&
    typeof candidate.containsZeroWidth === 'boolean' &&
    typeof candidate.normalizedNfcChanged === 'boolean' &&
    typeof candidate.normalizedNfkcChanged === 'boolean'
  )
}

export const getSensitiveInputDiagnostics = (value: unknown): SensitiveInputDiagnostics | null => {
  return isSensitiveInputDiagnostics(value) ? value : null
}

const enqueueWrite = (session: DebugTranscriptSession, payload: string) => {
  session.queue = session.queue
    .then(async () => {
      await fs.promises.mkdir(transcriptDir, { recursive: true })
      await fs.promises.appendFile(session.filePath, payload, 'utf8')
    })
    .catch((error) => {
      console.warn(`[Transcript] Failed to write transcript for ${session.rootSessionId}:`, error)
    })
}

const buildEventPayload = (session: DebugTranscriptSession, event: DebugTranscriptEvent) => {
  const payload = {
    v: 1,
    seq: ++session.seq,
    ts: new Date().toISOString(),
    relMs: Date.now() - session.startAt,
    rootSessionId: event.rootSessionId,
    sessionId: event.sessionId ?? event.rootSessionId,
    transport: event.transport,
    source: event.source,
    actor: event.actor,
    event: event.event,
    phase: event.phase,
    direction: event.direction ?? 'meta',
    text: event.text,
    bytes: event.bytes,
    redacted: event.redacted ?? 'none',
    noise: event.noise ?? false,
    meta: event.meta ? sanitizeMeta(event.meta) : undefined
  }

  return `${JSON.stringify(payload)}\n`
}

const ensureSession = (rootSessionId: string, transport: DebugTranscriptTransport): DebugTranscriptSession => {
  const existing = transcriptSessions.get(rootSessionId)
  if (existing) {
    return existing
  }

  const filePath = path.join(transcriptDir, `chaterm-${transport}-${Date.now()}-${sanitizeFileName(rootSessionId)}.ndjson`)
  const session: DebugTranscriptSession = {
    rootSessionId,
    filePath,
    startAt: Date.now(),
    seq: 0,
    queue: Promise.resolve(),
    redactOutboundByPrompt: false,
    fingerprintSalt: crypto.randomBytes(16).toString('hex')
  }

  transcriptSessions.set(rootSessionId, session)
  console.log(`[Transcript] ${rootSessionId}: ${filePath}`)
  return session
}

const applyRedaction = (session: DebugTranscriptSession, event: DebugTranscriptEvent): DebugTranscriptEvent => {
  const nextEvent = { ...event }
  const originalText = nextEvent.text ?? ''

  if (nextEvent.redacted === 'password') {
    nextEvent.text = '<redacted:password>'
    session.redactOutboundByPrompt = false
    return nextEvent
  }

  if (nextEvent.redacted === 'mfa') {
    nextEvent.text = '<redacted:mfa>'
    session.redactOutboundByPrompt = false
    return nextEvent
  }

  if (originalText && nextEvent.actor === 'remote' && nextEvent.direction === 'in' && promptRedactionPattern.test(originalText)) {
    session.redactOutboundByPrompt = true
  }

  if (originalText && nextEvent.actor === 'user' && nextEvent.direction === 'out' && session.redactOutboundByPrompt) {
    nextEvent.text = '<redacted:prompt-detected>'
    nextEvent.redacted = 'prompt_detected'
    if (/[\r\n]$/.test(originalText)) {
      session.redactOutboundByPrompt = false
    }
    return nextEvent
  }

  if (originalText) {
    nextEvent.text = normalizeText(originalText)
  }

  return nextEvent
}

export const ensureDebugTranscriptSession = (options: {
  rootSessionId: string
  transport: DebugTranscriptTransport
  source: DebugTranscriptSource
  meta?: Record<string, unknown>
}) => {
  const session = ensureSession(options.rootSessionId, options.transport)

  if (session.seq === 0) {
    const startEvent: DebugTranscriptEvent = {
      rootSessionId: options.rootSessionId,
      transport: options.transport,
      source: options.source,
      actor: 'system',
      event: 'session_start',
      direction: 'meta',
      meta: {
        filePath: session.filePath,
        ...options.meta
      }
    }
    enqueueWrite(session, buildEventPayload(session, startEvent))
  }

  return session.filePath
}

export const recordDebugTranscriptEvent = (event: DebugTranscriptEvent) => {
  const session = ensureSession(event.rootSessionId, event.transport)
  const sanitizedEvent = applyRedaction(session, event)
  enqueueWrite(session, buildEventPayload(session, sanitizedEvent))
}

export const getDebugTranscriptPath = (rootSessionId: string): string | undefined => {
  return transcriptSessions.get(rootSessionId)?.filePath
}

export const flushDebugTranscriptForTests = async (rootSessionId?: string) => {
  if (rootSessionId) {
    await transcriptSessions.get(rootSessionId)?.queue
    return
  }

  await Promise.all(Array.from(transcriptSessions.values()).map((session) => session.queue))
}

export const resetDebugTranscriptForTests = async () => {
  await flushDebugTranscriptForTests()
  const sessions = Array.from(transcriptSessions.values())
  transcriptSessions.clear()
  await Promise.all(
    sessions.map(async (session) => {
      try {
        await fs.promises.unlink(session.filePath)
      } catch {
        // ignore missing temp files in tests
      }
    })
  )
}

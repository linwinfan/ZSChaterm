import fs from 'fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureDebugTranscriptSession,
  flushDebugTranscriptForTests,
  getDebugTranscriptPath,
  recordDebugTranscriptEvent,
  resetDebugTranscriptForTests
} from '../debugTranscript'

const readTranscriptEvents = async (rootSessionId: string) => {
  await flushDebugTranscriptForTests(rootSessionId)
  const filePath = getDebugTranscriptPath(rootSessionId)

  expect(filePath).toBeTruthy()

  const content = await fs.readFile(filePath!, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

afterEach(async () => {
  await resetDebugTranscriptForTests()
})

describe('debugTranscript', () => {
  it('writes session start and redacts sensitive metadata', async () => {
    const rootSessionId = 'ssh-meta-session'
    const filePath = ensureDebugTranscriptSession({
      rootSessionId,
      transport: 'ssh',
      source: 'connection',
      meta: {
        host: 'example.internal',
        password: 'secret-password',
        privateKey: 'PRIVATE-KEY',
        nested: {
          responses: ['123456']
        }
      }
    })

    const events = await readTranscriptEvents(rootSessionId)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'session_start',
      transport: 'ssh',
      source: 'connection',
      meta: {
        filePath,
        host: 'example.internal',
        password: '<redacted:meta>',
        privateKey: '<redacted:meta>',
        nested: {
          responses: '<redacted:meta>'
        }
      }
    })
  })

  it('redacts prompt-driven outbound input and explicit passwords', async () => {
    const rootSessionId = 'ssh-redaction-session'

    ensureDebugTranscriptSession({
      rootSessionId,
      transport: 'ssh',
      source: 'mfa'
    })

    recordDebugTranscriptEvent({
      rootSessionId,
      transport: 'ssh',
      source: 'mfa',
      actor: 'remote',
      event: 'mfa_prompt',
      phase: 'connecting',
      direction: 'in',
      text: 'Password:'
    })

    recordDebugTranscriptEvent({
      rootSessionId,
      transport: 'ssh',
      source: 'mfa',
      actor: 'user',
      event: 'mfa_response',
      phase: 'connecting',
      direction: 'out',
      text: '654321\r'
    })

    recordDebugTranscriptEvent({
      rootSessionId,
      transport: 'ssh',
      source: 'main-shell',
      actor: 'user',
      event: 'write',
      phase: 'connected',
      direction: 'out',
      text: 'secret-password\r',
      redacted: 'password'
    })

    const events = await readTranscriptEvents(rootSessionId)
    const promptEvent = events.find((event) => event.event === 'mfa_prompt')
    const responseEvent = events.find((event) => event.event === 'mfa_response')
    const passwordEvent = events.find((event) => event.redacted === 'password')

    expect(promptEvent).toMatchObject({
      text: 'Password:',
      redacted: 'none'
    })
    expect(responseEvent).toMatchObject({
      text: '<redacted:prompt-detected>',
      redacted: 'prompt_detected'
    })
    expect(passwordEvent).toMatchObject({
      text: '<redacted:password>',
      redacted: 'password'
    })
  })
})

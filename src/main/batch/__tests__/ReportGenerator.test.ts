//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReportGenerator } from '../ReportGenerator'
import type { BatchTerminalResult } from '../types'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-batch-reports'
  }
}))

describe('ReportGenerator', () => {
  let reportGenerator: ReportGenerator

  beforeEach(() => {
    reportGenerator = new ReportGenerator()
  })

  describe('generate', () => {
    it('should generate HTML report with AI summary when summaries are provided', async () => {
      const results: BatchTerminalResult[] = [
        {
          id: 'test-result-1',
          runId: 'test-run-1',
          terminalId: 'term-1',
          terminalName: 'Test Terminal',
          status: 'success',
          output: 'Filesystem      Size  Used Avail Use%\n/dev/sda1       100G   71G   30G  71%',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now()
        }
      ]

      const summaries = new Map<string, string>()
      summaries.set('test-result-1', 'The disk usage shows 71% full on the main partition.')

      const { htmlPath } = await reportGenerator.generate('test-run-1', results, summaries, 'zh-CN')

      const fs = await import('fs/promises')
      const htmlContent = await fs.readFile(htmlPath, 'utf-8')

      expect(htmlContent).toContain('ai-summary')
      expect(htmlContent).toContain('AI总结')
      expect(htmlContent).toContain('The disk usage shows 71% full on the main partition.')
    })

    it('should generate HTML report without AI summary content when no summaries provided', async () => {
      const results: BatchTerminalResult[] = [
        {
          id: 'test-result-1',
          runId: 'test-run-1',
          terminalId: 'term-1',
          terminalName: 'Test Terminal',
          status: 'success',
          output: 'Filesystem      Size  Used Avail Use%',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now()
        }
      ]

      const { htmlPath } = await reportGenerator.generate('test-run-1', results, undefined, 'en-US')

      const fs = await import('fs/promises')
      const htmlContent = await fs.readFile(htmlPath, 'utf-8')

      // Check for actual AI summary content div, not just the CSS class
      expect(htmlContent).not.toContain('<div class="ai-summary">')
    })

    it('should generate JSON report with AI summary in each result', async () => {
      const results: BatchTerminalResult[] = [
        {
          id: 'test-result-1',
          runId: 'test-run-1',
          terminalId: 'term-1',
          terminalName: 'Test Terminal',
          status: 'success',
          output: 'Test output',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now()
        }
      ]

      const summaries = new Map<string, string>()
      summaries.set('test-result-1', 'This is a test summary.')

      const { jsonPath } = await reportGenerator.generate('test-run-1', results, summaries, 'en-US')

      const fs = await import('fs/promises')
      const jsonContent = await fs.readFile(jsonPath, 'utf-8')
      const jsonReport = JSON.parse(jsonContent)

      expect(jsonReport.results[0].aiSummary).toBe('This is a test summary.')
    })

    it('should handle AI summary with only whitespace characters', async () => {
      const results: BatchTerminalResult[] = [
        {
          id: 'test-result-1',
          runId: 'test-run-1',
          terminalId: 'term-1',
          terminalName: 'Test Terminal',
          status: 'success',
          output: 'Test output',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now()
        }
      ]

      // AI returns summary that starts with newlines (common issue)
      const summaries = new Map<string, string>()
      summaries.set('test-result-1', '\n\n\nDisk usage check completed.')

      const { htmlPath } = await reportGenerator.generate('test-run-1', results, summaries, 'zh-CN')

      const fs = await import('fs/promises')
      const htmlContent = await fs.readFile(htmlPath, 'utf-8')

      // The AI summary div should be present even with leading newlines
      expect(htmlContent).toContain('ai-summary')
      expect(htmlContent).toContain('AI总结')
    })

    it('should match result IDs correctly between results and summaries', async () => {
      const results: BatchTerminalResult[] = [
        {
          id: 'unique-id-123',
          runId: 'test-run-1',
          terminalId: 'term-1',
          terminalName: 'Test Terminal',
          status: 'success',
          output: 'Test output',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now()
        }
      ]

      const summaries = new Map<string, string>()
      summaries.set('unique-id-123', 'Summary for unique-id-123')

      const { htmlPath } = await reportGenerator.generate('test-run-1', results, summaries, 'en-US')

      const fs = await import('fs/promises')
      const htmlContent = await fs.readFile(htmlPath, 'utf-8')

      expect(htmlContent).toContain('ai-summary')
      expect(htmlContent).toContain('Summary for unique-id-123')
    })
  })
})

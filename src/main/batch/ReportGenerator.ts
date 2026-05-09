//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { BatchTerminalResult } from './types'
import { createLogger } from '@logging'

const logger = createLogger('batch.report')

export class ReportGenerator {
  private getReportsDir(): string {
    return path.join(app.getPath('userData'), 'batch-reports')
  }

  async generate(runId: string, results: BatchTerminalResult[]): Promise<{ jsonPath: string; htmlPath: string }> {
    await fs.mkdir(this.getReportsDir(), { recursive: true })

    const jsonPath = await this.buildJsonReport(runId, results)
    const htmlPath = await this.buildHtmlReport(runId, results)

    return { jsonPath, htmlPath }
  }

  private async buildJsonReport(runId: string, results: BatchTerminalResult[]): Promise<string> {
    const report = {
      runId,
      generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        success: results.filter((r) => r.status === 'success').length,
        failed: results.filter((r) => r.status === 'failed').length
      },
      results: results.map((r) => ({
        terminalId: r.terminalId,
        terminalName: r.terminalName,
        status: r.status,
        output: r.output,
        error: r.error,
        startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        duration: r.startedAt && r.finishedAt ? r.finishedAt - r.startedAt : null
      }))
    }

    const filePath = path.join(this.getReportsDir(), `${runId}.json`)
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8')
    logger.info('[ReportGenerator] JSON report generated', { filePath })
    return filePath
  }

  private async buildHtmlReport(runId: string, results: BatchTerminalResult[]): Promise<string> {
    const summary = {
      total: results.length,
      success: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length
    }

    const rowsHtml = results
      .map((r) => {
        const statusColor = r.status === 'success' ? '#52c41a' : r.status === 'failed' ? '#ff4d4f' : '#8c8c8c'
        const duration = r.startedAt && r.finishedAt ? `${r.finishedAt - r.startedAt}ms` : '-'
        return `
        <tr>
          <td>${r.terminalName}</td>
          <td style="color: ${statusColor}">${r.status}</td>
          <td>${duration}</td>
          <td><pre style="max-width: 400px; overflow: auto">${(r.output || r.error || '-').substring(0, 500)}</pre></td>
        </tr>
      `
      })
      .join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Batch Task Report - ${runId}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
    h1 { color: #333; }
    .summary { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .summary-item { display: inline-block; margin-right: 30px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f0f0f0; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Batch Task Report</h1>
  <div class="summary">
    <div class="summary-item"><strong>Run ID:</strong> ${runId}</div>
    <div class="summary-item"><strong>Generated:</strong> ${new Date().toLocaleString()}</div>
    <div class="summary-item"><strong>Total:</strong> ${summary.total}</div>
    <div class="summary-item"><strong>Success:</strong> ${summary.success}</div>
    <div class="summary-item"><strong>Failed:</strong> ${summary.failed}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Terminal</th>
        <th>Status</th>
        <th>Duration</th>
        <th>Output/Error</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`

    const filePath = path.join(this.getReportsDir(), `${runId}.html`)
    await fs.writeFile(filePath, html, 'utf-8')
    logger.info('[ReportGenerator] HTML report generated', { filePath })
    return filePath
  }
}

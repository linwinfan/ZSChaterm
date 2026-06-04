//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { BatchTerminalResult } from './types'
import { createLogger } from '@logging'

const logger = createLogger('batch.report')

// Simple HTML escape to avoid breaking the report layout when an
// operation target / output / error contains quotes, angle brackets, etc.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Simple markdown to HTML converter for AI summaries
function markdownToHtml(markdown: string): string {
  if (!markdown) return ''

  let html = markdown
    // Escape HTML special characters first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Headers (### to #)
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>')

  // Bold (**text**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Italic (*text*)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Lists (- item or * item)
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
  // Wrap consecutive <li> elements in <ul>
  html = html.replace(/(<li>.*<\/li>)\n(<li>)/g, '$1\n$2')
  html = html.replace(/(<li>.*<\/li>)(?!\n<li>)/g, '<ul>$1</ul>')
  html = html.replace(/<\/ul>\n<ul>/g, '\n')

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>')
  html = html.replace(/\n/g, '<br>')

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>'
  }

  return html
}

export class ReportGenerator {
  private getReportsDir(): string {
    return path.join(app.getPath('userData'), 'batch-reports')
  }

  async generate(
    runId: string,
    results: BatchTerminalResult[],
    summaries?: Map<string, string>,
    language?: string
  ): Promise<{ jsonPath: string; htmlPath: string }> {
    await fs.mkdir(this.getReportsDir(), { recursive: true })

    const jsonPath = await this.buildJsonReport(runId, results, summaries)
    const htmlPath = await this.buildHtmlReport(runId, results, summaries, language)

    return { jsonPath, htmlPath }
  }

  private async buildJsonReport(runId: string, results: BatchTerminalResult[], summaries?: Map<string, string>): Promise<string> {
    const report = {
      runId,
      generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        success: results.filter((r) => r.status === 'success').length,
        failed: results.filter((r) => r.status === 'failed').length
      },
      results: results.map((r) => ({
        id: r.id,
        terminalId: r.terminalId,
        terminalName: r.terminalName,
        status: r.status,
        output: r.output,
        error: r.error,
        operationId: r.operationId,
        operationType: r.operationType,
        operationTarget: r.operationTarget,
        aiSummary: summaries?.get(r.id) || null,
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

  private async buildHtmlReport(runId: string, results: BatchTerminalResult[], summaries?: Map<string, string>, language?: string): Promise<string> {
    logger.info('[ReportGenerator] buildHtmlReport called', { runId, resultCount: results.length, summaryCount: summaries?.size || 0, language })

    const lang = language || 'zh-CN'
    const isZh = lang === 'zh-CN' || lang === 'zh-TW'

    const labels = {
      title: isZh ? '批量任务报表' : 'Batch Task Report',
      runId: isZh ? '运行ID' : 'Run ID',
      generated: isZh ? '生成时间' : 'Generated',
      total: isZh ? '总计' : 'Total',
      success: isZh ? '成功' : 'Success',
      failed: isZh ? '失败' : 'Failed',
      terminal: isZh ? '终端' : 'Terminal',
      operation: isZh ? '操作类型' : 'Operation Type',
      content: isZh ? '操作内容' : 'Operation Content',
      status: isZh ? '状态' : 'Status',
      duration: isZh ? '耗时' : 'Duration',
      outputError: isZh ? '输出/错误' : 'Output/Error',
      aiSummary: isZh ? 'AI总结' : 'AI Summary'
    }

    const operationTypeLabel = (type: string | undefined): string => {
      if (type === 'script') return isZh ? '脚本' : 'Script'
      if (type === 'skill') return isZh ? 'AI 技能' : 'AI Skill'
      if (type === 'kb_script') return isZh ? '知识库脚本' : 'KB Script'
      if (type === 'legacy') return isZh ? '旧版(合并)' : 'Legacy'
      return type || '-'
    }

    const summary = {
      total: results.length,
      success: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length
    }

    const rowsHtml = results
      .map((r) => {
        const statusColor = r.status === 'success' ? '#52c41a' : r.status === 'failed' ? '#ff4d4f' : '#8c8c8c'
        const duration = r.startedAt && r.finishedAt ? `${r.finishedAt - r.startedAt}ms` : '-'
        const aiSummary = summaries?.get(r.id)
        // Clean up AI summary - remove leading/trailing whitespace and newlines
        const cleanedSummary = aiSummary?.replace(/^[\s\n]+|[\s\n]+$/g, '').trim()
        // Convert markdown to HTML for AI summary
        const summaryHtml = cleanedSummary ? markdownToHtml(cleanedSummary) : ''
        logger.info('[ReportGenerator] processing result', {
          resultId: r.id,
          terminalName: r.terminalName,
          operationType: r.operationType,
          operationTarget: r.operationTarget,
          hasAiSummary: !!aiSummary,
          aiSummaryLength: aiSummary?.length
        })
        // AI summary as separate column with rendered HTML
        const summaryCell = summaryHtml ? `<div class="ai-summary">${summaryHtml}</div>` : '-'
        const outputPreview = (r.output || r.error || '-').substring(0, 500)
        const opTypeLabel = operationTypeLabel(r.operationType)
        const opTarget = r.operationTarget ? escapeHtml(r.operationTarget) : '-'
        return `
        <tr>
          <td>${escapeHtml(r.terminalName)}</td>
          <td>${escapeHtml(opTypeLabel)}</td>
          <td class="op-content">${opTarget}</td>
          <td style="color: ${statusColor}">${r.status}</td>
          <td>${duration}</td>
          <td><pre style="max-width: 400px; overflow: auto">${escapeHtml(outputPreview)}</pre></td>
          <td>${summaryCell}</td>
        </tr>
      `
      })
      .join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${labels.title} - ${runId}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
    h1 { color: #333; }
    .summary { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .summary-item { display: inline-block; margin-right: 30px; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; white-space: normal; word-break: break-word; }
    th { background: #f0f0f0; }
    th:first-child, td:first-child { width: 12%; }
    th:nth-child(2), td:nth-child(2) { width: 8%; }
    th:nth-child(3), td:nth-child(3) { width: 20%; }
    th:nth-child(4), td:nth-child(4) { width: 8%; }
    th:nth-child(5), td:nth-child(5) { width: 8%; }
    th:nth-child(6), td:nth-child(6) { width: 24%; }
    th:nth-child(7), td:nth-child(7) { width: 20%; }
    pre { margin: 5px 0; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
    td.op-content { word-break: break-word; line-height: 1.45; }
    td.op-content code { background: transparent; padding: 0; font-family: inherit; font-size: inherit; }
    .ai-summary { background: #e6f7ff; padding: 10px; border-radius: 4px; border-left: 3px solid #1890ff; }
    .ai-summary h2, .ai-summary h3, .ai-summary h4 { margin: 0 0 8px 0; color: #333; }
    .ai-summary p { margin: 4px 0; }
    .ai-summary ul, .ai-summary ol { margin: 4px 0; padding-left: 20px; }
    .ai-summary li { margin: 2px 0; }
    .ai-summary code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
    .ai-summary pre { background: #f0f0f0; padding: 8px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${labels.title}</h1>
  <div class="summary">
    <div class="summary-item"><strong>${labels.runId}:</strong> ${runId}</div>
    <div class="summary-item"><strong>${labels.generated}:</strong> ${new Date().toLocaleString(lang)}</div>
    <div class="summary-item"><strong>${labels.total}:</strong> ${summary.total}</div>
    <div class="summary-item"><strong>${labels.success}:</strong> ${summary.success}</div>
    <div class="summary-item"><strong>${labels.failed}:</strong> ${summary.failed}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>${labels.terminal}</th>
        <th>${labels.operation}</th>
        <th>${labels.content}</th>
        <th>${labels.status}</th>
        <th>${labels.duration}</th>
        <th>${labels.outputError}</th>
        <th>${labels.aiSummary}</th>
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

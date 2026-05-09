//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { batchTaskManager } from './BatchTaskManager'
import { webSocketNotifier } from './WebSocketNotifier'
import { ReportGenerator } from './ReportGenerator'
import { remoteSshExec } from '../ssh/agentHandle'
import { createLogger } from '@logging'
import type { BatchTask, BatchTaskTerminal, TerminalSelector } from './types'

const logger = createLogger('batch.engine')

export class ExecutionEngine {
  private reportGenerator: ReportGenerator

  constructor() {
    this.reportGenerator = new ReportGenerator()
  }

  async execute(runId: string, task: BatchTask): Promise<void> {
    logger.info('[ExecutionEngine] Starting execution', { runId, taskId: task.id })

    const terminals = await this.resolveTerminals(task.terminals || [])
    if (terminals.length === 0) {
      logger.warn('[ExecutionEngine] No terminals resolved', { runId })
      batchTaskManager.updateRunProgress(runId, 0, 0, Date.now(), 'completed')
      webSocketNotifier.pushRunCompleted(runId, 0, 0, 0)
      return
    }

    const mode = task.executionMode
    const maxConcurrency = task.maxConcurrency || 5

    switch (mode) {
      case 'serial':
        await this.executeSerial(runId, task, terminals)
        break
      case 'parallel':
        await this.executeParallel(runId, task, terminals)
        break
      case 'limited':
        await this.executeLimited(runId, task, terminals, maxConcurrency)
        break
    }

    const results = batchTaskManager.getRunResults(runId)
    const completed = results.filter((r) => r.status === 'success').length
    const failed = results.filter((r) => r.status === 'failed').length
    const status = failed === 0 ? 'completed' : 'failed'

    const reportPaths = await this.reportGenerator.generate(runId, results)

    batchTaskManager.updateRunProgress(runId, completed, failed, Date.now(), status, reportPaths.jsonPath)
    webSocketNotifier.pushRunCompleted(runId, terminals.length, completed, failed)
    logger.info('[ExecutionEngine] Execution finished', { runId, status, completed, failed })
  }

  private async resolveTerminals(selectors: BatchTaskTerminal[]): Promise<{ id: string; name: string }[]> {
    const terminals: { id: string; name: string }[] = []

    for (const sel of selectors) {
      try {
        const selector: TerminalSelector = JSON.parse(sel.selector)

        if (selector.type === 'active') {
          // Placeholder: active terminal resolution requires integration with terminal session management
          logger.info('[ExecutionEngine] Active terminal selector - requires session integration', { selector })
        } else if (selector.type === 'asset') {
          // Placeholder: asset list resolution requires integration with asset service
          logger.info('[ExecutionEngine] Asset selector - requires asset service integration', { selector })
        } else if (selector.type === 'template') {
          // Placeholder: template variable resolution
          logger.info('[ExecutionEngine] Template selector - not yet implemented', { selector })
        }
      } catch (error) {
        logger.error('[ExecutionEngine] Failed to parse selector', { error: error instanceof Error ? error.message : String(error) })
      }
    }

    return terminals
  }

  private async executeSerial(runId: string, task: BatchTask, terminals: { id: string; name: string }[]): Promise<void> {
    for (const terminal of terminals) {
      if (this.isRunCancelled(runId)) break
      await this.executeOnTerminal(runId, terminal, task)
    }
  }

  private async executeParallel(runId: string, task: BatchTask, terminals: { id: string; name: string }[]): Promise<void> {
    await Promise.all(terminals.map((t) => this.executeOnTerminal(runId, t, task)))
  }

  private async executeLimited(runId: string, task: BatchTask, terminals: { id: string; name: string }[], maxConcurrency: number): Promise<void> {
    const chunks: { id: string; name: string }[][] = []
    for (let i = 0; i < terminals.length; i += maxConcurrency) {
      chunks.push(terminals.slice(i, i + maxConcurrency))
    }
    for (const chunk of chunks) {
      if (this.isRunCancelled(runId)) break
      await Promise.all(chunk.map((t) => this.executeOnTerminal(runId, t, task)))
    }
  }

  private isRunCancelled(runId: string): boolean {
    const run = batchTaskManager.getRun(runId)
    return run?.status === 'cancelled'
  }

  private async executeOnTerminal(runId: string, terminal: { id: string; name: string }, task: BatchTask): Promise<void> {
    const result = batchTaskManager.createTerminalResult(runId, terminal.id, terminal.name)
    webSocketNotifier.pushTerminalStarted(runId, terminal.id)

    try {
      let allOutput = ''
      const operations = (task.operations || []).sort((a, b) => a.executionOrder - b.executionOrder)

      for (const op of operations) {
        try {
          const config = JSON.parse(op.operationConfig)

          if (op.operationType === 'script') {
            const output = await this.executeScript(terminal.id, config.scriptContent || '')
            allOutput += output
            webSocketNotifier.pushTerminalOutput(runId, terminal.id, output)
          } else if (op.operationType === 'skill') {
            // Placeholder: AI skill execution requires SkillsManager integration
            allOutput += `[Skill ${config.skillId}] - skill execution not yet implemented\n`
          } else if (op.operationType === 'kb_script') {
            // Placeholder: KB script execution requires KB service integration
            allOutput += `[KB Script ${config.kbPath}] - KB script execution not yet implemented\n`
          }
        } catch (parseError) {
          logger.error('[ExecutionEngine] Failed to parse operation config', {
            error: parseError instanceof Error ? parseError.message : String(parseError)
          })
        }
      }

      batchTaskManager.updateTerminalResult(result.id, 'success', allOutput)
      webSocketNotifier.pushTerminalCompleted(runId, terminal.id, 'success')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      batchTaskManager.updateTerminalResult(result.id, 'failed', undefined, errMsg)
      webSocketNotifier.pushTerminalCompleted(runId, terminal.id, 'failed', errMsg)
    }

    const results = batchTaskManager.getRunResults(runId)
    const completed = results.filter((r) => r.status === 'success').length
    const failed = results.filter((r) => r.status === 'failed').length
    batchTaskManager.updateRunProgress(runId, completed, failed)
    webSocketNotifier.pushRunProgress(runId, task.terminals?.length || 0, completed, failed)
  }

  private async executeScript(sessionId: string, script: string): Promise<string> {
    try {
      const result = await remoteSshExec(sessionId, script)
      if (result.error) {
        throw new Error(result.error)
      }
      return result.output || ''
    } catch (error) {
      logger.error('[ExecutionEngine] Script execution failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

export const executionEngine = new ExecutionEngine()

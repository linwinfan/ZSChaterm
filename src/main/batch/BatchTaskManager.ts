//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { randomUUID } from 'crypto'
import { ChatermDatabaseService } from '../storage/db/chaterm.service'
import type { BatchTask, BatchTaskRun, BatchTerminalResult, ExecutionMode } from './types'
import { createLogger } from '@logging'

const logger = createLogger('batch.taskManager')

export class BatchTaskManager {
  createTask(config: Omit<BatchTask, 'id' | 'createdAt' | 'updatedAt'>): BatchTask {
    const db = ChatermDatabaseService.getDatabaseSync()
    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO batch_tasks (id, name, description, trigger_type, cron_expression, cron_display, execution_mode, max_concurrency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      config.name,
      config.description || null,
      config.triggerType || 'manual',
      config.cronExpression || null,
      config.cronDisplay || null,
      config.executionMode || 'serial',
      config.maxConcurrency || 5,
      now,
      now
    )

    if (config.terminals) {
      for (const t of config.terminals) {
        db.prepare(
          `
          INSERT INTO batch_task_terminals (id, task_id, selector_type, selector)
          VALUES (?, ?, ?, ?)
        `
        ).run(randomUUID(), id, t.selectorType, t.selector)
      }
    }

    if (config.operations) {
      for (const op of config.operations) {
        db.prepare(
          `
          INSERT INTO batch_task_operations (id, task_id, operation_type, operation_config, execution_order)
          VALUES (?, ?, ?, ?, ?)
        `
        ).run(randomUUID(), id, op.operationType, op.operationConfig, op.executionOrder)
      }
    }

    logger.info('[BatchTaskManager] Created task', { taskId: id, name: config.name })
    return this.getTask(id)!
  }

  updateTask(id: string, config: Partial<BatchTask>): void {
    const db = ChatermDatabaseService.getDatabaseSync()
    const now = Date.now()

    const fields: string[] = ['updated_at = ?']
    const values: (string | number)[] = [now]

    if (config.name !== undefined) {
      fields.push('name = ?')
      values.push(config.name)
    }
    if (config.description !== undefined) {
      fields.push('description = ?')
      values.push(config.description || '')
    }
    if (config.triggerType !== undefined) {
      fields.push('trigger_type = ?')
      values.push(config.triggerType)
    }
    if (config.cronExpression !== undefined) {
      fields.push('cron_expression = ?')
      values.push(config.cronExpression || '')
    }
    if (config.cronDisplay !== undefined) {
      fields.push('cron_display = ?')
      values.push(config.cronDisplay || '')
    }
    if (config.executionMode !== undefined) {
      fields.push('execution_mode = ?')
      values.push(config.executionMode)
    }
    if (config.maxConcurrency !== undefined) {
      fields.push('max_concurrency = ?')
      values.push(config.maxConcurrency)
    }

    values.push(id)
    db.prepare(`UPDATE batch_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)

    if (config.terminals !== undefined) {
      db.prepare('DELETE FROM batch_task_terminals WHERE task_id = ?').run(id)
      for (const t of config.terminals) {
        db.prepare(`INSERT INTO batch_task_terminals (id, task_id, selector_type, selector) VALUES (?, ?, ?, ?)`).run(
          randomUUID(),
          id,
          t.selectorType,
          t.selector
        )
      }
    }

    if (config.operations !== undefined) {
      db.prepare('DELETE FROM batch_task_operations WHERE task_id = ?').run(id)
      for (const op of config.operations) {
        db.prepare(`INSERT INTO batch_task_operations (id, task_id, operation_type, operation_config, execution_order) VALUES (?, ?, ?, ?, ?)`).run(
          randomUUID(),
          id,
          op.operationType,
          op.operationConfig,
          op.executionOrder
        )
      }
    }

    logger.info('[BatchTaskManager] Updated task', { taskId: id })
  }

  deleteTask(id: string): void {
    const db = ChatermDatabaseService.getDatabaseSync()
    db.prepare('DELETE FROM batch_tasks WHERE id = ?').run(id)
    logger.info('[BatchTaskManager] Deleted task', { taskId: id })
  }

  getTask(id: string): BatchTask | null {
    const db = ChatermDatabaseService.getDatabaseSync()
    const row = db.prepare('SELECT * FROM batch_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null

    const terminals = db.prepare('SELECT * FROM batch_task_terminals WHERE task_id = ?').all(id) as Record<string, unknown>[]
    const operations = db.prepare('SELECT * FROM batch_task_operations WHERE task_id = ? ORDER BY execution_order').all(id) as Record<
      string,
      unknown
    >[]

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      triggerType: row.trigger_type as BatchTask['triggerType'],
      cronExpression: row.cron_expression as string | undefined,
      cronDisplay: row.cron_display as string | undefined,
      executionMode: row.execution_mode as ExecutionMode,
      maxConcurrency: row.max_concurrency as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      terminals: terminals.map((t) => ({
        id: t.id as string,
        taskId: t.task_id as string,
        selectorType: t.selector_type as import('./types').SelectorType,
        selector: t.selector as string
      })),
      operations: operations.map((op) => ({
        id: op.id as string,
        taskId: op.task_id as string,
        operationType: op.operation_type as import('./types').OperationType,
        operationConfig: op.operation_config as string,
        executionOrder: op.execution_order as number
      }))
    }
  }

  listTasks(): BatchTask[] {
    const db = ChatermDatabaseService.getDatabaseSync()
    const rows = db.prepare('SELECT id FROM batch_tasks ORDER BY updated_at DESC').all() as { id: string }[]
    return rows.map((r) => this.getTask(r.id)!).filter((t): t is BatchTask => t !== null)
  }

  createRun(taskId: string, totalTerminals: number, executionMode: ExecutionMode): BatchTaskRun {
    const db = ChatermDatabaseService.getDatabaseSync()
    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO batch_task_runs (id, task_id, started_at, status, total_terminals, execution_mode)
      VALUES (?, ?, ?, 'running', ?, ?)
    `
    ).run(id, taskId, now, totalTerminals, executionMode)

    return {
      id,
      taskId,
      startedAt: now,
      status: 'running',
      totalTerminals,
      completedTerminals: 0,
      failedTerminals: 0,
      executionMode
    }
  }

  updateRunProgress(runId: string, completed: number, failed: number, finishedAt?: number, status?: string, reportPath?: string): void {
    const db = ChatermDatabaseService.getDatabaseSync()
    if (finishedAt !== undefined) {
      db.prepare(
        `
        UPDATE batch_task_runs SET completed_terminals = ?, failed_terminals = ?, finished_at = ?, status = ?, report_path = ?
        WHERE id = ?
      `
      ).run(completed, failed, finishedAt, status || 'running', reportPath || null, runId)
    } else {
      db.prepare(
        `
        UPDATE batch_task_runs SET completed_terminals = ?, failed_terminals = ?
        WHERE id = ?
      `
      ).run(completed, failed, runId)
    }
  }

  cancelRun(runId: string): void {
    const db = ChatermDatabaseService.getDatabaseSync()
    const now = Date.now()
    db.prepare(
      `
      UPDATE batch_task_runs SET status = 'cancelled', finished_at = ?
      WHERE id = ? AND status = 'running'
    `
    ).run(now, runId)
    logger.info('[BatchTaskManager] Cancelled run', { runId })
  }

  getRun(runId: string): BatchTaskRun | null {
    const db = ChatermDatabaseService.getDatabaseSync()
    const row = db.prepare('SELECT * FROM batch_task_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      startedAt: row.started_at as number,
      finishedAt: row.finished_at as number | undefined,
      status: row.status as BatchTaskRun['status'],
      totalTerminals: row.total_terminals as number,
      completedTerminals: row.completed_terminals as number,
      failedTerminals: row.failed_terminals as number,
      executionMode: row.execution_mode as ExecutionMode,
      reportPath: row.report_path as string | undefined
    }
  }

  createTerminalResult(runId: string, terminalId: string, terminalName: string): BatchTerminalResult {
    const db = ChatermDatabaseService.getDatabaseSync()
    const id = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO batch_terminal_results (id, run_id, terminal_id, terminal_name, status, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)
    `
    ).run(id, runId, terminalId, terminalName, now)

    return { id, runId, terminalId, terminalName, status: 'running', startedAt: now }
  }

  updateTerminalResult(id: string, status: string, output?: string, error?: string): void {
    const db = ChatermDatabaseService.getDatabaseSync()
    const finishedAt = Date.now()
    db.prepare(
      `
      UPDATE batch_terminal_results SET status = ?, output = ?, error = ?, finished_at = ?
      WHERE id = ?
    `
    ).run(status, output || null, error || null, finishedAt, id)
  }

  getRunResults(runId: string): BatchTerminalResult[] {
    const db = ChatermDatabaseService.getDatabaseSync()
    const rows = db.prepare('SELECT * FROM batch_terminal_results WHERE run_id = ?').all(runId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      terminalId: r.terminal_id as string,
      terminalName: r.terminal_name as string,
      status: r.status as BatchTerminalResult['status'],
      startedAt: r.started_at as number | undefined,
      finishedAt: r.finished_at as number | undefined,
      output: r.output as string | undefined,
      error: r.error as string | undefined
    }))
  }

  getScheduledTasks(): BatchTask[] {
    const db = ChatermDatabaseService.getDatabaseSync()
    const rows = db.prepare("SELECT id FROM batch_tasks WHERE trigger_type = 'scheduled'").all() as { id: string }[]
    return rows.map((r) => this.getTask(r.id)!).filter((t): t is BatchTask => t !== null)
  }
}

export const batchTaskManager = new BatchTaskManager()

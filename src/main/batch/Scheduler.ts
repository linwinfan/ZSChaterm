//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { batchTaskManager } from './BatchTaskManager'
import { executionEngine } from './ExecutionEngine'
import { createLogger } from '@logging'

const logger = createLogger('batch.scheduler')

export class Scheduler {
  private intervalId: NodeJS.Timeout | null = null
  private readonly POLL_INTERVAL_MS = 60000 // Poll every minute

  start(): void {
    if (this.intervalId) {
      logger.warn('[Scheduler] Already started')
      return
    }

    this.intervalId = setInterval(() => {
      this.checkScheduledTasks()
    }, this.POLL_INTERVAL_MS)

    logger.info('[Scheduler] Started with poll interval', { intervalMs: this.POLL_INTERVAL_MS })
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      logger.info('[Scheduler] Stopped')
    }
  }

  private checkScheduledTasks(): void {
    try {
      const tasks = batchTaskManager.getScheduledTasks()

      for (const task of tasks) {
        if (!task.cronExpression) continue

        // Placeholder: proper cron parsing requires cron-parser package
        // For now, scheduled tasks are triggered on each poll if not yet executed
        // A full implementation would track last execution time and compare against cron schedule
        logger.debug('[Scheduler] Checking scheduled task', { taskId: task.id, taskName: task.name })
      }
    } catch (error) {
      logger.error('[Scheduler] Error checking scheduled tasks', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  triggerTask(taskId: string): void {
    const task = batchTaskManager.getTask(taskId)
    if (!task) {
      logger.warn('[Scheduler] Task not found', { taskId })
      return
    }

    const terminals = task.terminals || []
    const run = batchTaskManager.createRun(taskId, terminals.length, task.executionMode)

    // Execute asynchronously, don't await
    executionEngine.execute(run.id, task).catch((error) => {
      logger.error('[Scheduler] Execution failed', { runId: run.id, error: error instanceof Error ? error.message : String(error) })
    })
  }
}

export const scheduler = new Scheduler()

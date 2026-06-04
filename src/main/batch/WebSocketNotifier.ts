//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import type { BrowserWindow } from 'electron'
import type { BatchProgressEvent } from './types'
import { createLogger } from '@logging'

const logger = createLogger('batch.ws')

const BATCH_CHANNEL = 'batch:progress'

export class WebSocketNotifier {
  private mainWindow: BrowserWindow | null = null

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  push(event: BatchProgressEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      logger.debug('[WebSocketNotifier] No main window, skipping push', { type: event.type })
      return
    }

    try {
      this.mainWindow.webContents.send(BATCH_CHANNEL, event)
    } catch (error) {
      logger.error('[WebSocketNotifier] Failed to push event', { error: error instanceof Error ? error.message : String(error), type: event.type })
    }
  }

  pushTerminalStarted(runId: string, terminalId: string): void {
    this.push({ type: 'terminal_started', runId, terminalId, status: 'running' })
  }

  pushTerminalOutput(runId: string, terminalId: string, output: string): void {
    this.push({ type: 'terminal_output', runId, terminalId, output })
  }

  pushTerminalCompleted(runId: string, terminalId: string, status: 'success' | 'failed', error?: string): void {
    this.push({ type: 'terminal_completed', runId, terminalId, status, error })
  }

  pushRunProgress(runId: string, total: number, completed: number, failed: number): void {
    this.push({ type: 'run_progress', runId, progress: { total, completed, failed } })
  }

  pushRunCompleted(runId: string, total: number, completed: number, failed: number): void {
    this.push({ type: 'run_completed', runId, progress: { total, completed, failed } })
  }

  pushError(runId: string, error: string): void {
    this.push({ type: 'error', runId, error })
  }
}

export const webSocketNotifier = new WebSocketNotifier()

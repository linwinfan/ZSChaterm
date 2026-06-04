//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

export type TriggerType = 'manual' | 'scheduled'
export type ExecutionMode = 'serial' | 'parallel' | 'limited'
export type SelectorType = 'active' | 'asset' | 'template'
export type OperationType = 'skill' | 'script' | 'kb_script'
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type TerminalStatus = 'pending' | 'running' | 'success' | 'failed'

export interface TerminalSelector {
  type: SelectorType
  ids?: string[]
  expr?: string
  // Display metadata for active terminals. Optional for backward compatibility
  // with selectors persisted before this field existed; when missing, the main
  // process falls back to using the raw connectionId as the displayed name.
  terminals?: Array<{ id: string; title: string; ip?: string }>
}

export interface OperationConfig {
  skillId?: string
  scriptContent?: string
  kbPath?: string
}

export interface BatchTask {
  id: string
  name: string
  description?: string
  triggerType: TriggerType
  cronExpression?: string
  cronDisplay?: string
  executionMode: ExecutionMode
  maxConcurrency: number
  createdAt: number
  updatedAt: number
  terminals?: BatchTaskTerminal[]
  operations?: BatchTaskOperation[]
}

export interface BatchTaskTerminal {
  id: string
  taskId: string
  selectorType: SelectorType
  selector: string
}

export interface BatchTaskOperation {
  id: string
  taskId: string
  operationType: OperationType
  operationConfig: string
  executionOrder: number
}

export interface BatchTaskRun {
  id: string
  taskId: string
  startedAt: number
  finishedAt?: number
  status: RunStatus
  totalTerminals: number
  completedTerminals: number
  failedTerminals: number
  executionMode: ExecutionMode
  reportPath?: string
}

export interface BatchTerminalResult {
  id: string
  runId: string
  terminalId: string
  terminalName: string
  status: TerminalStatus
  startedAt?: number
  finishedAt?: number
  output?: string
  error?: string
  // Per-operation metadata. The execution engine creates one
  // BatchTerminalResult row per (terminal, operation) pair; legacy rows
  // (one per terminal) carry `operation_type = 'legacy'`.
  operationId?: string
  operationType?: 'script' | 'skill' | 'kb_script' | 'legacy'
  operationTarget?: string
}

export interface BatchProgressEvent {
  type: 'terminal_started' | 'terminal_output' | 'terminal_completed' | 'run_progress' | 'run_completed' | 'error'
  runId: string
  terminalId?: string
  status?: TerminalStatus
  output?: string
  progress?: { total: number; completed: number; failed: number }
  error?: string
}

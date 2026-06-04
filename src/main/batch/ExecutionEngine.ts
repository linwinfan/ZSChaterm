//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import * as fs from 'fs/promises'
import * as path from 'path'
import { batchTaskManager } from './BatchTaskManager'
import { webSocketNotifier } from './WebSocketNotifier'
import { ReportGenerator } from './ReportGenerator'
import { remoteSshExec, remoteSshConnect } from '../ssh/agentHandle'
import { sshConnections } from '../ssh/sshHandle'
import { jumpserverConnections } from '../ssh/jumpserver/state'
import { createJumpServerExecStream, executeCommandOnJumpServerExec } from '../ssh/jumpserver/streamManager'
import { getBastionSessionType } from '../ssh/bastionPlugin'
import { capabilityRegistry } from '../ssh/capabilityRegistry'
import { createLogger } from '@logging'
import { ChatermDatabaseService } from '../storage/database'
import { getAllExtensionState } from '../agent/core/storage/state'
import { buildApiHandler } from '../agent/api'
import { Anthropic } from '@anthropic-ai/sdk'
import { getKnowledgeBaseRoot } from '../services/knowledgebase'
import type { BatchTask, BatchTaskTerminal, BatchTerminalResult, TerminalSelector } from './types'
import type { ConnectionInfo } from '../agent/integrations/remote-terminal'

const logger = createLogger('batch.engine')

interface ResolvedTerminal {
  id: string
  name: string
  connected: boolean
  error?: string
  // Where this session lives in the main process. 'asset' is the legacy value for
  // connections created on the fly by `remoteSshConnect`; the active selector now
  // also yields 'direct-ssh' / 'jumpserver' / 'bastion:<type>' entries.
  kind?: 'asset' | 'direct-ssh' | 'jumpserver' | `bastion:${string}`
}

export class ExecutionEngine {
  private reportGenerator: ReportGenerator

  constructor() {
    this.reportGenerator = new ReportGenerator()
  }

  async execute(runId: string, task: BatchTask, overrideTerminals?: BatchTaskTerminal[]): Promise<void> {
    logger.info('[ExecutionEngine] Starting execution', { runId, taskId: task.id, taskName: task.name, hasOverride: !!overrideTerminals })

    // Caller (IPC handler) can pass an override terminal set (e.g. the user
    // edited the selection in the ExecuteConfirmView). Fall back to the
    // terminals persisted on the task otherwise.
    const configuredTerminals = overrideTerminals && overrideTerminals.length > 0 ? overrideTerminals : task.terminals || []

    const resolved = await this.resolveTerminals(configuredTerminals)
    const connectedTerminals = resolved.filter((t) => t.connected)
    logger.info('[ExecutionEngine] Terminals resolved', {
      runId,
      totalAttempted: resolved.length,
      connectedCount: connectedTerminals.length,
      failedCount: resolved.length - connectedTerminals.length,
      failed: resolved.filter((t) => !t.connected).map((t) => ({ name: t.name, error: t.error }))
    })

    // Case 1: task 未配置任何 terminal —— 合法的"空运行"，保持 completed
    if (configuredTerminals.length === 0) {
      logger.info('[ExecutionEngine] No terminals configured for this task, marking as completed', { runId })
      batchTaskManager.updateRunProgress(runId, 0, 0, Date.now(), 'completed')
      webSocketNotifier.pushRunCompleted(runId, 0, 0, 0)
      return
    }

    // Case 2: 配置了 terminal 但全部连接失败 —— 标 failed 并写失败记录
    if (connectedTerminals.length === 0) {
      logger.warn('[ExecutionEngine] All terminal connections failed, marking run as failed', { runId, attempted: resolved.length })
      const finishedAt = Date.now()
      for (const t of resolved) {
        try {
          const result = batchTaskManager.createTerminalResult(runId, '', t.name)
          batchTaskManager.updateTerminalResult(result.id, 'failed', undefined, t.error || 'Unknown connection error')
        } catch (err) {
          logger.error('[ExecutionEngine] Failed to record failed terminal result', { runId, terminalName: t.name, error: err })
        }
      }
      batchTaskManager.updateRunProgress(runId, 0, resolved.length, finishedAt, 'failed')
      webSocketNotifier.pushRunCompleted(runId, resolved.length, 0, resolved.length)
      return
    }

    // Case 3: 至少有一个连接成功 —— 同时记录失败的尝试，再正常执行
    for (const t of resolved) {
      if (!t.connected) {
        try {
          const result = batchTaskManager.createTerminalResult(runId, '', t.name)
          batchTaskManager.updateTerminalResult(result.id, 'failed', undefined, t.error || 'Unknown connection error')
        } catch (err) {
          logger.error('[ExecutionEngine] Failed to record failed terminal result', { runId, terminalName: t.name, error: err })
        }
      }
    }

    const mode = task.executionMode
    const maxConcurrency = task.maxConcurrency || 5

    switch (mode) {
      case 'serial':
        await this.executeSerial(runId, task, connectedTerminals, configuredTerminals.length)
        break
      case 'parallel':
        await this.executeParallel(runId, task, connectedTerminals, configuredTerminals.length)
        break
      case 'limited':
        await this.executeLimited(runId, task, connectedTerminals, maxConcurrency, configuredTerminals.length)
        break
    }

    const results = batchTaskManager.getRunResults(runId)
    const completed = results.filter((r) => r.status === 'success').length
    const failed = results.filter((r) => r.status === 'failed').length
    const status = failed === 0 ? 'completed' : 'failed'

    // Generate AI summaries for results with output
    const summaries = await this.generateAiSummaries(results)
    logger.info('[ExecutionEngine] AI summaries generated', { summaryCount: summaries.size })
    for (const [k, v] of summaries.entries()) {
      logger.info('[ExecutionEngine] summary stored', { key: k, valueLength: v.length, value: v.substring(0, 100) })
    }

    // Get user locale for localized report
    let userLocale = 'zh-CN'
    try {
      const extState = await getAllExtensionState()
      userLocale = (extState as any)?.language || 'zh-CN'
    } catch (e) {
      logger.warn('[ExecutionEngine] Could not get user locale', { error: e })
    }

    const reportPaths = await this.reportGenerator.generate(runId, results, summaries, userLocale)

    batchTaskManager.updateRunProgress(runId, completed, failed, Date.now(), status, reportPaths.jsonPath)
    webSocketNotifier.pushRunCompleted(runId, connectedTerminals.length, completed, failed)
    logger.info('[ExecutionEngine] Execution finished', { runId, status, completed, failed })
  }

  private async resolveTerminals(selectors: BatchTaskTerminal[]): Promise<ResolvedTerminal[]> {
    const terminals: ResolvedTerminal[] = []

    for (const sel of selectors) {
      try {
        const selector: TerminalSelector = JSON.parse(sel.selector)

        if (selector.type === 'active') {
          // Resolve already-connected SSH terminal sessions by tab/connection ID.
          // A "connected session" may live in any of three stores depending on how
          // it was established:
          //   - sshConnections        : direct SSH
          //   - jumpserverConnections : JumpServer-bridged sessions
          //   - bastionSessionTypes   : plugin-based bastions (e.g. person-switch-*)
          const ids = selector.ids || []
          const displayNameById = new Map<string, string>(
            (selector.terminals || []).map((t) => {
              const label = t.ip ? `${t.title} (${t.ip})` : t.title
              return [t.id, label]
            })
          )
          const sshKeys = [...sshConnections.keys()]
          const jmsKeys = [...jumpserverConnections.keys()]
          logger.info('[ExecutionEngine] Resolving active terminal sessions', {
            ids,
            sshConnectionsKeysCount: sshKeys.length,
            jumpserverConnectionsKeysCount: jmsKeys.length,
            sshConnectionsKeys: sshKeys,
            hasDisplayNames: displayNameById.size > 0
          })
          const displayNameOf = (id: string): string => displayNameById.get(id) || id
          for (const id of ids) {
            const displayName = displayNameOf(id)
            if (sshConnections.has(id)) {
              const conn = sshConnections.get(id)
              const isAlive = conn && conn._sock && !conn._sock.destroyed
              logger.info('[ExecutionEngine] Active terminal check', { id, found: true, kind: 'direct-ssh', isAlive, displayName })
              if (isAlive) {
                terminals.push({ id, name: displayName, connected: true, kind: 'direct-ssh' })
              } else {
                const errMsg = `Active terminal session socket is destroyed: ${id}`
                logger.warn('[ExecutionEngine] Active terminal socket dead', { id })
                terminals.push({ id: '', name: displayName, connected: false, error: errMsg })
              }
            } else if (jumpserverConnections.has(id)) {
              logger.info('[ExecutionEngine] Active terminal check', { id, found: true, kind: 'jumpserver', displayName })
              terminals.push({ id, name: displayName, connected: true, kind: 'jumpserver' })
            } else if (getBastionSessionType(id)) {
              const bastionType = getBastionSessionType(id) as string
              logger.info('[ExecutionEngine] Active terminal check', { id, found: true, kind: 'bastion', bastionType, displayName })
              terminals.push({ id, name: displayName, connected: true, kind: `bastion:${bastionType}` })
            } else {
              const errMsg = `Active terminal session not found (may have been disconnected): ${id}`
              logger.warn('[ExecutionEngine] Active terminal not found', { id })
              terminals.push({ id: '', name: displayName, connected: false, error: errMsg })
            }
          }
        } else if (selector.type === 'asset') {
          // Asset selector: connect to assets by UUID
          const assetIds = selector.ids || []
          logger.info('[ExecutionEngine] Processing asset selector', { assetIds })
          for (const assetId of assetIds) {
            try {
              const dbService = await ChatermDatabaseService.getInstance()
              logger.info('[ExecutionEngine] Calling connectAssetInfo', { assetId })
              const assetInfo = dbService.connectAssetInfo(assetId)
              logger.info('[ExecutionEngine] connectAssetInfo result', { assetId, assetInfo: assetInfo ? 'found' : 'not found' })

              // If not found by UUID, try querying by asset_ip as fallback
              if (!assetInfo) {
                logger.warn('[ExecutionEngine] Asset not found by UUID, trying search', { assetId })
                // Try to find asset by searching asset_ip or label
                const searchResults = dbService.getUserHosts(`%${assetId}%`, 10) as any[]
                logger.info('[ExecutionEngine] getUserHosts results', { query: `%${assetId}%`, count: searchResults?.length || 0 })
                if (searchResults && searchResults.length > 0) {
                  // Find exact match by asset_ip or label
                  const matched = searchResults.find((a) => a.host === assetId || a.label === assetId)
                  logger.info('[ExecutionEngine] Search matched', { assetId, matched: matched || 'no match' })
                  if (matched && matched.uuid) {
                    const assetInfoBySearch = dbService.connectAssetInfo(matched.uuid)
                    logger.info('[ExecutionEngine] connectAssetInfo by uuid result', { uuid: matched.uuid, found: !!assetInfoBySearch })
                    if (assetInfoBySearch) {
                      logger.info('[ExecutionEngine] Found asset by search', {
                        searchTerm: assetId,
                        actualUuid: matched.uuid,
                        host: matched.host
                      })
                    }
                  }
                }
              }

              if (!assetInfo) {
                const errorMsg = `Asset not found: ${assetId}`
                logger.warn('[ExecutionEngine] Asset not found', { assetId })
                terminals.push({ id: '', name: assetId, connected: false, error: errorMsg })
                continue
              }

              const connectionInfo: ConnectionInfo = {
                host: assetInfo.host || assetInfo.asset_ip,
                port: assetInfo.port,
                username: assetInfo.username || '',
                password: assetInfo.password || '',
                privateKey: assetInfo.privateKey,
                passphrase: assetInfo.passphrase,
                needProxy: assetInfo.needProxy,
                proxyName: assetInfo.proxyName
              }

              const result = await remoteSshConnect(connectionInfo)
              if (result.id) {
                const assetName = assetInfo.label || assetInfo.host || assetInfo.asset_ip || assetId
                terminals.push({ id: result.id, name: assetName, connected: true })
                logger.info('[ExecutionEngine] Asset connected successfully', {
                  assetId,
                  sessionId: result.id,
                  assetName
                })
              } else {
                const errorMsg = result.error || 'SSH connection failed'
                logger.error('[ExecutionEngine] Failed to connect to asset', { assetId, error: errorMsg })
                const assetName = assetInfo.label || assetInfo.host || assetInfo.asset_ip || assetId
                terminals.push({ id: '', name: assetName, connected: false, error: errorMsg })
              }
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error)
              logger.error('[ExecutionEngine] Asset connection error', { assetId, error: errMsg })
              terminals.push({ id: '', name: assetId, connected: false, error: errMsg })
            }
          }
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

  private async executeSerial(runId: string, task: BatchTask, terminals: ResolvedTerminal[], totalTerminals: number): Promise<void> {
    logger.info('[ExecutionEngine] executeSerial starting', { runId, terminalCount: terminals.length })
    for (const terminal of terminals) {
      if (this.isRunCancelled(runId)) break
      await this.executeOnTerminal(runId, terminal, task, totalTerminals)
    }
  }

  private async executeParallel(runId: string, task: BatchTask, terminals: ResolvedTerminal[], totalTerminals: number): Promise<void> {
    await Promise.all(terminals.map((t) => this.executeOnTerminal(runId, t, task, totalTerminals)))
  }

  private async executeLimited(
    runId: string,
    task: BatchTask,
    terminals: ResolvedTerminal[],
    maxConcurrency: number,
    totalTerminals: number
  ): Promise<void> {
    const chunks: ResolvedTerminal[][] = []
    for (let i = 0; i < terminals.length; i += maxConcurrency) {
      chunks.push(terminals.slice(i, i + maxConcurrency))
    }
    for (const chunk of chunks) {
      if (this.isRunCancelled(runId)) break
      await Promise.all(chunk.map((t) => this.executeOnTerminal(runId, t, task, totalTerminals)))
    }
  }

  private isRunCancelled(runId: string): boolean {
    const run = batchTaskManager.getRun(runId)
    return run?.status === 'cancelled'
  }

  private async executeOnTerminal(runId: string, terminal: ResolvedTerminal, task: BatchTask, totalTerminals: number): Promise<void> {
    logger.info('[ExecutionEngine] executeOnTerminal start', { runId, terminalId: terminal.id, terminalName: terminal.name })

    const operations = (task.operations || []).sort((a, b) => a.executionOrder - b.executionOrder)
    logger.info('[ExecutionEngine] Operations to execute', { count: operations.length })

    // Each (terminal, operation) pair becomes its own row in
    // batch_terminal_results. The previous design aggregated all
    // operations into one row; that made it impossible to tell which
    // operation failed when something broke mid-batch.
    let completed = 0
    let failed = 0

    for (const op of operations) {
      if (this.isRunCancelled(runId)) {
        logger.info('[ExecutionEngine] run cancelled, skipping remaining operations', { runId, terminalId: terminal.id, opId: op.id })
        // Emit a placeholder row for the skipped op so the report row count
        // matches expectations.
        const skipped = batchTaskManager.createTerminalResult(
          runId,
          terminal.id,
          terminal.name,
          op.id,
          (op.operationType as 'script' | 'skill' | 'kb_script') || 'script',
          this.shortOperationTarget(op)
        )
        batchTaskManager.updateTerminalResult(skipped.id, 'failed', undefined, 'Run cancelled before this operation started')
        failed++
        continue
      }

      const operationType = (op.operationType as 'script' | 'skill' | 'kb_script') || 'script'
      const target = this.shortOperationTarget(op)
      const result = batchTaskManager.createTerminalResult(runId, terminal.id, terminal.name, op.id, operationType, target)
      logger.info('[ExecutionEngine] createTerminalResult created', { resultId: result.id, operationType, opId: op.id })
      webSocketNotifier.pushTerminalStarted(runId, terminal.id)

      let opStatus: 'success' | 'failed' = 'success'
      let opOutput = ''
      let opError: string | undefined

      try {
        const config = JSON.parse(op.operationConfig) as Record<string, string>

        if (operationType === 'script') {
          opOutput = await this.executeScript(terminal.id, config.scriptContent || '')
        } else if (operationType === 'skill') {
          opOutput = await this.runAgentLoop({
            sessionId: terminal.id,
            systemContext: this.resolveSkillBody(config.skillId || ''),
            systemContextLabel: `Skill: ${config.skillId || '(unknown)'}`,
            userInstruction: config.instruction || '',
            terminalName: terminal.name,
            targetName: config.skillId || 'skill',
            opKind: 'skill',
            runId,
            resultId: result.id
          })
        } else if (operationType === 'kb_script') {
          const kbBody = await this.readKbFile(config.kbPath || '')
          opOutput = await this.runAgentLoop({
            sessionId: terminal.id,
            systemContext: kbBody,
            systemContextLabel: `KB script: ${config.kbPath || '(unknown)'}`,
            userInstruction: config.instruction || '',
            terminalName: terminal.name,
            targetName: config.kbPath || 'kb',
            opKind: 'kb_script',
            runId,
            resultId: result.id
          })
        } else {
          throw new Error(`Unsupported operation type: ${operationType}`)
        }
      } catch (error) {
        opStatus = 'failed'
        opError = error instanceof Error ? error.message : String(error)
        logger.error('[ExecutionEngine] Operation failed', {
          runId,
          terminalId: terminal.id,
          opId: op.id,
          operationType,
          error: opError
        })
      }

      batchTaskManager.updateTerminalResult(result.id, opStatus, opOutput || undefined, opError)
      webSocketNotifier.pushTerminalCompleted(runId, terminal.id, opStatus, opError)
      if (opStatus === 'success') completed++
      else failed++

      // Per-operation progress nudge for the live UI.
      batchTaskManager.updateRunProgress(runId, completed, failed)
      webSocketNotifier.pushRunProgress(runId, totalTerminals, completed, failed)
    }
  }

  private async executeScript(sessionId: string, script: string): Promise<string> {
    // For active terminal selectors: session is an existing user SSH connection in sshConnections
    const existingConn = sshConnections.get(sessionId)
    if (existingConn) {
      logger.info('[ExecutionEngine] exec on active SSH session', { sessionId, scriptLength: script.length })
      return new Promise((resolve, reject) => {
        existingConn.exec(script, (err: any, stream: any) => {
          if (err) {
            logger.error('[ExecutionEngine] SSH exec callback error', { sessionId, error: err.message, code: err.code })
            reject(new Error(err.message))
            return
          }
          const stdoutChunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
          stream.stderr?.on('data', (chunk: Buffer) => {
            logger.warn('[ExecutionEngine] SSH exec stderr', { sessionId, stderr: chunk.toString('utf8') })
          })
          stream.on('close', (code: number) => {
            const output = Buffer.concat(stdoutChunks).toString('utf8')
            logger.info('[ExecutionEngine] SSH exec completed', { sessionId, exitCode: code, outputLength: output.length })
            resolve(output)
          })
          stream.on('error', (streamErr: Error) => {
            logger.error('[ExecutionEngine] SSH exec stream error', { sessionId, error: streamErr.message })
            reject(streamErr)
          })
        })
      })
    }

    // For active JumpServer-bridged terminals: use the dedicated exec stream so we
    // don't disturb the user's interactive shell.
    if (jumpserverConnections.has(sessionId)) {
      logger.info('[ExecutionEngine] exec on active JumpServer session', { sessionId, scriptLength: script.length })
      const execStream = await createJumpServerExecStream(sessionId)
      const result = await executeCommandOnJumpServerExec(execStream, script)
      if (!result.success) {
        throw new Error(result.error || `JumpServer exec failed (exit ${result.exitCode ?? '?'})`)
      }
      return result.stdout || ''
    }

    // For active plugin-based bastion terminals (e.g. 'mingyu', 'person-switch-*'):
    // route through the capability registry. The same path the AI CHAT agent uses,
    // so batch execution shares the connection (no reconnection cost) and the same
    //   - `exec(id, cmd)`      : direct SSH exec channel (mingyu)
    //   - `getShellStream(id)` : interactive shell stream for marker-based exec
    const bastionType = getBastionSessionType(sessionId)
    if (bastionType) {
      return await this.executeOnBastionSession(sessionId, script, bastionType)
    }

    // For asset selectors: session is a remote-agent connection created via remoteSshConnect
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

  /**
   * Resolve a skill's body text from the SkillsManager. Tries name first
   * (the SkillsManager map is keyed by metadata.name), then falls back
   * to a linear search by id/path for legacy configs.
   */
  private resolveSkillBody(skillIdOrName: string): string {
    try {
      const controller = (globalThis as any).__chatermController
      const skillsManager = controller?.skillsManager
      if (!skillsManager) {
        logger.warn('[ExecutionEngine] SkillsManager not available; skill body will be empty')
        return ''
      }
      const skill = skillsManager.getSkill(skillIdOrName)
      if (skill) return (skill as any).body || ''
      const all = skillsManager.getAllSkills?.() || []
      const match = all.find((s: any) => s.metadata?.name === skillIdOrName || s.id === skillIdOrName || s.path === skillIdOrName)
      if (match) return match.body || ''
      logger.warn('[ExecutionEngine] Skill not found in registry', { skillIdOrName })
      return ''
    } catch (error) {
      logger.warn('[ExecutionEngine] resolveSkillBody failed', { error: error instanceof Error ? error.message : String(error) })
      return ''
    }
  }

  /**
   * Read a knowledge-base file by its relPath. Returns a short note if
   * the file is missing or unreadable; the AI can still respond based
   * on the instruction alone.
   */
  private async readKbFile(relPath: string): Promise<string> {
    try {
      const root = getKnowledgeBaseRoot()
      if (!root) {
        return `[KB root not configured. Instruction alone follows.]`
      }
      const abs = path.join(root, relPath)
      const stat = await fs.stat(abs)
      if (!stat.isFile()) return `[KB path is not a file: ${relPath}]`
      if (stat.size > 256 * 1024) {
        return `[KB file is too large to inline (${stat.size} bytes). Path: ${relPath}]`
      }
      return await fs.readFile(abs, 'utf-8')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.warn('[ExecutionEngine] readKbFile failed', { relPath, error: errMsg })
      return `[KB file could not be read (${errMsg}). Path: ${relPath}]`
    }
  }

  /**
   * Build a display label for a saved operation, used both as the
   * `operation_target` column in batch_terminal_results and in the
   * report's content column. The format depends on the operation type:
   *   - script   : first line of the script (truncated)
   *   - skill    : 使用「${skillId}」完成任务：「${instruction}」
   *   - kb_script: 使用「${kbFileName}」完成任务：「${instruction}」
   *
   * The instruction is capped so the report cell stays readable; the
   * full output (including the full instruction) is still in
   * `operationConfig` and visible via the output column.
   */
  private shortOperationTarget(op: { id: string; operationType: string; operationConfig: string }): string {
    try {
      const cfg = JSON.parse(op.operationConfig) as Record<string, string>
      if (op.operationType === 'script') {
        const firstLine = (cfg.scriptContent || '').split('\n')[0]?.trim() || '(empty)'
        return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
      }
      if (op.operationType === 'skill') {
        const skill = cfg.skillId || '(missing skill id)'
        const instruction = (cfg.instruction || '').trim() || '(no instruction)'
        const clipped = instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction
        return `使用「${skill}」完成任务：「${clipped}」`
      }
      if (op.operationType === 'kb_script') {
        const kbPath = cfg.kbPath || '(missing KB path)'
        const fileName = kbPath.split('/').pop() || kbPath
        const instruction = (cfg.instruction || '').trim() || '(no instruction)'
        const clipped = instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction
        return `使用「${fileName}」完成任务：「${clipped}」`
      }
    } catch {
      // fall through
    }
    return '(unparsed)'
  }

  /**
   * Agent-style loop for skill and kb_script operations. Each round:
   *   1. Send the AI the running transcript + "what's next?" prompt.
   *   2. Parse any ```bash ... ``` fenced commands out of the reply.
   *   3. If there are commands, run them on the terminal and feed the
   *      outputs back to the AI on the next round.
   *   4. If the AI reply contains no fenced commands, treat the
   *      reply itself as the final summary and stop.
   *
   * Returns the final summary text (also streamed to the websocket as
   * terminal_output so the live UI can show progress).
   *
   * Max 10 rounds to prevent runaway loops; per-command timeout is
   * inherited from the underlying executeScript.
   */
  private async runAgentLoop(params: {
    sessionId: string
    systemContext: string
    systemContextLabel: string
    userInstruction: string
    terminalName: string
    targetName: string
    opKind: 'skill' | 'kb_script'
    runId: string
    resultId: string
  }): Promise<string> {
    const MAX_ROUNDS = 10
    const extState = await getAllExtensionState()
    const apiConfig = (extState as any)?.apiConfiguration
    if (!apiConfig) throw new Error('No API configuration. Set up a model in Settings.')
    if (!apiConfig.defaultModelId && !apiConfig.anthropicModelId) {
      throw new Error('No model selected. Pick a default model in Settings > Model.')
    }
    const apiConfigWithModel = { ...apiConfig }
    const provider = apiConfig.apiProvider || 'default'
    if (provider === 'anthropic' && !apiConfig.anthropicModelId && apiConfig.defaultModelId) {
      apiConfigWithModel.anthropicModelId = apiConfig.defaultModelId
    } else if (provider === 'openai' && !apiConfig.openAiModelId && apiConfig.defaultModelId) {
      apiConfigWithModel.openAiModelId = apiConfig.defaultModelId
    } else if (provider === 'deepseek' && !apiConfig.apiModelId && apiConfig.defaultModelId) {
      apiConfigWithModel.apiModelId = apiConfig.defaultModelId
    } else if (provider === 'ollama' && !apiConfig.ollamaModelId && apiConfig.defaultModelId) {
      apiConfigWithModel.ollamaModelId = apiConfig.defaultModelId
    }
    const api = buildApiHandler(apiConfigWithModel)
    const userLocale = (extState as any)?.language || (extState as any)?.chatSettings?.locale || 'en'

    const header = `[${params.opKind === 'skill' ? 'Skill' : 'KB script'}: ${params.targetName}] on terminal "${params.terminalName}"`
    const systemPrompt =
      `You are a terminal operator. You will be given a specification (a skill body or a KB script) and a user instruction.\n` +
      `To complete the task, you may run shell commands on the target terminal. Wrap each shell command in a single \`\`\`bash ... \`\`\` fence.\n` +
      `After the system runs your commands and shows you their output, decide whether the task is complete:\n` +
      `  - If complete, reply with a plain-text summary and NO \`\`\`bash\`\`\` fences.\n` +
      `  - If not complete, give the next set of commands in \`\`\`bash ... \`\`\` fences.\n` +
      `Do not run destructive commands (rm -rf, mkfs, dd to disks, etc.) without an explicit user instruction to do so.\n` +
      `If the specification says a feature is "not implemented" or "TODO", do not invent behaviour for it; just summarise that the feature is unavailable.\n\n` +
      `---\n${params.systemContext}\n---`

    const initialUser =
      userLocale === 'zh-CN' || userLocale === 'zh-TW'
        ? `${header}\n\n用户指令：${params.userInstruction}\n\n请基于以上"${params.targetName}"的说明开始执行。第一轮如果需要跑命令，请把命令写在 \`\`\`bash ... \`\`\` 围栏里；如果只需要输出文本总结，不要带围栏。`
        : `${header}\n\nUser instruction: ${params.userInstruction}\n\nFollowing the "${params.targetName}" specification above, start executing. Wrap each shell command in \`\`\`bash ... \`\`\` fences. If you only need to output a textual summary, do NOT include any \`\`\`bash\`\`\` fences.`

    const messages: Anthropic.MessageParam[] = [{ role: 'user' as const, content: initialUser }]

    let finalText = ''
    const transcriptLog: string[] = []

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      logger.info('[ExecutionEngine] agent loop round', { round, opKind: params.opKind, terminalName: params.terminalName })

      const stream = api.createMessage(systemPrompt, messages)
      let aiText = ''
      for await (const chunk of stream) {
        if ((chunk as any).type === 'text') {
          aiText += (chunk as any).text
        }
      }
      aiText = aiText.trim()
      logger.info('[ExecutionEngine] agent loop AI reply', { round, replyLength: aiText.length, hasFence: /```bash[\s\S]*?```/.test(aiText) })

      const commands = parseBashFences(aiText)

      if (commands.length === 0) {
        // No more commands → AI says it's done. Use the reply as the final
        // summary and exit the loop.
        finalText = aiText || (userLocale === 'zh-CN' || userLocale === 'zh-TW' ? '（AI 未返回任何文本）' : '(AI returned no text)')
        break
      }

      // Run each command in order on the target terminal and capture output.
      const roundOutputLines: string[] = []
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]
        if (this.isRunCancelled(params.runId)) {
          roundOutputLines.push(`$ ${cmd}\n(run cancelled)`)
          continue
        }
        try {
          const out = await this.executeScript(params.sessionId, cmd)
          roundOutputLines.push(`$ ${cmd}\n${out}`.trimEnd())
          // Live UI: push each command output as it lands
          webSocketNotifier.pushTerminalOutput(params.runId, params.sessionId, out)
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          roundOutputLines.push(`$ ${cmd}\n(error) ${errMsg}`.trimEnd())
          // Don't abort the whole loop on a single command error; the AI
          // can read the error and decide what to do next.
        }
      }
      const roundOutput = roundOutputLines.join('\n\n')
      transcriptLog.push(`[Round ${round} AI]\n${aiText}\n\n[Round ${round} output]\n${roundOutput}`)

      // Feed the outputs back to the AI.
      const nextUser =
        userLocale === 'zh-CN' || userLocale === 'zh-TW'
          ? `上一轮命令的执行输出如下：\n\n\`\`\`\n${roundOutput}\n\`\`\`\n\n请判断：任务是否完成？\n- 如果完成，请直接输出中文总结，不要再带 \`\`\`bash\`\`\` 围栏。\n- 如果未完成，请给出下一批命令，命令写在 \`\`\`bash ... \`\`\` 围栏里。`
          : `Here is the output of your previous commands:\n\n\`\`\`\n${roundOutput}\n\`\`\`\n\nDecide: is the task complete?\n- If yes, reply with a plain-text summary and NO \`\`\`bash\`\`\` fences.\n- If not, give the next set of commands in \`\`\`bash ... \`\`\` fences.`

      messages.push({ role: 'assistant' as const, content: aiText })
      messages.push({ role: 'user' as const, content: nextUser })
    }

    // If we hit MAX_ROUNDS without the AI saying "done", append a note
    // explaining the loop was cut short and include the transcript so
    // the user can see what happened.
    if (!finalText) {
      finalText =
        (userLocale === 'zh-CN' || userLocale === 'zh-TW'
          ? '（AI 在最大轮数内未明确给出总结；以下是过程中产生的所有交互）\n\n'
          : '(AI did not provide a final summary within the round limit. Full transcript below.)\n\n') + transcriptLog.join('\n\n---\n\n')
    } else if (transcriptLog.length > 0) {
      // Even on a clean stop, append the transcript so the report shows
      // the full reasoning trace, not just the final paragraph.
      finalText =
        finalText +
        '\n\n---\n\n' +
        (userLocale === 'zh-CN' || userLocale === 'zh-TW' ? '执行过程：\n\n' : 'Execution transcript:\n\n') +
        transcriptLog.join('\n\n---\n\n')
    }

    logger.info('[ExecutionEngine] agent loop done', {
      opKind: params.opKind,
      rounds: transcriptLog.length,
      finalLength: finalText.length
    })
    return finalText.trim()
  }

  /**
   * Run a script on an active bastion session by delegating to the capability
   * registry. Mirrors the path the AI CHAT agent uses (runBastionCommand), so
   * batch execution reuses the existing interactive connection.
   */
  private async executeOnBastionSession(sessionId: string, script: string, bastionType: string): Promise<string> {
    const capability = capabilityRegistry.getBastion(bastionType)
    if (!capability) {
      throw new Error(`Bastion capability not registered for type '${bastionType}' (session ${sessionId})`)
    }

    // Preferred path: direct SSH exec channel (used by mingyu and any plugin that
    // exposes a non-shell exec API). Returns { stdout, stderr, exitCode }.
    if (capability.exec) {
      logger.info('[ExecutionEngine] exec on active bastion via capability.exec', {
        sessionId,
        bastionType,
        scriptLength: script.length
      })
      const result = await capability.exec(sessionId, script)
      if (result.exitCode !== 0) {
        const errMsg = result.stderr || `Bastion command failed with exit code ${result.exitCode}`
        throw new Error(errMsg)
      }
      return result.stdout
    }

    // Fallback path: shared interactive shell stream. Wrap the command in
    // bash + base64 to neutralise special characters, then read until the
    // end marker to delimit the output.
    if (capability.getShellStream) {
      logger.info('[ExecutionEngine] exec on active bastion via getShellStream (marker-based)', {
        sessionId,
        bastionType,
        scriptLength: script.length
      })
      return await this.executeOnBastionShellStream(sessionId, script, bastionType, capability.getShellStream)
    }

    throw new Error(`Bastion type '${bastionType}' exposes neither exec nor getShellStream; cannot run batch scripts`)
  }

  /**
   * Marker-based one-shot command execution on a bastion's interactive shell
   * stream. The user's live session shares this stream, so we use unique
   * start/end markers to delimit our output and the base64 trick to escape
   * the command body. Mirrors the agent's `buildJumpServerWrappedCommand` +
   * `runMarkerBasedCommand` pair, in a batch-shaped form (collect stdout,
   * reject on non-zero exit / timeout, no UI rendering).
   */
  private async executeOnBastionShellStream(
    sessionId: string,
    script: string,
    bastionType: string,
    getShellStream: (id: string) => unknown
  ): Promise<string> {
    const stream = getShellStream(sessionId) as (NodeJS.ReadableStream & { write: (data: string) => boolean }) | undefined
    if (!stream) {
      throw new Error(`${bastionType} shell stream not found for session ${sessionId}`)
    }

    const timestamp = Date.now()
    const randomId = Math.random().toString(36).slice(2, 14)
    const startMarker = `===CHATERM_START_${timestamp}_${randomId}===`
    const endMarker = `===CHATERM_END_${timestamp}_${randomId}===`

    const cmdBase64 = Buffer.from(script, 'utf-8').toString('base64')
    const wrappedCommand = `bash -l -c 'echo "${startMarker}"; eval "$(echo ${cmdBase64} | base64 -d)"; EXIT_CODE=$?; echo "${endMarker}:$EXIT_CODE"'\n`

    const timeoutMs = 60_000
    return new Promise((resolve, reject) => {
      let buffer = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stream.off('data', onData)
        fn()
      }
      const onData = (chunk: Buffer | string): void => {
        if (settled) return
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

        const endMatch = buffer.match(new RegExp(`${endMarker}:(-?\\d+)`))
        if (!endMatch) return

        const exitCode = parseInt(endMatch[1], 10)
        const startIdx = buffer.indexOf(startMarker)
        const endIdx = buffer.indexOf(endMarker)
        const rawStdout = startIdx >= 0 && endIdx > startIdx ? buffer.substring(startIdx + startMarker.length, endIdx) : ''
        const stdout = rawStdout.replace(/^\r?\n+/, '').replace(/\r?\n+$/, '')

        if (exitCode !== 0) {
          finish(() => reject(new Error(`${bastionType} command exited with code ${exitCode}: ${stdout || '(no output)'}`)))
        } else {
          finish(() => resolve(stdout))
        }
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`${bastionType} command timed out after ${timeoutMs}ms (session ${sessionId})`)))
      }, timeoutMs)

      stream.on('data', onData)
      try {
        stream.write(wrappedCommand)
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    })
  }

  private async generateAiSummaries(results: BatchTerminalResult[]): Promise<Map<string, string>> {
    const summaries = new Map<string, string>()

    // Get results with output that need summarization
    const resultsNeedingSummary = results.filter((r) => r.output && r.output.length > 0)

    if (resultsNeedingSummary.length === 0) {
      logger.info('[ExecutionEngine] No results need AI summarization')
      return summaries
    }

    logger.info('[ExecutionEngine] Starting AI summarization', { resultCount: resultsNeedingSummary.length })

    try {
      // Get API configuration from renderer process
      logger.info('[ExecutionEngine] Getting extension state...')
      let state: any = null
      try {
        state = await getAllExtensionState()
        logger.info('[ExecutionEngine] Extension state received', { hasState: !!state, stateKeys: state ? Object.keys(state) : [] })
      } catch (stateError) {
        logger.error('[ExecutionEngine] Failed to get extension state', {
          error: stateError instanceof Error ? stateError.message : String(stateError)
        })
        return summaries
      }

      const apiConfig = state?.apiConfiguration
      logger.info('[ExecutionEngine] API config full', {
        hasApiConfig: !!apiConfig,
        apiProvider: apiConfig?.apiProvider,
        defaultModelId: apiConfig?.defaultModelId,
        anthropicModelId: apiConfig?.anthropicModelId,
        hasApiKey: !!apiConfig?.defaultApiKey
      })

      if (!apiConfig) {
        logger.warn('[ExecutionEngine] No API configuration - please configure API in Settings > Model')
        return summaries
      }

      // Check if user has configured a model
      const hasConfiguredModel = apiConfig.defaultModelId || apiConfig.anthropicModelId
      if (!hasConfiguredModel) {
        logger.warn('[ExecutionEngine] No model selected - please select a default model in Settings > Model')
        return summaries
      }

      // Build API config with proper model ID field for the provider
      const apiConfigWithModel = { ...apiConfig }
      const provider = apiConfig.apiProvider || 'default'
      if (provider === 'anthropic' && !apiConfig.anthropicModelId && apiConfig.defaultModelId) {
        apiConfigWithModel.anthropicModelId = apiConfig.defaultModelId
        logger.info('[ExecutionEngine] Using defaultModelId for anthropic', { modelId: apiConfig.defaultModelId })
      } else if (provider === 'openai' && !apiConfig.openAiModelId && apiConfig.defaultModelId) {
        apiConfigWithModel.openAiModelId = apiConfig.defaultModelId
      } else if (provider === 'deepseek' && !apiConfig.apiModelId && apiConfig.defaultModelId) {
        apiConfigWithModel.apiModelId = apiConfig.defaultModelId
      } else if (provider === 'ollama' && !apiConfig.ollamaModelId && apiConfig.defaultModelId) {
        apiConfigWithModel.ollamaModelId = apiConfig.defaultModelId
      }

      // Build API handler
      const api = buildApiHandler(apiConfigWithModel)
      const modelId = apiConfigWithModel.anthropicModelId || apiConfigWithModel.openAiModelId || apiConfigWithModel.defaultModelId
      logger.info('[ExecutionEngine] API handler built', { provider, modelId })

      // Get user's locale from state
      const userLocale = (state as any)?.language || (state as any)?.chatSettings?.locale || 'en'
      logger.info('[ExecutionEngine] User locale for AI summarization', { locale: userLocale })

      // System prompt for summarization (localized)
      const systemPrompts: Record<string, string> = {
        'zh-CN':
          '你是一个有用的助手，负责总结脚本执行输出。你的任务是提供简洁明了的脚本执行结果摘要。重点包括：\n1. 脚本完成的工作\n2. 主要输出或结果\n3. 遇到的错误或问题\n4. 最终状态\n\n保持摘要简洁（最多2-3句话）。',
        'zh-TW':
          '你是一個有用的助手，負責總結腳本執行輸出。你的任務是提供簡潔明了的腳本執行結果摘要。重點包括：\n1. 腳本完成的工作\n2. 主要輸出或結果\n3. 遇到的錯誤或問題\n4. 最終狀態\n\n保持摘要簡潔（最多2-3句話）。',
        default:
          'You are a helpful assistant that summarizes script execution outputs. Your task is to provide a brief, clear summary of the script execution results. Focus on:\n1. What the script accomplished\n2. Key outputs or results\n3. Any errors or issues encountered\n4. Final status\n\nKeep the summary concise (2-3 sentences max).'
      }

      const systemPrompt = systemPrompts[userLocale] || systemPrompts['default']
      logger.info('[ExecutionEngine] Using localized system prompt', { locale: userLocale, promptLength: systemPrompt.length })

      logger.info('[ExecutionEngine] Starting AI summarization loop', { resultCount: resultsNeedingSummary.length })

      // Generate summary for each result
      for (const result of resultsNeedingSummary) {
        try {
          logger.info('[ExecutionEngine] Generating summary for result', {
            resultId: result.id,
            terminalName: result.terminalName,
            outputLength: result.output?.length || 0
          })

          const userMessage =
            userLocale === 'zh-CN' || userLocale === 'zh-TW'
              ? `请总结以下脚本执行输出（终端"${result.terminalName}"）：\n\n${result.output}`
              : `Please summarize the following script execution output for terminal "${result.terminalName}":\n\n${result.output}`

          const messages: Anthropic.MessageParam[] = [{ role: 'user' as const, content: userMessage }]

          logger.info('[ExecutionEngine] Calling API createMessage...')
          let summaryText = ''
          try {
            const stream = api.createMessage(systemPrompt, messages)
            logger.info('[ExecutionEngine] Stream created, iterating...')

            for await (const chunk of stream) {
              logger.info('[ExecutionEngine] Stream chunk', { type: chunk.type })
              if (chunk.type === 'text') {
                summaryText += chunk.text
              }
            }
            logger.info('[ExecutionEngine] Stream iteration completed', { summaryLength: summaryText.length })
          } catch (streamError) {
            logger.error('[ExecutionEngine] Stream error', {
              error: streamError instanceof Error ? streamError.message : String(streamError),
              stack: streamError instanceof Error ? streamError.stack : undefined
            })
            throw streamError
          }

          if (summaryText) {
            summaries.set(result.id, summaryText.trim())
            logger.info('[ExecutionEngine] AI summary generated', {
              resultId: result.id,
              summaryLength: summaryText.length,
              summary: summaryText.substring(0, 100)
            })
          } else {
            logger.warn('[ExecutionEngine] AI returned empty summary', { resultId: result.id })
          }
        } catch (summaryError) {
          logger.error('[ExecutionEngine] Failed to generate AI summary for result', {
            resultId: result.id,
            error: summaryError instanceof Error ? summaryError.message : String(summaryError),
            stack: summaryError instanceof Error ? summaryError.stack : undefined
          })
        }
      }
    } catch (error) {
      logger.error('[ExecutionEngine] Failed to initialize AI summarization', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })
    }

    return summaries
  }
}

/**
 * Extract the shell commands inside ```bash ... ``` fences from an
 * AI reply. Each fence may contain one or more newline-separated
 * commands; we split on newlines and ignore blank lines and
 * shell-style comments. Anything outside ```bash``` fences is
 * ignored — the AI's reasoning text is preserved as part of the
 * message transcript but never sent to the terminal.
 */
function parseBashFences(text: string): string[] {
  const fenceRegex = /```bash\s*([\s\S]*?)```/g
  const commands: string[] = []
  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1]
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim()
      if (!line) continue
      if (line.startsWith('#')) continue
      commands.push(line)
    }
  }
  return commands
}

export const executionEngine = new ExecutionEngine()

# Batch Task Automation — Design Spec

## 1. Overview

A feature to batch-execute knowledge base scripts or AI skills on selected terminals (SSH connections or assets) on a scheduled or manual trigger, with real-time progress and result reports.

## 2. Architecture

### 2.1 Process Layout

```
Renderer Process (Vue 3)
├── BatchTab.vue              # Left sidebar entry
├── TaskListView.vue          # Task list
├── TaskFormView.vue          # Create/edit task (wizard or form)
│   ├── TerminalStep.vue       # Step 1: select terminals
│   ├── OperationStep.vue      # Step 2: select operations
│   ├── TriggerStep.vue       # Step 3: schedule config
│   └── ConfirmStep.vue       # Step 4: confirm
├── RunDetailView.vue         # Real-time execution details
└── ReportView.vue            # Report view/export
         │
         │ WebSocket (dedicated connection)
         ▼
Main Process
├── BatchTaskManager          # Task CRUD + execution trigger
├── Scheduler                 # setInterval-based timer
├── ExecutionEngine           # Serial / parallel / limited-concurrency execution
├── SkillsManager (existing)  # AI skill execution
├── sshHandle (existing)      # Terminal connection management
├── KBService (existing)      # Knowledge base access
├── ReportGenerator           # JSON + HTML export
└── SQLite                    # Task config + execution records
```

### 2.2 Component Responsibilities

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `BatchTaskManager` | `src/main/batch/` | Task CRUD, manual execution trigger |
| `Scheduler` | `src/main/batch/` | setInterval polling, triggers execution on schedule |
| `ExecutionEngine` | `src/main/batch/` | Serial/parallel/limited execution, WebSocket push |
| `WebSocketNotifier` | `src/main/batch/` | Pushes real-time events to renderer |
| `ReportGenerator` | `src/main/batch/` | Generates JSON + HTML reports |
| `SkillsManager` | `src/main/agent/services/skills/` (existing) | AI skill execution |
| `sshHandle` | `src/main/ssh/` (existing) | Terminal connection management |
| KB service | `src/main/services/knowledgebase/` (existing) | Knowledge base access |

### 2.3 Design Principle

Reuse existing components (SSH, Skills, KB) wherever possible. Only the scheduling, orchestration, and reporting layers are new.

## 3. Database Schema

```sql
-- Batch task configuration
CREATE TABLE batch_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,       -- 'manual' | 'scheduled'
  cron_expression TEXT,              -- NULL for manual-only tasks
  cron_display TEXT,                 -- Human-readable (e.g. "daily at 2am")
  execution_mode TEXT NOT NULL,      -- 'serial' | 'parallel' | 'limited'
  max_concurrency INTEGER DEFAULT 5,  -- Only for 'limited' mode
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Terminal selectors (many-to-many)
CREATE TABLE batch_task_terminals (
  task_id TEXT NOT NULL,
  selector_type TEXT NOT NULL,       -- 'active' | 'asset' | 'template'
  selector TEXT NOT NULL,            -- JSON: {"type":"asset","ids":["uuid1"]} or {"type":"template","expr":"${env}"}
  FOREIGN KEY (task_id) REFERENCES batch_tasks(id)
);

-- Operations (many-to-many, ordered)
CREATE TABLE batch_task_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,      -- 'skill' | 'script' | 'kb_script'
  operation_config TEXT NOT NULL,    -- JSON: {skillId:'...'} or {scriptContent:'...'}
  execution_order INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES batch_tasks(id)
);

-- Execution run records
CREATE TABLE batch_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,               -- NULL means running
  status TEXT NOT NULL,             -- 'running' | 'completed' | 'failed' | 'cancelled'
  total_terminals INTEGER NOT NULL,
  completed_terminals INTEGER DEFAULT 0,
  failed_terminals INTEGER DEFAULT 0,
  execution_mode TEXT NOT NULL,
  report_path TEXT,                  -- JSON report file path
  FOREIGN KEY (task_id) REFERENCES batch_tasks(id)
);

-- Per-terminal results
CREATE TABLE batch_terminal_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  terminal_name TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'pending' | 'running' | 'success' | 'failed'
  started_at INTEGER,
  finished_at INTEGER,
  output TEXT,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES batch_task_runs(id)
);
```

Migration file: `migrations/YYYYMMDDHHMMSS_batch_tasks.sql`

## 4. Core Module Interfaces

### 4.1 BatchTaskManager (`src/main/batch/BatchTaskManager.ts`)

```typescript
class BatchTaskManager {
  // CRUD
  createTask(config: BatchTaskConfig): Promise<BatchTask>
  updateTask(id: string, config: Partial<BatchTaskConfig>): Promise<void>
  deleteTask(id: string): Promise<void>
  getTask(id: string): Promise<BatchTask | null>
  listTasks(): Promise<BatchTask[]>

  // Execution
  executeTask(id: string): Promise<BatchTaskRun>
  cancelRun(runId: string): Promise<void>

  // Query
  getRun(runId: string): Promise<BatchTaskRun | null>
  getRunResults(runId: string): Promise<TerminalResult[]>
}
```

### 4.2 Scheduler (`src/main/batch/Scheduler.ts`)

```typescript
class Scheduler {
  start(): void   // Called on main process startup
  stop(): void    // Called on main process shutdown
  // Polls SQLite for due scheduled tasks using setInterval
  // Triggers BatchTaskManager.executeTask() when task is due
}
```

### 4.3 ExecutionEngine (`src/main/batch/ExecutionEngine.ts`)

```typescript
class ExecutionEngine {
  constructor(taskManager: BatchTaskManager, wsNotifier: WebSocketNotifier)

  execute(runId: string): Promise<void>

  // Execution strategies
  private executeSerial(runId, operations, terminals): Promise<void>
  private executeParallel(runId, operations, terminals): Promise<void>
  private executeLimited(runId, operations, terminals, maxConcurrency): Promise<void>

  // WebSocket push helpers
  pushProgress(runId, terminalId, status, output): void
}
```

### 4.4 ReportGenerator (`src/main/batch/ReportGenerator.ts`)

```typescript
class ReportGenerator {
  generate(runId: string, results: TerminalResult[]): Promise<{
    jsonPath: string
    htmlPath: string
  }>

  private buildJsonReport(results): object
  private buildHtmlReport(results): string
}
```

## 5. IPC Channels & WebSocket Protocol

### 5.1 IPC Channels (preload)

```typescript
// Task management
'batch:create-task': (config: BatchTaskConfig) => Promise<BatchTask>
'batch:update-task': (id: string, config: Partial<BatchTaskConfig>) => Promise<void>
'batch:delete-task': (id: string) => Promise<void>
'batch:get-task': (id: string) => Promise<BatchTask | null>
'batch:list-tasks': () => Promise<BatchTask[]>

// Execution
'batch:execute-task': (taskId: string) => Promise<BatchTaskRun>
'batch:cancel-run': (runId: string) => Promise<void>

// Query
'batch:get-run': (runId: string) => Promise<BatchTaskRun | null>
'batch:get-run-results': (runId: string) => Promise<TerminalResult[]>

// Report
'batch:export-report': (runId: string, format: 'json' | 'html') => Promise<string>
```

### 5.2 WebSocket Events

```typescript
interface BatchProgressEvent {
  type: 'progress' | 'terminal_update' | 'completed' | 'error'
  runId: string
  terminalId?: string
  status?: 'pending' | 'running' | 'success' | 'failed'
  output?: string
  progress?: { total: number; completed: number; failed: number }
}

// Event types pushed to renderer
'batch:terminal:started'
'batch:terminal:output'
'batch:terminal:completed'
'batch:run:progress'
'batch:run:completed'
```

- Renderer disconnects: execution continues in main process
- Reconnect: renderer pulls latest state via `batch:get-run`
- Heartbeat: ping/pong every 30 seconds

## 6. UI Components

```
src/renderer/src/views/components/BatchTask/
├── BatchTab.vue              # Main entry, left nav tab
├── TaskListView.vue          # Task list page
├── TaskFormView.vue          # Create/edit form
│   ├── TerminalStep.vue      # Terminal selection (3 tabs: active/asset/template)
│   ├── OperationStep.vue     # Operation selection (skill/script/kb_script)
│   ├── TriggerStep.vue       # Schedule config (simple/cron toggle)
│   └── ConfirmStep.vue       # Confirmation
├── RunDetailView.vue         # Real-time progress + results
└── ReportView.vue            # Report view/export
```

### 6.1 Terminal Selection

- **Active terminals**: list of currently open SSH connections, checkbox select
- **Asset list**: tree view of managed servers, multi-select, filter by tag/group
- **Template variables**: `${env}` format input, resolves to matching terminals

### 6.2 Operation Selection

- **AI skill**: loads skill list from SkillsManager, user selects
- **Script**: Monaco Editor for shell/powershell script content
- **KB script**: file tree from knowledge base, drag to reorder execution sequence

### 6.3 Trigger Configuration

- Toggle: Manual / Scheduled
- Simple mode: dropdown for common schedules (hourly/daily/weekly)
- Cron mode: standard 5-field cron expression input with visual builder option

### 6.4 Execution Strategy

- User selects before execution: serial / parallel / limited concurrency
- Limited mode: configurable max concurrency (default 5)

### 6.5 Run Detail View

- Progress bar: total / completed / failed
- Per-terminal expandable rows showing output
- Status colors: pending=gray, running=blue, success=green, failed=red
- Export buttons (JSON / HTML) shown after completion

## 7. Error Handling

| Scenario | Handling |
|----------|----------|
| Terminal connection failure | Mark failed, record error, continue next terminal |
| Script execution timeout | Configurable timeout; mark failed, continue |
| Skill execution failure | Mark failed, record AI error, continue |
| KB file not found | Mark failed, continue |
| Single terminal fails | Does not affect other terminals |

**Scheduler edge cases:**
- App closed during execution: mark status `failed`, no auto-recovery on restart
- Scheduled task triggers while app is closed: no catch-up execution
- Invalid cron expression: validated at creation time, not saved if invalid

**WebSocket disconnection:**
- Renderer disconnected: execution continues in main process
- On reconnect: renderer fetches latest state via IPC
- Heartbeat: 30-second ping/pong

## 8. Execution Flow

```
User clicks "Run"
    │
    ▼
BatchTaskManager.executeTask(taskId)
    │
    ▼
BatchTaskRun created (status: running)
    │
    ▼
Scheduler notifies ExecutionEngine
    │
    ├──► Terminal 1 ──► Operation A ──► Operation B ──► Record Result
    ├──► Terminal 2 ──► Operation A ──► Operation B ──► Record Result
    ├──► Terminal 3 ──► Operation A ──► Operation B ──► Record Result
    │   ...
    │
    ▼ (all terminals done or cancelled)
BatchTaskRun status → completed/failed
ReportGenerator.buildJsonReport()
ReportGenerator.buildHtmlReport()
WebSocket pushes 'batch:run:completed'
```

## 9. AI Skill Execution

When executing an AI skill in batch mode:
- Each terminal is independent — no shared state between terminals
- Skill runs on each terminal fresh with its own context
- Simple scenarios: skill generates command, user confirms, command executes
- Complex scenarios (e.g. troubleshooting): skill runs as Agent with multi-turn interaction
- Knowledge base content can be selected as a script to execute directly on terminal

## 10. Router Integration

```typescript
// src/renderer/src/router/routes.ts
{
  path: '/batch',
  name: 'BatchTask',
  component: () => import('@views/components/BatchTask/BatchTab.vue'),
  meta: { title: 'batchTask.title' }
}
```

## 11. Out of Scope

- Cloud sync of task configurations (local SQLite only)
- Task recovery after app crash (execution marked failed, not resumed)
- Cross-terminal aggregate analysis by AI skill
- PDF/Excel export (JSON + HTML only)

import Database from 'better-sqlite3'
const logger = createLogger('db')

export function upgradeBatchTaskSupport(db: Database.Database): void {
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_tasks'").get() as { name: string } | undefined

    if (!tableExists) {
      logger.info('[Migration] Creating batch_tasks table...')

      db.exec(`
        CREATE TABLE batch_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          trigger_type TEXT NOT NULL DEFAULT 'manual',
          cron_expression TEXT,
          cron_display TEXT,
          execution_mode TEXT NOT NULL DEFAULT 'serial',
          max_concurrency INTEGER DEFAULT 5,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
        )
      `)

      db.exec(`
        CREATE TABLE batch_task_terminals (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          selector_type TEXT NOT NULL,
          selector TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE
        )
      `)

      db.exec(`
        CREATE TABLE batch_task_operations (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          operation_config TEXT NOT NULL,
          execution_order INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE
        )
      `)

      db.exec(`
        CREATE TABLE batch_task_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          total_terminals INTEGER NOT NULL DEFAULT 0,
          completed_terminals INTEGER DEFAULT 0,
          failed_terminals INTEGER DEFAULT 0,
          execution_mode TEXT NOT NULL,
          report_path TEXT,
          FOREIGN KEY (task_id) REFERENCES batch_tasks(id)
        )
      `)

      db.exec(`
        CREATE TABLE batch_terminal_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          terminal_id TEXT NOT NULL,
          terminal_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          started_at INTEGER,
          finished_at INTEGER,
          output TEXT,
          error TEXT,
          FOREIGN KEY (run_id) REFERENCES batch_task_runs(id) ON DELETE CASCADE
        )
      `)

      db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_task_terminals_task ON batch_task_terminals(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_task_operations_task ON batch_task_operations(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_task_runs_task ON batch_task_runs(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_terminal_results_run ON batch_terminal_results(run_id)`)

      logger.info('[Migration] batch_tasks tables created successfully')
    } else {
      logger.info('[Migration] batch_tasks table already exists')
    }
  } catch (error) {
    logger.error('[Migration] Failed to upgrade batch task support', { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

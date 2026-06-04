import Database from 'better-sqlite3'

const logger = createLogger('db')

export function fixBatchTaskRunsForeignKey(db: Database.Database): void {
  try {
    // Check if batch_task_runs table exists and if it has the foreign key constraint
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_task_runs'").get() as
      | { name: string }
      | undefined

    if (!tableExists) {
      logger.info('[Migration] batch_task_runs table does not exist, skipping')
      return
    }

    // Check current foreign key info
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(batch_task_runs)').all() as Array<{
      from: string
      table: string
      to: string
      on_delete: string
    }>
    const hasCascade = foreignKeys.some((fk) => fk.on_delete === 'CASCADE')

    if (hasCascade) {
      logger.info('[Migration] batch_task_runs already has ON DELETE CASCADE')
      return
    }

    logger.info('[Migration] Adding ON DELETE CASCADE to batch_task_runs table...')

    // SQLite doesn't support ALTER TABLE to add foreign key directly
    // We need to recreate the table with the new foreign key
    db.exec(`
      CREATE TABLE batch_task_runs_new (
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
        FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE
      )
    `)

    // Copy data from old table to new table
    db.exec(`
      INSERT INTO batch_task_runs_new SELECT * FROM batch_task_runs
    `)

    // Drop old table
    db.exec('DROP TABLE batch_task_runs')

    // Rename new table to original name
    db.exec('ALTER TABLE batch_task_runs_new RENAME TO batch_task_runs')

    logger.info('[Migration] batch_task_runs foreign key fixed successfully')
  } catch (error) {
    logger.error('[Migration] Failed to fix batch_task_runs foreign key', { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

import Database from 'better-sqlite3'

const logger = createLogger('db')

/**
 * Add per-operation columns to batch_terminal_results so each
 * (terminal, operation) pair becomes its own row in the report
 * (previously the engine aggregated all operations of a terminal
 * into a single row's `output`).
 *
 * New columns:
 *   - operation_id      : stable id from BatchTaskOperation
 *   - operation_type    : 'script' | 'skill' | 'kb_script'
 *   - operation_target  : short display string (script first line, skill name, kb file name)
 *
 * Existing rows get a synthetic `operation_type = 'legacy'` so the
 * report still has something to render for them.
 */
export function addBatchTerminalResultOperationColumns(db: Database.Database): void {
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_terminal_results'").get() as
      | { name: string }
      | undefined

    if (!tableExists) {
      logger.info('[Migration] batch_terminal_results table does not exist, skipping')
      return
    }

    const existingColumns = db.prepare('PRAGMA table_info(batch_terminal_results)').all() as Array<{ name: string }>
    const columnNames = new Set(existingColumns.map((c) => c.name))

    const addColumn = (name: string, ddl: string) => {
      if (columnNames.has(name)) {
        logger.info(`[Migration] batch_terminal_results already has column '${name}'`)
        return
      }
      logger.info(`[Migration] Adding column '${name}' to batch_terminal_results`)
      db.exec(ddl)
    }

    addColumn('operation_id', 'ALTER TABLE batch_terminal_results ADD COLUMN operation_id TEXT')
    addColumn('operation_type', 'ALTER TABLE batch_terminal_results ADD COLUMN operation_type TEXT')
    addColumn('operation_target', 'ALTER TABLE batch_terminal_results ADD COLUMN operation_target TEXT')

    // Backfill: existing rows (one per terminal, aggregating all operations)
    // get a sentinel type so the report can still classify them.
    db.exec("UPDATE batch_terminal_results SET operation_type = 'legacy' WHERE operation_type IS NULL")
    db.exec("UPDATE batch_terminal_results SET operation_id = 'legacy' WHERE operation_id IS NULL")
    db.exec("UPDATE batch_terminal_results SET operation_target = '(legacy aggregated result)' WHERE operation_target IS NULL")

    logger.info('[Migration] batch_terminal_results operation columns added successfully')
  } catch (error) {
    logger.error('[Migration] Failed to add batch_terminal_result operation columns', {
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

import Database from 'better-sqlite3'

/**
 * Add rdp_extra_args column to t_assets table for storing additional RDP command line arguments.
 * This allows users to specify parameters like /w:2048 /h:2048 for xfreerdp.
 */
export function upgradeRdpExtraArgsSupport(db: Database.Database): void {
  try {
    // Check if rdp_extra_args column exists
    try {
      db.prepare('SELECT rdp_extra_args FROM t_assets LIMIT 1').get()
      console.log('[Migration] rdp_extra_args column already exists')
    } catch (error) {
      // Column does not exist, need to upgrade table structure
      db.transaction(() => {
        db.exec("ALTER TABLE t_assets ADD COLUMN rdp_extra_args TEXT DEFAULT ''")
        console.log('[Migration] Added rdp_extra_args column to t_assets')
      })()
    }
  } catch (error) {
    console.error('[Migration] Failed to add rdp_extra_args column:', error)
  }
}

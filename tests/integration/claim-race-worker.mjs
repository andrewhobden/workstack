import Database from 'better-sqlite3'

const [databasePath, workItemId, workerId] = process.argv.slice(2)
const database = new Database(databasePath)
database.pragma('foreign_keys = ON')
database.pragma('busy_timeout = 5000')
const now = new Date().toISOString()
const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

try {
  database.exec('BEGIN IMMEDIATE')
  const changed = database
    .prepare("UPDATE work_items SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'backlog'")
    .run(now, workItemId)

  if (changed.changes !== 1) {
    database.exec('ROLLBACK')
    process.stdout.write(JSON.stringify({ claimed: false }))
  } else {
    database
      .prepare(
        `INSERT INTO work_claims (
          id, work_item_id, agent_id, agent_display_name, session_id, claim_token_hash,
          claimed_at, last_heartbeat_at, lease_expires_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        `00000000-0000-4000-8000-${workerId.padStart(12, '0')}`,
        workItemId,
        `agent-${workerId}`,
        `Agent ${workerId}`,
        `session-${workerId}`,
        `hash-${workerId}`,
        now,
        now,
        expiresAt
      )
    database.exec('COMMIT')
    process.stdout.write(JSON.stringify({ claimed: true }))
  }
} catch (error) {
  try {
    database.exec('ROLLBACK')
  } catch {
    // The transaction may not have started.
  }
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  database.close()
}

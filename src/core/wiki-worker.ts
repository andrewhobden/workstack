import { randomUUID } from 'node:crypto'
import type { ProjectStore } from './project-store'
import { WikiAutomationRepository } from './wiki-automation'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import type { WikiAutomationJob } from './types'

/** Persistent ownership fences every generated artifact and proposal, including after another process recovers a job. */
export class WikiWorkerRepository {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  claim(): { job: WikiAutomationJob; owner: string } | undefined {
    return this.store.database.transaction(() => {
      const now = this.now()
      this.store.database.prepare(`UPDATE wiki_automation_jobs SET status = 'failed', owner = NULL, lease_expires_at = NULL,
        error_message = 'Generation interrupted; the previous attempt did not publish.', next_attempt_at = CASE WHEN attempt_count < 5 THEN ? ELSE NULL END
        WHERE status = 'running' AND (owner IS NULL OR lease_expires_at <= ?)` ).run(now, now)
      const row = this.store.database.prepare(`SELECT id FROM wiki_automation_jobs WHERE attempt_count < 5 AND
        (status = 'pending' OR (status = 'failed' AND next_attempt_at <= ?)) ORDER BY created_at,rowid LIMIT 1`).get(now) as { id: string } | undefined
      if (!row) return undefined
      const owner = randomUUID()
      this.store.database.prepare(`UPDATE wiki_automation_jobs SET status = 'running',owner = ?,lease_expires_at = ?,attempt_count = attempt_count + 1,
        started_at = ?,updated_at = ?,next_attempt_at = NULL,completed_at = NULL WHERE id = ?`).run(owner, this.expires(), now, now, row.id)
      return { job: new WikiAutomationRepository(this.store).getJob(row.id), owner }
    }).immediate()
  }

  run<T>(id: string, owner: string, operation: () => T): T {
    return this.store.database.transaction(() => { this.assertOwner(id, owner); return operation() }).immediate()
  }
  heartbeat(id: string, owner: string): void {
    this.run(id, owner, () => { this.store.database.prepare('UPDATE wiki_automation_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?').run(this.expires(), this.now(), id) })
  }
  complete(id: string, owner: string): void {
    this.run(id, owner, () => { this.store.database.prepare("UPDATE wiki_automation_jobs SET status = 'completed',owner = NULL,lease_expires_at = NULL,next_attempt_at = NULL,error_message = NULL,completed_at = ?,updated_at = ? WHERE id = ?").run(this.now(), this.now(), id) })
  }
  fail(id: string, owner: string, error: unknown, retryable = true): void {
    this.run(id, owner, () => {
      const job = new WikiAutomationRepository(this.store).getJob(id)
      const next = retryable && job.attemptCount < 5 ? new Date(this.clock.now().getTime() + Math.min(3600, 30 * 2 ** (job.attemptCount - 1)) * 1000).toISOString() : null
      this.store.database.prepare("UPDATE wiki_automation_jobs SET status = 'failed',owner = NULL,lease_expires_at = NULL,next_attempt_at = ?,error_message = ?,updated_at = ? WHERE id = ?")
        .run(next, redactEvidence(error instanceof Error ? error.message : String(error)).slice(0, 2000), this.now(), id)
    })
  }
  private assertOwner(id: string, owner: string): void {
    const row = this.store.database.prepare('SELECT status,owner,lease_expires_at FROM wiki_automation_jobs WHERE id = ?').get(id) as { status: string; owner: string | null; lease_expires_at: string | null } | undefined
    if (!row || row.status !== 'running' || row.owner !== owner || !row.lease_expires_at || row.lease_expires_at <= this.now()) throw new WorkstackError('CLAIM_EXPIRED', 'Wiki generation lease has expired or belongs to another worker.')
  }
  private now(): string { return this.clock.now().toISOString() }
  private expires(): string { return new Date(this.clock.now().getTime() + 120_000).toISOString() }
}

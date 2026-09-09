import { randomUUID } from 'node:crypto'
import type { ProjectStore } from './project-store'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import { systemClock, type Clock } from './clock'

export interface KnowledgeDeliveryEvent {
  id: number
  eventKey: string
  workItemId: string
  prUrl: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  attempts: number
  errorMessage: string | null
  nextAttemptAt: string | null
  owner: string | null
  leaseExpiresAt: string | null
  createdAt: string
  updatedAt: string
}
interface EventRow {
  id: number; event_key: string; work_item_id: string; pr_url: string; status: KnowledgeDeliveryEvent['status']; attempts: number
  error_message: string | null; next_attempt_at: string | null; owner: string | null; lease_expires_at: string | null; created_at: string; updated_at: string
}
export class KnowledgeDeliveryOutbox {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}
  list(): KnowledgeDeliveryEvent[] {
    return (this.store.database.prepare('SELECT * FROM knowledge_delivery_outbox ORDER BY id').all() as EventRow[]).map(decode)
  }
  claimNext(): KnowledgeDeliveryEvent | undefined {
    return this.store.database.transaction(() => {
      const now = this.now()
      // Interrupted attempts count toward the retry budget too. Repair rows left
      // pending at the cap by older versions so an explicit retry remains possible.
      this.store.database.prepare(`UPDATE knowledge_delivery_outbox SET status = 'failed', owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, error_message = COALESCE(error_message, 'Knowledge delivery exhausted its interrupted attempts. Retry explicitly.'), updated_at = ?
        WHERE attempts >= 5 AND (status = 'pending' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`).run(now, now)
      this.store.database.prepare("UPDATE knowledge_delivery_outbox SET status = 'pending', owner = NULL, lease_expires_at = NULL WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(now)
      const row = this.store.database.prepare(`SELECT * FROM knowledge_delivery_outbox WHERE attempts < 5 AND
        (status = 'pending' OR (status = 'failed' AND next_attempt_at <= ?)) ORDER BY id LIMIT 1`).get(now) as EventRow | undefined
      if (!row) return undefined
      this.store.database.prepare("UPDATE knowledge_delivery_outbox SET status = 'running', owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(randomUUID(), new Date(this.clock.now().getTime() + 120_000).toISOString(), now, row.id)
      return this.get(row.id)
    }).immediate()
  }
  complete(id: number, owner: string): void {
    this.store.database.transaction(() => {
      this.requireOwner(id, owner)
      this.store.database.prepare("UPDATE knowledge_delivery_outbox SET status = 'completed', owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, error_message = NULL, updated_at = ? WHERE id = ?").run(this.now(), id)
    }).immediate()
  }
  fail(id: number, owner: string, error: unknown, retryable = true): void {
    this.store.database.transaction(() => {
      const event = this.requireOwner(id, owner)
      const next = retryable && event.attempts < 5 ? new Date(this.clock.now().getTime() + Math.min(3600, 30 * 2 ** (event.attempts - 1)) * 1000).toISOString() : null
      this.store.database.prepare("UPDATE knowledge_delivery_outbox SET status = 'failed', owner = NULL, lease_expires_at = NULL, next_attempt_at = ?, error_message = ?, updated_at = ? WHERE id = ?")
        .run(next, redactEvidence(error instanceof Error ? error.message : String(error)).slice(0, 2000), this.now(), id)
    }).immediate()
  }
  retry(id: number): KnowledgeDeliveryEvent {
    return this.store.database.transaction(() => {
      const event = this.get(id)
      if (event.status !== 'failed') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only failed knowledge deliveries can be retried.')
      this.store.database.prepare("UPDATE knowledge_delivery_outbox SET status = 'pending', attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id)
      return this.get(id)
    }).immediate()
  }
  private requireOwner(id: number, owner: string): KnowledgeDeliveryEvent {
    const event = this.get(id)
    if (event.owner !== owner || event.status !== 'running' || !event.leaseExpiresAt || event.leaseExpiresAt <= this.now()) throw new WorkstackError('CLAIM_EXPIRED', 'The knowledge delivery lease is no longer current.')
    return event
  }
  private get(id: number): KnowledgeDeliveryEvent {
    const row = this.store.database.prepare('SELECT * FROM knowledge_delivery_outbox WHERE id = ?').get(id) as EventRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'Knowledge delivery event not found.')
    return decode(row)
  }
  private now(): string { return this.clock.now().toISOString() }
}
function decode(row: EventRow): KnowledgeDeliveryEvent {
  return { id: row.id, eventKey: row.event_key, workItemId: row.work_item_id, prUrl: row.pr_url, status: row.status, attempts: row.attempts, errorMessage: row.error_message, nextAttemptAt: row.next_attempt_at, owner: row.owner, leaseExpiresAt: row.lease_expires_at, createdAt: row.created_at, updatedAt: row.updated_at }
}

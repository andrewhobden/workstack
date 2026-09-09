import { randomUUID } from 'node:crypto'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import type { ProjectStore } from './project-store'
import { systemClock, type Clock } from './clock'

export interface KnowledgeIntakeJob {
  id: string
  sourceId: string
  processor: string
  stage: string
  payload: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  attempts: number
  owner: string | null
  leaseExpiresAt: string | null
  nextAttemptAt: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}
interface JobRow {
  id: string; source_id: string; processor: string; stage: string; payload_json: string; status: KnowledgeIntakeJob['status']; attempts: number
  owner: string | null; lease_expires_at: string | null; next_attempt_at: string | null; error_message: string | null; created_at: string; updated_at: string
}
/** One durable lease protocol for legacy completion indexing and versioned source intake. */
export class KnowledgeJobsRepository {
  constructor(private readonly store: ProjectStore, private readonly dependencies: { clock?: Clock; leaseSeconds?: number } = {}) {}

  enqueue(sourceId: string, requestKey: string, input: { processor: 'legacy' | 'catalog' | 'semantic'; stage?: string; payload?: Record<string, unknown> }): KnowledgeIntakeJob {
    if (!requestKey.trim()) throw new WorkstackError('VALIDATION_ERROR', 'An intake request key is required.')
    const now = this.now()
    this.store.database.prepare(`INSERT INTO knowledge_jobs
      (id,source_id,status,attempts,created_at,updated_at,processor,stage,payload_json,request_key)
      VALUES (?,?,'pending',0,?,?,?,?,?,?) ON CONFLICT(request_key) WHERE request_key IS NOT NULL DO NOTHING`)
      .run(randomUUID(), sourceId, now, now, input.processor, input.stage ?? 'intake', JSON.stringify(input.payload ?? {}), requestKey)
    const row = this.store.database.prepare('SELECT * FROM knowledge_jobs WHERE request_key = ?').get(requestKey) as JobRow
    if (row.source_id !== sourceId || row.processor !== input.processor) throw new WorkstackError('VALIDATION_ERROR', 'This intake key belongs to another source or processor.')
    return decode(row)
  }

  list(processor?: string): KnowledgeIntakeJob[] {
    return (this.store.database.prepare('SELECT * FROM knowledge_jobs WHERE (? IS NULL OR processor = ?) ORDER BY created_at, rowid').all(processor ?? null, processor ?? null) as JobRow[]).map(decode)
  }

  claimNext(processor: string): { job: KnowledgeIntakeJob; owner: string } | undefined {
    return this.store.database.transaction(() => {
      const now = this.now()
      this.store.database.prepare(`UPDATE knowledge_jobs SET status = 'failed', owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, error_message = COALESCE(error_message, 'Knowledge intake exhausted its interrupted attempts. Retry explicitly.'), updated_at = ?
        WHERE processor = ? AND attempts >= 5 AND (status = 'pending' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`).run(now, processor, now)
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'pending', owner = NULL, lease_expires_at = NULL WHERE processor = ? AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(processor, now)
      const row = this.store.database.prepare(`SELECT * FROM knowledge_jobs WHERE processor = ? AND attempts < 5 AND
        (status = 'pending' OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)) ORDER BY created_at, rowid LIMIT 1`).get(processor, now) as JobRow | undefined
      if (!row) return undefined
      const owner = randomUUID()
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'running', attempts = attempts + 1, owner = ?, lease_expires_at = ?, updated_at = ?, error_message = NULL WHERE id = ?").run(owner, this.expiry(), now, row.id)
      return { job: this.get(row.id), owner }
    }).immediate()
  }

  heartbeat(id: string, owner: string): void {
    return this.store.database.transaction(() => {
      this.assertOwner(id, owner)
      this.store.database.prepare('UPDATE knowledge_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner = ?').run(this.expiry(), this.now(), id, owner)
    }).immediate()
  }

  advance(id: string, owner: string, stage: string, payload?: Record<string, unknown>): KnowledgeIntakeJob {
    return this.store.database.transaction(() => {
      this.assertOwner(id, owner)
      this.store.database.prepare('UPDATE knowledge_jobs SET stage = ?, payload_json = COALESCE(?,payload_json), updated_at = ? WHERE id = ? AND owner = ?').run(stage, payload === undefined ? null : JSON.stringify(payload), this.now(), id, owner)
      return this.get(id)
    }).immediate()
  }

  complete(id: string, owner: string): void {
    return this.store.database.transaction(() => {
      this.assertOwner(id, owner)
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'completed', stage = 'complete', owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND owner = ?").run(this.now(), id, owner)
    }).immediate()
  }

  fail(id: string, owner: string, error: unknown, options: { retryable?: boolean } = {}): void {
    return this.store.database.transaction(() => {
      const job = this.assertOwner(id, owner)
      const delay = Math.min(3600, 30 * 2 ** Math.max(0, job.attempts - 1))
      const next = options.retryable && job.attempts < 5 ? new Date(this.clock().now().getTime() + delay * 1000).toISOString() : null
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'failed', owner = NULL, lease_expires_at = NULL, error_message = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND owner = ?").run(redactEvidence(error instanceof Error ? error.message : String(error)).slice(0, 2000), next, this.now(), id, owner)
    }).immediate()
  }

  retry(id: string): KnowledgeIntakeJob {
    return this.store.database.transaction(() => {
      const job = this.get(id)
      if (job.status !== 'failed') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only failed intake jobs can be retried.')
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'pending', attempts = 0, owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id)
      return this.get(id)
    }).immediate()
  }

  cancel(id: string): KnowledgeIntakeJob {
    return this.store.database.transaction(() => {
      const job = this.get(id)
      if (job.status === 'completed') throw new WorkstackError('INVALID_STATE_TRANSITION', 'A completed intake cannot be cancelled.')
      this.store.database.prepare("UPDATE knowledge_jobs SET status = 'failed', stage = 'cancelled', owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, error_message = 'Cancelled by user', updated_at = ? WHERE id = ?").run(this.now(), id)
      return this.get(id)
    }).immediate()
  }

  assertOwner(id: string, owner: string): KnowledgeIntakeJob {
    const job = this.get(id)
    if (job.status !== 'running' || job.owner !== owner || !job.leaseExpiresAt || job.leaseExpiresAt <= this.now()) throw new WorkstackError('CLAIM_EXPIRED', 'This intake lease has expired or belongs to another worker.')
    return job
  }

  private get(id: string): KnowledgeIntakeJob {
    const row = this.store.database.prepare('SELECT * FROM knowledge_jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The intake job does not exist.')
    return decode(row)
  }
  private clock(): Clock { return this.dependencies.clock ?? systemClock }
  private now(): string { return this.clock().now().toISOString() }
  private expiry(): string { return new Date(this.clock().now().getTime() + (this.dependencies.leaseSeconds ?? 120) * 1000).toISOString() }
}
function decode(row: JobRow): KnowledgeIntakeJob {
  return { id: row.id, sourceId: row.source_id, processor: row.processor, stage: row.stage, payload: JSON.parse(row.payload_json) as Record<string, unknown>, status: row.status, attempts: row.attempts, owner: row.owner, leaseExpiresAt: row.lease_expires_at, nextAttemptAt: row.next_attempt_at, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at }
}

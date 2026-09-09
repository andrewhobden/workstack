import { randomUUID } from 'node:crypto'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import type { ProjectStore } from './project-store'
import type { ContextPacket } from './context-packet-contracts'
import { contextFeedbackInputSchema, contextFeedbackTriageSchema, type ContextFeedback, type ContextFeedbackEvent, type ContextFeedbackInput, type ContextFeedbackTriage } from './context-feedback-contracts'

interface FeedbackRow {
  id: string; work_item_id: string; packet_id: string; category: ContextFeedback['category']; note: string; source_references_json: string
  actor: string; author_kind: 'human' | 'agent'; status: ContextFeedback['status']; action: ContextFeedback['action']; target: string | null
  triage_note: string | null; triaged_by: string | null; version: number; created_at: string; updated_at: string
}

/** Feedback is a report to investigate. Recording or triaging it never changes accepted project knowledge. */
export class ContextFeedbackRepository {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  create(input: ContextFeedbackInput): ContextFeedback {
    const parsed = contextFeedbackInputSchema.parse(input)
    return this.store.database.transaction(() => {
      if (!this.store.database.prepare('SELECT id FROM work_items WHERE id=?').get(parsed.workItemId)) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'Feedback requires a work item in this project.')
      const row = this.store.database.prepare('SELECT work_item_id,packet_json FROM context_packets WHERE id=?').get(parsed.packetId) as { work_item_id: string; packet_json: string } | undefined
      if (!row || row.work_item_id !== parsed.workItemId) throw new WorkstackError('VALIDATION_ERROR', 'The context packet must belong to the selected work item and project.')
      const packet = JSON.parse(row.packet_json) as ContextPacket
      if (packet.projectId !== this.store.project.id) throw new WorkstackError('VALIDATION_ERROR', 'The context packet belongs to a different project.')
      const references: ContextFeedback['sourceReferences'] = [...new Set(parsed.sourceIds)].map((sourceId) => {
        const source = this.store.database.prepare('SELECT current_revision_id FROM source_catalog WHERE id=?').get(sourceId) as { current_revision_id: string | null } | undefined
        if (!source) throw new WorkstackError('VALIDATION_ERROR', 'Feedback source IDs must belong to this project.')
        return { sourceId, revisionId: source.current_revision_id, packetRevisionId: packet.manifest.find((entry) => entry.sourceId === sourceId)?.revisionId ?? null }
      })
      const id = `feedback:${randomUUID()}`
      const now = this.now()
      this.store.database.prepare('INSERT INTO context_feedback (id,work_item_id,packet_id,category,note,source_references_json,actor,author_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, parsed.workItemId, parsed.packetId, parsed.category, redactEvidence(parsed.note), JSON.stringify(references), redactEvidence(parsed.actor), parsed.authorKind, now, now)
      this.event(id, parsed.actor, 'Submitted for investigation.')
      return this.get(id)
    }).immediate()
  }
  get(id: string): ContextFeedback {
    const row = this.store.database.prepare('SELECT * FROM context_feedback WHERE id=?').get(id) as FeedbackRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The context feedback does not exist in this project.')
    return decode(row)
  }
  list(options: { workItemId?: string; packetId?: string; status?: ContextFeedback['status']; limit?: number } = {}): ContextFeedback[] {
    const clauses: string[] = []
    const bindings: string[] = []
    if (options.workItemId) { clauses.push('work_item_id=?'); bindings.push(options.workItemId) }
    if (options.packetId) { clauses.push('packet_id=?'); bindings.push(options.packetId) }
    if (options.status) { clauses.push('status=?'); bindings.push(options.status) }
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
    return (this.store.database.prepare(`SELECT * FROM context_feedback ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(...bindings, limit) as FeedbackRow[]).map(decode)
  }
  triage(id: string, input: ContextFeedbackTriage): ContextFeedback {
    const parsed = contextFeedbackTriageSchema.parse(input)
    return this.store.database.transaction(() => {
      const existing = this.get(id)
      if (existing.version !== parsed.expectedVersion) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The feedback changed. Reload it before triaging.')
      if (parsed.status === 'dismissed' && parsed.action !== 'no_change') throw new WorkstackError('VALIDATION_ERROR', 'Dismissed feedback must explain why no change is needed.')
      if (parsed.status === 'resolved' && parsed.action !== 'no_change' && !parsed.target) throw new WorkstackError('VALIDATION_ERROR', 'Resolved feedback must link the fixture or independently reviewed knowledge correction.')
      this.store.database.prepare('UPDATE context_feedback SET status=?,action=?,target=?,triage_note=?,triaged_by=?,version=version+1,updated_at=? WHERE id=?')
        .run(parsed.status, parsed.action, parsed.target ? redactEvidence(parsed.target) : null, redactEvidence(parsed.note), redactEvidence(parsed.actor), this.now(), id)
      this.event(id, parsed.actor, parsed.note)
      return this.get(id)
    }).immediate()
  }
  history(id: string): ContextFeedbackEvent[] {
    this.get(id)
    return (this.store.database.prepare('SELECT * FROM context_feedback_events WHERE feedback_id=? ORDER BY id DESC').all(id) as Array<{ id: number; feedback_id: string; actor: string; note: string; created_at: string; snapshot_json: string }>)
      .map((row) => ({ id: row.id, feedbackId: row.feedback_id, actor: row.actor, note: row.note, createdAt: row.created_at, snapshot: JSON.parse(row.snapshot_json) as ContextFeedback }))
  }
  private event(id: string, actor: string, note: string): void { this.store.database.prepare('INSERT INTO context_feedback_events (feedback_id,actor,note,created_at,snapshot_json) VALUES (?,?,?,?,?)').run(id, redactEvidence(actor), redactEvidence(note), this.now(), JSON.stringify(this.get(id))) }
  private now(): string { return this.clock.now().toISOString() }
}
function decode(row: FeedbackRow): ContextFeedback { return { id: row.id, workItemId: row.work_item_id, packetId: row.packet_id, category: row.category, note: row.note, sourceReferences: JSON.parse(row.source_references_json) as ContextFeedback['sourceReferences'], actor: row.actor, authorKind: row.author_kind, status: row.status, action: row.action, target: row.target, triageNote: row.triage_note, triagedBy: row.triaged_by, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, trust: 'untrusted_reference' } }

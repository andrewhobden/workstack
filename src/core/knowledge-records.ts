import { createHash, randomUUID } from 'node:crypto'
import type { ProjectStore } from './project-store'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import { SourceCatalogRepository } from './source-catalog'
import { sourceSearchExpression } from './source-passages'
import { inspectKnowledgeReference, referenceKey } from './knowledge-references'
import { projectStructuredKnowledgeGraph } from './structured-knowledge-graph'
import { knowledgeRecordInputSchema, recordStatuses, type KnowledgeFinding, type KnowledgeRecord, type KnowledgeRecordHistory, type KnowledgeRecordInput, type KnowledgeRecordKind, type KnowledgeRecordStatus, type KnowledgeRecordUpdate, type KnowledgeReview } from './knowledge-record-contracts'

interface RecordRow {
  id: string; kind: KnowledgeRecordKind; title: string; status: KnowledgeRecordStatus; markdown: string; rationale: string; references_json: string
  superseded_by: string | null; confidence: number | null; review_due_at: string | null; last_reviewed_at: string | null
  version: number; created_at: string; updated_at: string
}
const historicalStatuses = new Set<KnowledgeRecordStatus>(['superseded', 'rejected', 'fulfilled', 'withdrawn', 'closed'])

export class KnowledgeRecordsRepository {
  constructor(private readonly store: ProjectStore, private readonly dependencies: { clock?: Clock } = {}) {}

  create(input: KnowledgeRecordInput, actor = 'local-user'): KnowledgeRecord {
    const parsed = this.validate(input)
    if (parsed.status === 'superseded') throw new WorkstackError('VALIDATION_ERROR', 'Use supersede to link a record to its replacement.')
    return this.store.database.transaction(() => {
      const id = `record:${randomUUID()}`
      const now = this.now()
      this.store.database.prepare(`INSERT INTO knowledge_records (id,kind,title,status,markdown,rationale,references_json,confidence,review_due_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, parsed.kind, parsed.title, parsed.status, parsed.markdown, parsed.rationale, JSON.stringify(parsed.references), parsed.confidence ?? null, parsed.reviewDueAt ?? null, now, now)
      this.saved(id, actor, 'Created record.')
      return this.get(id)
    }).immediate()
  }

  update(id: string, input: KnowledgeRecordUpdate, actor = 'local-user', reason = 'Updated record.'): KnowledgeRecord {
    return this.store.database.transaction(() => {
      const existing = this.get(id)
      if (existing.version !== input.expectedVersion) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The record changed. Reload it before applying your edits.')
      if (existing.status === 'superseded' || input.status === 'superseded') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Superseded records preserve their original rationale; use the replacement record for new guidance.')
      const parsed = this.validate({ ...existing, ...input,
        confidence: input.confidence === null ? undefined : input.confidence ?? existing.confidence,
        reviewDueAt: input.reviewDueAt === null ? undefined : input.reviewDueAt ?? existing.reviewDueAt })
      this.store.database.prepare(`UPDATE knowledge_records SET title=?,status=?,markdown=?,rationale=?,references_json=?,confidence=?,review_due_at=?,version=version+1,updated_at=? WHERE id=?`)
        .run(parsed.title, parsed.status, parsed.markdown, parsed.rationale, JSON.stringify(parsed.references), parsed.confidence ?? null, parsed.reviewDueAt ?? null, this.now(), id)
      this.saved(id, actor, reason)
      return this.get(id)
    }).immediate()
  }

  get(id: string): KnowledgeRecord {
    const row = this.store.database.prepare('SELECT * FROM knowledge_records WHERE id=?').get(id) as RecordRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The knowledge record does not exist in this project.')
    return this.decode(row)
  }

  list(options: { kind?: KnowledgeRecordKind; includeHistorical?: boolean; limit?: number } = {}): KnowledgeRecord[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 200)))
    return (this.store.database.prepare('SELECT * FROM knowledge_records ORDER BY updated_at DESC,id').all() as RecordRow[])
      .filter((row) => (!options.kind || row.kind === options.kind) && (options.includeHistorical || !historicalStatuses.has(row.status))).slice(0, limit).map((row) => this.decode(row))
  }

  search(query: string, options: { includeHistorical?: boolean; limit?: number } = {}): KnowledgeRecord[] {
    const expression = sourceSearchExpression(query)
    if (!expression) return []
    const rows = this.store.database.prepare(`SELECT r.* FROM knowledge_record_search JOIN knowledge_records r ON r.id=knowledge_record_search.record_id
      WHERE knowledge_record_search MATCH ? ORDER BY bm25(knowledge_record_search),r.id LIMIT 500`).all(expression) as RecordRow[]
    return rows.filter((row) => options.includeHistorical || !historicalStatuses.has(row.status)).slice(0, Math.max(1, Math.min(100, options.limit ?? 20))).map((row) => this.decode(row))
  }

  supersede(id: string, replacementId: string, actor: string, reason: string): KnowledgeRecord {
    requireActor(actor, reason)
    return this.store.database.transaction(() => {
      const original = this.get(id)
      const replacement = this.get(replacementId)
      if (id === replacementId || original.kind !== replacement.kind || original.status === 'superseded' || !replacement.current) throw new WorkstackError('INVALID_STATE_TRANSITION', 'A replacement must be a different current record of the same kind.')
      let cursor: string | undefined = replacementId
      const visited = new Set([id])
      while (cursor) {
        if (visited.has(cursor)) throw new WorkstackError('VALIDATION_ERROR', 'Supersession links cannot form a cycle.')
        visited.add(cursor)
        cursor = this.get(cursor).supersededBy
      }
      this.store.database.prepare("UPDATE knowledge_records SET status='superseded',superseded_by=?,version=version+1,updated_at=? WHERE id=?").run(replacementId, this.now(), id)
      this.saved(id, actor, reason)
      return this.get(id)
    }).immediate()
  }

  review(id: string, input: { actor: string; note: string; outcome: 'confirmed' | 'needs_changes'; reviewDueAt?: string; expectedVersion?: number }): KnowledgeReview {
    requireActor(input.actor, input.note)
    if (!['confirmed', 'needs_changes'].includes(input.outcome) || (input.reviewDueAt && !Number.isFinite(Date.parse(input.reviewDueAt)))) throw new WorkstackError('VALIDATION_ERROR', 'Review outcome and due date must be valid.')
    return this.store.database.transaction(() => {
      const record = this.get(id)
      if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The record changed. Reload its current content before recording a review.')
      const review: KnowledgeReview = { id: randomUUID(), recordId: id, actor: redactEvidence(input.actor.trim()), note: redactEvidence(input.note.trim()), outcome: input.outcome, reviewedAt: this.now(), recordVersion: record.version }
      this.store.database.prepare('INSERT INTO knowledge_record_reviews (id,record_id,actor,note,outcome,reviewed_at,record_version) VALUES (?,?,?,?,?,?,?)')
        .run(review.id, id, review.actor, review.note, review.outcome, review.reviewedAt, record.version)
      if (input.outcome === 'confirmed') this.store.database.prepare('UPDATE knowledge_records SET last_reviewed_at=?,review_due_at=? WHERE id=?').run(review.reviewedAt, input.reviewDueAt ?? null, id)
      else if (input.reviewDueAt) this.store.database.prepare('UPDATE knowledge_records SET review_due_at=? WHERE id=?').run(input.reviewDueAt, id)
      return review
    }).immediate()
  }

  reviews(id: string): KnowledgeReview[] {
    this.get(id)
    return (this.store.database.prepare('SELECT * FROM knowledge_record_reviews WHERE record_id=? ORDER BY rowid DESC').all(id) as Array<{ id: string; record_id: string; actor: string; note: string; outcome: KnowledgeReview['outcome']; reviewed_at: string; record_version: number }>)
      .map((row) => ({ id: row.id, recordId: row.record_id, actor: row.actor, note: row.note, outcome: row.outcome, reviewedAt: row.reviewed_at, recordVersion: row.record_version }))
  }

  history(id: string): KnowledgeRecordHistory[] {
    this.get(id)
    return (this.store.database.prepare('SELECT * FROM knowledge_record_history WHERE record_id=? ORDER BY version DESC').all(id) as Array<{ version: number; actor: string; reason: string; changed_at: string; snapshot_json: string }>)
      .map((row) => ({ version: row.version, actor: row.actor, reason: row.reason, changedAt: row.changed_at, snapshot: JSON.parse(row.snapshot_json) as KnowledgeRecord }))
  }

  readMarkdown(id: string): string {
    const record = this.get(id)
    return `# ${record.title}\n\n- ID: ${record.id}\n- Type: ${record.kind}\n- Status: ${record.status}\n- Version: ${record.version}\n${record.supersededBy ? `- Superseded by: ${record.supersededBy}\n` : ''}${record.lastReviewedAt ? `- Last reviewed: ${record.lastReviewedAt}\n` : ''}\n${record.markdown}\n\n## Rationale\n\n${record.rationale || 'Not recorded.'}\n\n## Evidence and references\n\n${record.references.map((reference) => `- ${referenceKey(reference)}`).join('\n') || 'No evidence recorded.'}\n`
  }

  checks(): KnowledgeFinding[] {
    const findings: KnowledgeFinding[] = []
    const rows = this.store.database.prepare('SELECT * FROM knowledge_records ORDER BY id').all() as RecordRow[]
    const add = (recordId: string, code: KnowledgeFinding['code'], severity: KnowledgeFinding['severity'], reason: string, action: string, reference?: KnowledgeFinding['reference']) => {
      const key = `${code}:${recordId}:${reference ? referenceKey(reference) : ''}`
      findings.push({ id: `finding:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, code, severity, recordId, locator: `knowledge-record://${recordId}`, reason, action, reference })
    }
    for (const row of rows) {
      let record: KnowledgeRecord
      try {
        record = this.decode(row)
        this.validate(record)
        if ((record.status === 'superseded') !== Boolean(record.supersededBy) || !Number.isInteger(record.version) || record.version < 1) throw new Error('Record status or revision metadata is inconsistent.')
      } catch (error) { add(row.id, 'invalid_metadata', 'error', error instanceof Error ? error.message : 'Invalid record metadata.', 'Repair the record metadata before using it as guidance.'); continue }
      if (record.current && !record.references.some((reference) => reference.kind === 'source' || reference.kind === 'file' || reference.kind === 'wiki')) add(record.id, 'missing_evidence', 'warning', `This ${record.status} ${record.kind} has no supporting source, file, or article.`, 'Attach supporting evidence or change the record status.')
      for (const reference of record.references) {
        const result = inspectKnowledgeReference(this.store, reference, this.clock())
        if (result) add(record.id, result.code, result.code === 'broken_reference' ? 'error' : 'warning', result.reason, 'Repair the link, refresh the source, or select current supporting evidence.', reference)
      }
      const visited = new Set([record.id])
      let next = record.supersededBy
      while (next) {
        if (visited.has(next)) { add(record.id, 'supersession_cycle', 'error', 'This record is part of a supersession cycle.', 'Remove the invalid replacement link and choose a current record.'); break }
        visited.add(next)
        const replacement = rows.find((candidate) => candidate.id === next)
        if (!replacement || replacement.kind !== record.kind) { add(record.id, 'broken_reference', 'error', 'The replacement record is missing or has a different type.', 'Select a valid replacement of the same type.'); break }
        next = replacement.superseded_by ?? undefined
      }
      if (!historicalStatuses.has(record.status) && record.reviewDueAt && record.reviewDueAt <= this.now()) add(record.id, 'review_due', 'info', 'The scheduled review is due. Age alone does not mean the guidance is incorrect.', 'Review the evidence and explicitly confirm the record or request changes.')
      if (record.kind === 'decision' && record.status === 'proposed') add(record.id, 'unresolved_decision', 'warning', 'This decision is proposed and has not been accepted.', 'Resolve the decision before treating it as governing guidance.')
      if (this.reviews(record.id)[0]?.outcome === 'needs_changes') add(record.id, 'review_requested', 'warning', 'The latest review requested changes.', 'Repair the record and record a new review after checking the evidence.')
    }
    return findings.sort((left, right) => left.id.localeCompare(right.id))
  }

  private validate(input: KnowledgeRecordInput) {
    const parsed = knowledgeRecordInputSchema.parse(input)
    const status = parsed.status ?? (parsed.kind === 'risk' ? 'open' : 'proposed')
    if (!recordStatuses[parsed.kind].includes(status)) throw new WorkstackError('VALIDATION_ERROR', `Status ${status} is invalid for a ${parsed.kind}.`)
    return { ...parsed, title: redactEvidence(parsed.title), markdown: redactEvidence(parsed.markdown), rationale: redactEvidence(parsed.rationale ?? ''), references: parsed.references ?? [], status }
  }
  private decode(row: RecordRow): KnowledgeRecord {
    const references = JSON.parse(row.references_json) as KnowledgeRecord['references']
    const current = row.kind === 'decision' ? row.status === 'accepted' : row.kind === 'requirement' ? row.status === 'active' : ['open', 'accepted', 'mitigated'].includes(row.status)
    const historical = historicalStatuses.has(row.status)
    const lastReview = this.store.database.prepare('SELECT outcome FROM knowledge_record_reviews WHERE record_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as { outcome: string } | undefined
    const needsReview = !current || !references.some((reference) => ['source', 'file', 'wiki'].includes(reference.kind)) || Boolean(row.review_due_at && row.review_due_at <= this.now()) || lastReview?.outcome === 'needs_changes' || references.some((reference) => inspectKnowledgeReference(this.store, reference, this.clock()))
    return { id: row.id, kind: row.kind, title: row.title, status: row.status, markdown: row.markdown, rationale: row.rationale, references, supersededBy: row.superseded_by ?? undefined, confidence: row.confidence ?? undefined,
      reviewDueAt: row.review_due_at ?? undefined, lastReviewedAt: row.last_reviewed_at ?? undefined, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, current,
      readiness: historical ? 'historical' : needsReview ? 'needs_review' : 'ready', locator: `knowledge-record://${row.id}`, trust: 'untrusted_reference' }
  }
  private saved(id: string, actor: string, reason: string): void {
    requireActor(actor, reason)
    const record = this.get(id)
    this.store.database.prepare('INSERT INTO knowledge_record_history (record_id,version,actor,reason,changed_at,snapshot_json) VALUES (?,?,?,?,?,?)').run(id, record.version, redactEvidence(actor), redactEvidence(reason), this.now(), JSON.stringify(record))
    projectStructuredKnowledgeGraph(this.store, record)
    this.store.database.prepare('DELETE FROM knowledge_record_search WHERE record_id=?').run(id)
    this.store.database.prepare('INSERT INTO knowledge_record_search (record_id,title,markdown,rationale) VALUES (?,?,?,?)').run(id, record.title, record.markdown, record.rationale)
    this.store.database.prepare("DELETE FROM source_dependents WHERE artifact_kind='knowledge_record' AND artifact_id=?").run(id)
    const catalog = new SourceCatalogRepository(this.store, { clock: this.clock() })
    for (const reference of record.references) if (reference.kind === 'source' && !inspectKnowledgeReference(this.store, reference, this.clock())) catalog.linkDependent(reference.citation.sourceId, reference.citation.revisionId, 'knowledge_record', id)
  }
  private clock(): Clock { return this.dependencies.clock ?? systemClock }
  private now(): string { return this.clock().now().toISOString() }
}
function requireActor(actor: string, reason: string): void {
  if (!actor.trim() || actor.length > 200 || !reason.trim() || reason.length > 20_000) throw new WorkstackError('VALIDATION_ERROR', 'An actor and meaningful change or review reason are required.')
}

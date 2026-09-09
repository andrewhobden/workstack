import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import { KnowledgeJobsRepository, type KnowledgeIntakeJob } from './knowledge-jobs'
import { SOURCE_PASSAGE_LIMITS, hashSourceText, sourceSearchExpression, splitSourcePassages } from './source-passages'
import type { ProjectStore } from './project-store'
import { readWikiPageCitations } from './wiki-source-evidence'

export type SourceKind = 'repo_file' | 'github_file' | 'github_issue' | 'github_pr' | 'manual' | 'work_completion' | 'wiki' | 'file'
export type SourcePolicy = 'import_once' | 'tracked_content' | 'metadata_only' | 'paused'
export type SourceReadiness = 'ready' | 'stale' | 'refresh_pending' | 'unavailable'
export interface ProjectSource {
  id: string; kind: SourceKind; title: string; canonicalUri: string; repositoryPath?: string; workItemId?: string
  policy: SourcePolicy; state: SourceReadiness; currentRevisionId?: string; observedUpstreamRevision?: string; verifiedUpstreamRevision?: string
  refreshSeconds: number; lastAttemptAt?: string; lastSuccessfulCheckAt?: string; lastContentChangeAt?: string
  nextRefreshAt?: string; staleReason?: string; deletedAt?: string; createdAt: string; updatedAt: string
}
export interface SourceRevision {
  id: string; sourceId: string; contentHash: string; normalizedHash: string; upstreamRevision?: string
  acquiredBy: string; acquiredAt: string; converter: string; converterVersion: string
  outcome: 'complete' | 'partial' | 'unsupported'; manifest: SourceRevisionManifest
}
export interface SourceRevisionManifest {
  originalCharacters: number; normalizedCharacters: number; passages: number; redacted: boolean
  completeness: 'complete' | 'partial' | 'unsupported'; limitations: string[]; metadata: Record<string, unknown>
  originalLocator: string; normalizedLocator: string; trust: 'untrusted_reference'
}
export interface SourceCitation {
  sourceId: string; revisionId: string; passageId: string; contentHash: string; normalizedHash: string; passageHash: string
  headingTrail: string[]; startLine: number; endLine: number; startOffset: number; endOffset: number; locator: string
}
export interface SourcePassage {
  citation: SourceCitation; title: string; text: string; sourceKind: SourceKind; canonicalUri: string
  historical: boolean; readiness: SourceReadiness; structure: { kind: 'markdown' | 'code'; fence?: string; continued: boolean }
  relevance: number; workItemId?: string; trust: 'untrusted_reference'
}
export interface SourceCitationRead { passage: SourcePassage; neighbors: SourcePassage[]; truncated: boolean; maxCharacters: number }
export interface SourceRevisionRead { revision: SourceRevision; representation: 'original' | 'normalized'; text: string; offset: number; totalCharacters: number; truncated: boolean; trust: 'untrusted_reference' }
export interface SourceIntakeAttempt { id: number; sourceId: string; jobId?: string; attempt: number; stage: string; outcome: string; message?: string; createdAt: string }
export interface SourceDetail { source: ProjectSource; revisions: SourceRevision[]; jobs: KnowledgeIntakeJob[]; attempts: SourceIntakeAttempt[] }
export interface RegisterSourceInput {
  id?: string; kind: SourceKind; title: string; canonicalUri: string; repositoryPath?: string; workItemId?: string
  policy?: SourcePolicy; refreshSeconds?: number
}
export interface PublishSourceInput {
  sourceId: string; original: string; normalized?: string; upstreamRevision?: string; acquiredBy?: string
  converter?: string; converterVersion?: string; outcome?: 'complete' | 'partial' | 'unsupported'
  limitations?: string[]; metadata?: Record<string, unknown>
}
export type SourceAcquisition = Omit<PublishSourceInput, 'sourceId'> | { metadataOnly: true; upstreamRevision?: string } | { unavailable: true; reason: string; deleted?: boolean; retryable?: boolean }
export type SourceAcquirer = (source: ProjectSource, options: { metadataOnly: boolean; payload: Record<string, unknown>; signal: AbortSignal }) => Promise<SourceAcquisition>
export interface SourceInvalidation { sourceId: string; revisionId: string; artifactKind: string; artifactId: string; reason: string; queuedAt: string }

interface SourceRow {
  id: string; kind: SourceKind; title: string; canonical_uri: string; repository_path: string | null; work_item_id: string | null
  policy: SourcePolicy; state: SourceReadiness; current_revision_id: string | null; observed_upstream_revision: string | null; verified_upstream_revision: string | null
  refresh_seconds: number; last_attempt_at: string | null; last_successful_check_at: string | null; last_content_change_at: string | null
  next_refresh_at: string | null; stale_reason: string | null; deleted_at: string | null; created_at: string; updated_at: string
}
interface RevisionRow {
  id: string; source_id: string; content_hash: string; normalized_hash: string; original_text: string; normalized_text: string
  upstream_revision: string | null; acquired_by: string; acquired_at: string; converter: string; converter_version: string
  outcome: SourceRevision['outcome']; manifest_json: string
}
interface PassageRow {
  id: string; source_id: string; revision_id: string; ordinal: number; heading_json: string; start_line: number; end_line: number
  start_offset: number; end_offset: number; text: string; passage_hash: string; structure_json: string; rank?: number
}
interface DependentRow { source_id: string; revision_id: string; artifact_kind: string; artifact_id: string; stale: number; reason: string | null; queued_at: string | null }

const registerSchema = z.object({
  id: z.string().min(1).max(200).optional(), kind: z.enum(['repo_file', 'github_file', 'github_issue', 'github_pr', 'manual', 'work_completion', 'wiki', 'file']),
  title: z.string().trim().min(1).max(1000), canonicalUri: z.string().trim().min(1).max(4000), repositoryPath: z.string().max(2000).optional(),
  workItemId: z.string().optional(), policy: z.enum(['import_once', 'tracked_content', 'metadata_only', 'paused']).default('import_once'),
  refreshSeconds: z.number().int().min(60).max(30 * 86400).default(3600)
})
const MAX_SOURCE_CHARACTERS = 2_000_000
const DERIVED_STALE_REASON = 'Wiki supporting evidence is not current: '
interface FreshnessCache { stamp: string; checkedAt: string; nextExpiry?: string; sources?: Map<string, ProjectSource> }
const freshnessCaches = new WeakMap<Database.Database, FreshnessCache>()

export class SourceCatalogRepository {
  readonly jobs: KnowledgeJobsRepository
  private effectiveSources?: Map<string, ProjectSource>
  constructor(private readonly store: ProjectStore, private readonly dependencies: { clock?: Clock; beforePublish?: () => void } = {}) {
    this.jobs = new KnowledgeJobsRepository(store, dependencies)
    this.refreshDependencies()
  }

  registerSource(input: RegisterSourceInput): ProjectSource {
    const parsed = registerSchema.parse(input)
    parsed.title = redactEvidence(parsed.title)
    return this.store.database.transaction(() => {
      const existing = this.store.database.prepare('SELECT * FROM source_catalog WHERE canonical_uri = ?').get(parsed.canonicalUri) as SourceRow | undefined
      if (existing) {
        if (parsed.workItemId && existing.work_item_id && parsed.workItemId !== existing.work_item_id) {
          // One source can support multiple tasks through dependent references; never rewrite its original association.
          return this.getSource(existing.id)
        }
        if (parsed.workItemId && !existing.work_item_id) this.store.database.prepare('UPDATE source_catalog SET work_item_id = ? WHERE id = ?').run(parsed.workItemId, existing.id)
        return this.getSource(existing.id)
      }
      const id = parsed.id ?? randomUUID()
      const now = this.now()
      const legacyKind = parsed.kind === 'work_completion' ? 'work_completion' : parsed.kind === 'manual' ? 'manual' : parsed.kind === 'repo_file' || parsed.kind === 'file' ? 'file' : 'other'
      this.store.database.prepare(`INSERT OR IGNORE INTO knowledge_sources (id, kind, display_name, relative_or_external_location, source_work_item_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, legacyKind, parsed.title, parsed.repositoryPath ?? parsed.canonicalUri, parsed.workItemId ?? null, now, now)
      this.store.database.prepare(`INSERT INTO source_catalog (id,kind,title,canonical_uri,repository_path,work_item_id,policy,refresh_seconds,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, parsed.kind, parsed.title, parsed.canonicalUri, parsed.repositoryPath ?? null, parsed.workItemId ?? null, parsed.policy, parsed.refreshSeconds, now, now)
      return this.getSource(id)
    }).immediate()
  }

  listSources(): ProjectSource[] {
    this.refreshDependencies()
    return this.effectiveSources ? [...this.effectiveSources.values()].map((source) => ({ ...source })) : (this.store.database.prepare('SELECT * FROM source_catalog ORDER BY title COLLATE NOCASE,id').all() as SourceRow[]).map((row) => this.decodeSource(row))
  }
  getSource(id: string): ProjectSource {
    this.refreshDependencies()
    const row = this.effectiveSources ? undefined : this.store.database.prepare('SELECT * FROM source_catalog WHERE id = ?').get(id) as SourceRow | undefined
    const source = this.effectiveSources?.get(id) ?? (row ? this.decodeSource(row) : undefined)
    if (!source) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The project source does not exist.')
    return { ...source }
  }
  getDetail(id: string): SourceDetail {
    return { source: this.getSource(id), revisions: (this.store.database.prepare('SELECT * FROM source_revisions WHERE source_id = ? ORDER BY acquired_at DESC,id').all(id) as RevisionRow[]).map(decodeRevision), jobs: this.jobs.list('catalog').filter((job) => job.sourceId === id), attempts: (this.store.database.prepare('SELECT * FROM source_intake_events WHERE source_id = ? ORDER BY id DESC LIMIT 100').all(id) as Array<{ id: number; source_id: string; job_id: string | null; attempt: number; stage: string; outcome: string; message: string | null; created_at: string }>).map((row) => ({ id: row.id, sourceId: row.source_id, jobId: row.job_id ?? undefined, attempt: row.attempt, stage: row.stage, outcome: row.outcome, message: row.message ?? undefined, createdAt: row.created_at })) }
  }
  getRevision(sourceId: string, revisionId: string): SourceRevision {
    return decodeRevision(this.revisionRow(sourceId, revisionId))
  }
  getPassage(passageId: string): SourcePassage {
    const row = this.store.database.prepare('SELECT * FROM source_passages WHERE id = ?').get(passageId) as PassageRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The source passage does not exist.')
    return this.decodePassage(row)
  }

  publishRevision(input: PublishSourceInput): SourceRevision {
    if (input.original.length > MAX_SOURCE_CHARACTERS || (input.normalized?.length ?? 0) > MAX_SOURCE_CHARACTERS) throw new WorkstackError('VALIDATION_ERROR', `Source exceeds the ${MAX_SOURCE_CHARACTERS}-character intake limit.`)
    const normalized = redactEvidence((input.normalized ?? input.original).replace(/\r\n?/g, '\n'))
    const outcome = input.outcome ?? 'complete'
    if (!normalized.trim() && outcome === 'complete') throw new WorkstackError('VALIDATION_ERROR', 'A complete source must contain readable text.')
    const contentHash = hashSourceText(input.original)
    const normalizedHash = hashSourceText(normalized)
    const converter = input.converter ?? 'workstack-text'
    const version = input.converterVersion ?? '1'
    const passages = outcome === 'unsupported' ? [] : splitSourcePassages(normalized)
    return this.store.database.transaction(() => {
      const source = this.getSource(input.sourceId)
      let revision = this.store.database.prepare('SELECT * FROM source_revisions WHERE source_id = ? AND content_hash = ? AND normalized_hash = ? AND converter = ? AND converter_version = ? AND outcome = ?').get(source.id, contentHash, normalizedHash, converter, version, outcome) as RevisionRow | undefined
      const now = this.now()
      if (!revision) {
        const id = randomUUID()
        const manifest: SourceRevisionManifest = {
          originalCharacters: input.original.length, normalizedCharacters: normalized.length, passages: passages.length,
          redacted: normalized !== (input.normalized ?? input.original).replace(/\r\n?/g, '\n'), completeness: outcome,
          limitations: (input.limitations ?? []).map(redactEvidence), metadata: redactMetadata(input.metadata ?? {}) as Record<string, unknown>,
          originalLocator: `source://${source.id}/revisions/${id}/original`, normalizedLocator: `source://${source.id}/revisions/${id}/normalized`, trust: 'untrusted_reference'
        }
        this.store.database.prepare(`INSERT INTO source_revisions (id,source_id,content_hash,normalized_hash,original_text,normalized_text,upstream_revision,acquired_by,acquired_at,converter,converter_version,outcome,manifest_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, source.id, contentHash, normalizedHash, input.original, normalized, input.upstreamRevision ?? null, input.acquiredBy ?? 'local-user', now, converter, version, outcome, JSON.stringify(manifest))
        passages.forEach((passage, ordinal) => {
          const passageId = `${id}:${ordinal}`
          this.store.database.prepare(`INSERT INTO source_passages (id,source_id,revision_id,ordinal,heading_json,start_line,end_line,start_offset,end_offset,text,passage_hash,structure_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(passageId, source.id, id, ordinal, JSON.stringify(passage.headingTrail), passage.startLine, passage.endLine, passage.startOffset, passage.endOffset, passage.text, passage.passageHash, JSON.stringify(passage.structure))
          this.store.database.prepare('INSERT INTO source_passage_search (passage_id,title,heading,text) VALUES (?,?,?,?)').run(passageId, source.title, passage.headingTrail.join(' > '), passage.text)
        })
        this.dependencies.beforePublish?.()
        revision = this.revisionRow(source.id, id)
      }
      if (outcome === 'complete') {
        if (source.currentRevisionId !== revision.id) this.invalidate(source.id, 'Source content changed.', revision.id)
        this.store.database.prepare(`UPDATE source_catalog SET current_revision_id = ?, state = 'ready', observed_upstream_revision = ?, verified_upstream_revision = ?,
          last_attempt_at = ?, last_successful_check_at = ?, last_content_change_at = CASE WHEN current_revision_id IS NOT ? THEN ? ELSE last_content_change_at END,
          next_refresh_at = ?, stale_reason = NULL, deleted_at = NULL, updated_at = ? WHERE id = ?`)
          .run(revision.id, input.upstreamRevision ?? null, input.upstreamRevision ?? null, now, now, revision.id, now, this.nextRefresh(source), now, source.id)
        this.store.database.prepare("UPDATE knowledge_sources SET status = 'indexed', content_hash = ?, error_message = NULL, updated_at = ? WHERE id = ?").run(contentHash, now, source.id)
      } else {
        this.recordFreshness(source.id, { unavailable: true, reason: input.limitations?.join(' ') || `Source conversion is ${outcome}.` })
      }
      this.event(source.id, undefined, 'publish', outcome, `${revision.id}: ${passages.length} passages`)
      this.refreshDependencies()
      return decodeRevision(revision)
    }).immediate()
  }

  updatePolicy(sourceId: string, policy: SourcePolicy, refreshSeconds?: number): ProjectSource {
    const source = this.getSource(sourceId)
    const parsed = registerSchema.parse({ ...source, policy, refreshSeconds: refreshSeconds ?? source.refreshSeconds })
    this.store.database.prepare('UPDATE source_catalog SET policy = ?, refresh_seconds = ?, next_refresh_at = ?, updated_at = ? WHERE id = ?')
      .run(policy, parsed.refreshSeconds, policy === 'import_once' || policy === 'paused' ? null : this.now(), this.now(), sourceId)
    if (policy === 'paused') {
      for (const job of this.jobs.list('catalog').filter((job) => job.sourceId === sourceId && (job.status === 'pending' || job.status === 'running'))) this.cancelJob(job.id)
      this.invalidate(sourceId, 'Source refresh is paused.')
    }
    return this.getSource(sourceId)
  }

  recordFreshness(sourceId: string, result: { upstreamRevision?: string; metadataOnly?: boolean } | { unavailable: true; reason: string; deleted?: boolean }): ProjectSource {
    return this.store.database.transaction(() => {
      const source = this.getSource(sourceId)
      const now = this.now()
      if ('unavailable' in result) {
        const reason = redactEvidence(result.reason).slice(0, 2000)
        this.store.database.prepare("UPDATE source_catalog SET state = 'unavailable', last_attempt_at = ?, stale_reason = ?, deleted_at = ?, next_refresh_at = ?, updated_at = ? WHERE id = ?")
          .run(now, reason, result.deleted ? now : null, this.nextRefresh(source), now, sourceId)
        this.invalidate(sourceId, reason)
      } else {
        const changed = result.upstreamRevision !== undefined && result.upstreamRevision !== source.verifiedUpstreamRevision
        const ready = Boolean(source.currentRevisionId) && !changed
        const reason = !source.currentRevisionId ? 'No complete content snapshot is available.' : changed ? 'Upstream metadata changed; content refresh is required.' : null
        this.store.database.prepare('UPDATE source_catalog SET state = ?, observed_upstream_revision = COALESCE(?, observed_upstream_revision), last_attempt_at = ?, last_successful_check_at = ?, next_refresh_at = ?, stale_reason = ?, deleted_at = NULL, updated_at = ? WHERE id = ?')
          .run(ready ? 'ready' : 'stale', result.upstreamRevision ?? null, now, now, this.nextRefresh(source), reason, now, sourceId)
        if (reason !== null) this.invalidate(sourceId, reason)
      }
      return this.getSource(sourceId)
    }).immediate()
  }

  queueImport(sourceId: string, requestKey: string, payload: Record<string, unknown> = {}): KnowledgeIntakeJob {
    return this.store.database.transaction(() => {
      const source = this.getSource(sourceId)
      if (source.policy === 'paused') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Resume the source before refreshing it.')
      const active = this.jobs.list('catalog').find((job) => job.sourceId === sourceId && (job.status === 'pending' || job.status === 'running' || job.status === 'failed' && job.nextAttemptAt))
      if (active) return active
      const job = this.jobs.enqueue(sourceId, requestKey, { processor: 'catalog', stage: 'fetch', payload })
      if (job.status === 'pending') {
        this.store.database.prepare("UPDATE source_catalog SET state = 'refresh_pending', updated_at = ? WHERE id = ?").run(this.now(), sourceId)
        this.event(sourceId, job, 'fetch', 'queued')
        this.refreshDependencies()
      }
      return job
    }).immediate()
  }

  scheduleDue(): KnowledgeIntakeJob[] {
    const due = this.listSources().filter((source) => (source.policy === 'tracked_content' || source.policy === 'metadata_only') && source.nextRefreshAt && source.nextRefreshAt <= this.now())
    return due.map((source) => {
      this.invalidate(source.id, 'The source freshness check is due.')
      return this.queueImport(source.id, `source-refresh:${source.id}:${source.nextRefreshAt}`)
    })
  }

  async processNext(acquire: SourceAcquirer): Promise<KnowledgeIntakeJob | undefined> {
    const claimed = this.jobs.claimNext('catalog')
    if (!claimed) return undefined
    const { job, owner } = claimed
    const controller = new AbortController()
    let leaseError: unknown
    const heartbeat = setInterval(() => { try { this.jobs.heartbeat(job.id, owner) } catch (error) { leaseError = error; controller.abort() } }, 30_000)
    try {
      const source = this.getSource(job.sourceId)
      if (source.policy === 'paused') { this.cancelJob(job.id); return this.listJobs().find((candidate) => candidate.id === job.id) }
      this.store.database.prepare('UPDATE source_catalog SET last_attempt_at = ?, updated_at = ? WHERE id = ?').run(this.now(), this.now(), source.id)
      this.event(source.id, job, 'fetch', 'running')
      const result = await acquire(source, { metadataOnly: source.policy === 'metadata_only', payload: job.payload, signal: controller.signal })
      if (leaseError) throw leaseError
      this.store.database.transaction(() => {
        this.jobs.assertOwner(job.id, owner)
        if ('unavailable' in result) {
          this.recordFreshness(source.id, result)
          this.jobs.fail(job.id, owner, new Error(result.reason), { retryable: result.retryable ?? !result.deleted })
          this.event(source.id, job, 'fetch', 'failed', result.reason)
          return
        }
        if ('metadataOnly' in result) {
          this.recordFreshness(source.id, result)
        } else {
          this.jobs.advance(job.id, owner, 'normalize')
          this.event(source.id, job, 'normalize', 'running')
          this.jobs.advance(job.id, owner, 'index')
          this.publishRevision({ ...result, sourceId: source.id })
        }
        this.jobs.complete(job.id, owner)
        this.event(source.id, job, 'complete', 'metadataOnly' in result ? 'metadata_checked' : result.outcome ?? 'complete')
      }).immediate()
    } catch (error) {
      try {
        this.store.database.transaction(() => {
          this.jobs.assertOwner(job.id, owner)
          this.recordFreshness(job.sourceId, { unavailable: true, reason: error instanceof Error ? error.message : String(error) })
          this.jobs.fail(job.id, owner, error, { retryable: !(error instanceof WorkstackError && error.code === 'VALIDATION_ERROR') })
          this.event(job.sourceId, job, 'intake', 'failed', error instanceof Error ? error.message : String(error))
        }).immediate()
      } catch { /* Cancelled or replaced owners cannot overwrite the winning outcome. */ }
    } finally { clearInterval(heartbeat) }
    return this.listJobs().find((candidate) => candidate.id === job.id)
  }

  listJobs(): KnowledgeIntakeJob[] { return this.jobs.list('catalog') }
  cancelJob(jobId: string): void {
    const job = this.listJobs().find((candidate) => candidate.id === jobId)
    if (!job) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The source intake job does not exist.')
    this.store.database.transaction(() => {
      this.jobs.cancel(jobId)
      this.recordFreshness(job.sourceId, { unavailable: true, reason: 'Source intake was cancelled. Previously committed revisions remain available for inspection.' })
      this.event(job.sourceId, job, 'cancelled', 'cancelled')
    }).immediate()
  }
  retryJob(jobId: string): KnowledgeIntakeJob {
    const job = this.listJobs().find((candidate) => candidate.id === jobId)
    if (!job) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The source intake job does not exist.')
    if (this.getSource(job.sourceId).policy === 'paused') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Resume this source before retrying intake.')
    const retried = this.jobs.retry(jobId)
    this.store.database.prepare("UPDATE source_catalog SET state = 'refresh_pending', updated_at = ? WHERE id = ?").run(this.now(), job.sourceId)
    this.event(job.sourceId, retried, 'fetch', 'retried')
    return retried
  }

  search(query: string, options: { limit?: number; maxChars?: number; workItemId?: string } = {}): SourcePassage[] {
    this.refreshDependencies()
    const expression = sourceSearchExpression(query)
    if (!expression) return []
    const limit = z.number().int().min(1).max(SOURCE_PASSAGE_LIMITS.maxResults).parse(options.limit ?? 10)
    const budget = z.number().int().min(1).max(SOURCE_PASSAGE_LIMITS.maxResponseCharacters).parse(options.maxChars ?? 16_000)
    const rows = this.store.database.prepare(`SELECT p.*, bm25(source_passage_search, 0, 5, 3, 1) AS rank
      FROM source_passage_search JOIN source_passages p ON p.id = source_passage_search.passage_id
      JOIN source_catalog s ON s.id = p.source_id WHERE source_passage_search MATCH ? AND p.revision_id = s.current_revision_id
      AND s.state = 'ready' AND s.deleted_at IS NULL AND s.policy != 'paused'
      AND (s.policy = 'import_once' OR s.next_refresh_at IS NULL OR s.next_refresh_at > ?)
      ORDER BY CASE WHEN s.work_item_id = ? THEN 0 ELSE 1 END, rank, s.id, p.ordinal LIMIT ?`).all(expression, this.now(), options.workItemId ?? null, limit * 8) as PassageRow[]
    const result: SourcePassage[] = []
    const hashes = new Set<string>()
    const perSource = new Map<string, number>()
    let remaining = budget
    for (const row of rows) {
      if (result.length >= limit) break
      if (hashes.has(row.passage_hash) || (perSource.get(row.source_id) ?? 0) >= 3 || row.text.length > remaining) continue
      const passage = this.decodePassage(row)
      if (passage.readiness !== 'ready') continue
      result.push(passage)
      hashes.add(row.passage_hash)
      perSource.set(row.source_id, (perSource.get(row.source_id) ?? 0) + 1)
      remaining -= row.text.length
    }
    return result
  }

  readCitation(citation: SourceCitation, options: { neighbors?: number; maxChars?: number } = {}): SourceCitationRead {
    const neighbors = z.number().int().min(0).max(3).parse(options.neighbors ?? 1)
    const maxCharacters = z.number().int().min(SOURCE_PASSAGE_LIMITS.maxCharacters).max(SOURCE_PASSAGE_LIMITS.maxResponseCharacters).parse(options.maxChars ?? 16_000)
    const row = this.store.database.prepare('SELECT * FROM source_passages WHERE id = ? AND source_id = ? AND revision_id = ?').get(citation.passageId, citation.sourceId, citation.revisionId) as PassageRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The cited source passage does not exist.')
    const passage = this.decodePassage(row)
    if (!Object.entries(passage.citation).every(([key, value]) => JSON.stringify(value) === JSON.stringify(citation[key as keyof SourceCitation]))) throw new WorkstackError('VALIDATION_ERROR', 'The citation hash or evidence span does not match its immutable revision.')
    const adjacent = (this.store.database.prepare('SELECT * FROM source_passages WHERE revision_id = ? AND ordinal BETWEEN ? AND ? AND id != ? ORDER BY ordinal').all(row.revision_id, row.ordinal - neighbors, row.ordinal + neighbors, row.id) as PassageRow[]).map((candidate) => this.decodePassage(candidate))
    let remaining = maxCharacters - passage.text.length
    const selected = adjacent.filter((candidate) => { if (candidate.text.length > remaining) return false; remaining -= candidate.text.length; return true })
    return { passage, neighbors: selected, truncated: selected.length !== adjacent.length, maxCharacters }
  }

  /** Original representation is for explicit local inspection; retrieval always uses normalized, redacted passages. */
  readRevision(sourceId: string, revisionId: string, options: { representation?: 'original' | 'normalized'; offset?: number; limit?: number } = {}): SourceRevisionRead {
    const representation = z.enum(['original', 'normalized']).parse(options.representation ?? 'normalized')
    const offset = z.number().int().min(0).parse(options.offset ?? 0)
    const limit = z.number().int().min(1).max(24_000).parse(options.limit ?? 12_000)
    const row = this.revisionRow(sourceId, revisionId)
    const content = representation === 'original' ? row.original_text : row.normalized_text
    if (offset > content.length) throw new WorkstackError('VALIDATION_ERROR', 'The requested offset is beyond this source revision.')
    return { revision: decodeRevision(row), representation, text: content.slice(offset, offset + limit), offset, totalCharacters: content.length, truncated: offset + limit < content.length, trust: 'untrusted_reference' }
  }

  linkDependent(sourceId: string, revisionId: string, artifactKind: string, artifactId: string): void {
    this.getRevision(sourceId, revisionId)
    const source = this.getSource(sourceId)
    const stale = source.currentRevisionId !== revisionId || source.state !== 'ready'
    this.store.database.prepare(`INSERT INTO source_dependents (source_id,revision_id,artifact_kind,artifact_id,stale,reason,queued_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,revision_id,artifact_kind,artifact_id) DO UPDATE SET stale = excluded.stale, reason = excluded.reason, queued_at = excluded.queued_at`)
      .run(sourceId, revisionId, artifactKind, artifactId, stale ? 1 : 0, stale ? 'Referenced source revision is not current and ready.' : null, stale ? this.now() : null)
  }
  listInvalidations(): SourceInvalidation[] {
    this.refreshDependencies(true)
    return (this.store.database.prepare('SELECT * FROM source_dependents WHERE stale = 1 ORDER BY queued_at, artifact_kind, artifact_id').all() as Array<{ source_id: string; revision_id: string; artifact_kind: string; artifact_id: string; reason: string; queued_at: string }>).map((row) => ({ sourceId: row.source_id, revisionId: row.revision_id, artifactKind: row.artifact_kind, artifactId: row.artifact_id, reason: row.reason, queuedAt: row.queued_at }))
  }

  /** Reconcile the durable queue with exact evidence, including time-only expiry and transitive wiki dependencies. */
  refreshDependencies(force = false): void {
    this.store.database.transaction(() => {
      const database = this.store.database
      const now = this.now()
      // The transactional version detects rollbacks; total_changes distinguishes later writes
      // that reuse a rolled-back version, and data_version observes other connections.
      const stamp = (): string => JSON.stringify([database.prepare('SELECT version,total_changes() AS changes FROM retrieval_corpus_state WHERE id = 1').get(), database.pragma('data_version', { simple: true })])
      const cached = freshnessCaches.get(database)
      if (!force && cached && cached.stamp === stamp() && now >= cached.checkedAt && (!cached.nextExpiry || now < cached.nextExpiry)) {
        this.effectiveSources = cached.sources
        return
      }
      const publication = database.prepare('SELECT revision_id FROM wiki_publication WHERE id = 1').get() as { revision_id: string } | undefined
      if (!force && !publication) {
        this.effectiveSources = undefined
        freshnessCaches.set(database, { stamp: stamp(), checkedAt: now })
        return
      }
      const rows = database.prepare('SELECT * FROM source_catalog ORDER BY title COLLATE NOCASE,id').all() as SourceRow[]
      const sources = new Map(rows.map((row) => [row.id, this.decodeSource(row.state === 'stale' && row.stale_reason?.startsWith(DERIVED_STALE_REASON) ? { ...row, state: 'ready', stale_reason: null } : row)]))
      const existing = database.prepare('SELECT * FROM source_dependents ORDER BY source_id,revision_id,artifact_kind,artifact_id').all() as DependentRow[]
      const wanted = new Map<string, DependentRow>()
      const key = (row: DependentRow): string => JSON.stringify([row.source_id, row.revision_id, row.artifact_kind, row.artifact_id])
      if (publication) for (const [slug, citations] of Object.entries(readWikiPageCitations(database, publication.revision_id))) {
        for (const citation of citations) if (sources.has(`wiki:${slug}`) && sources.has(citation.sourceId)) {
          const row: DependentRow = { source_id: citation.sourceId, revision_id: citation.revisionId, artifact_kind: 'wiki_source', artifact_id: `wiki:${slug}`, stale: 0, reason: null, queued_at: null }
          wanted.set(key(row), row)
        }
      }
      const dependents = existing.filter((row) => row.artifact_kind !== 'wiki_source' || wanted.has(key(row)))
      const known = new Set(dependents.map(key))
      for (const [identity, row] of wanted) if (!known.has(identity)) {
        dependents.push(row)
        if (!database.readonly) database.prepare('INSERT INTO source_dependents(source_id,revision_id,artifact_kind,artifact_id) VALUES (?,?,?,?)').run(row.source_id, row.revision_id, row.artifact_kind, row.artifact_id)
      }
      if (!database.readonly) for (const row of existing) if (row.artifact_kind === 'wiki_source' && !wanted.has(key(row))) database.prepare('DELETE FROM source_dependents WHERE source_id = ? AND revision_id = ? AND artifact_kind = ? AND artifact_id = ?').run(row.source_id, row.revision_id, row.artifact_kind, row.artifact_id)
      // Start from direct readiness, then spread only failures. This also lets an unchanged refresh recover a chain.
      let changed: boolean
      do {
        changed = false
        for (const row of dependents) {
          if (row.artifact_kind !== 'wiki_source') continue
          const source = sources.get(row.source_id)!
          const target = sources.get(row.artifact_id)!
          if (target.state === 'ready' && (source.state !== 'ready' || source.currentRevisionId !== row.revision_id)) {
            target.state = 'stale'
            target.staleReason = `${DERIVED_STALE_REASON}${source.title} (${source.id}).`
            changed = true
          }
        }
      } while (changed)
      if (!database.readonly) {
        for (const row of rows) {
          const source = sources.get(row.id)!
          if ((row.state === 'ready' || row.stale_reason?.startsWith(DERIVED_STALE_REASON)) && (source.staleReason?.startsWith(DERIVED_STALE_REASON) || row.stale_reason?.startsWith(DERIVED_STALE_REASON) && source.state === 'ready')) {
            const reason = source.staleReason ?? null
            if (row.state !== source.state || row.stale_reason !== reason) database.prepare('UPDATE source_catalog SET state = ?, stale_reason = ?, updated_at = ? WHERE id = ?').run(source.state, reason, now, source.id)
          }
        }
        for (const row of dependents) {
          const source = sources.get(row.source_id)!
          const stale = source.state !== 'ready' || source.currentRevisionId !== row.revision_id
          const reason = stale ? source.state !== 'ready' ? source.staleReason ?? 'Source is not current and ready.' : 'Source content changed.' : null
          if (row.stale !== Number(stale) || row.reason !== reason) database.prepare('UPDATE source_dependents SET stale = ?, reason = ?, queued_at = ? WHERE source_id = ? AND revision_id = ? AND artifact_kind = ? AND artifact_id = ?')
            .run(Number(stale), reason, stale ? row.queued_at ?? this.now() : null, row.source_id, row.revision_id, row.artifact_kind, row.artifact_id)
        }
      }
      this.effectiveSources = sources
      const nextExpiry = rows.map((row) => row.policy !== 'import_once' && row.policy !== 'paused' && row.next_refresh_at && row.next_refresh_at > now ? row.next_refresh_at : undefined).filter((expiry): expiry is string => expiry !== undefined).sort()[0]
      freshnessCaches.set(database, { stamp: stamp(), checkedAt: now, nextExpiry, sources })
    })()
  }

  migrateLegacySources(): number {
    const rows = this.store.database.prepare(`SELECT k.* FROM knowledge_sources k LEFT JOIN source_catalog s ON s.id = k.id WHERE s.id IS NULL`).all() as Array<{ id: string; kind: string; display_name: string; relative_or_external_location: string; source_work_item_id: string | null }>
    let migrated = 0
    for (const row of rows) {
      const source = this.registerSource({ id: row.id, kind: row.kind === 'work_completion' ? 'work_completion' : row.kind === 'manual' ? 'manual' : 'file', title: row.display_name, canonicalUri: `legacy://${this.store.project.id}/${row.id}`, workItemId: row.source_work_item_id ?? undefined })
      try {
        const filename = realpathSync(path.resolve(this.store.paths.workstackPath, row.relative_or_external_location))
        const relative = path.relative(realpathSync(this.store.paths.workstackPath), filename)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Legacy source location leaves project data.')
        if (statSync(filename).size > MAX_SOURCE_CHARACTERS) throw new Error('Legacy source exceeds the intake byte limit.')
        this.publishRevision({ sourceId: source.id, original: readFileSync(filename, 'utf8'), acquiredBy: 'legacy-migration', metadata: { legacyLocation: row.relative_or_external_location } })
        migrated += 1
      } catch (error) { this.recordFreshness(source.id, { unavailable: true, reason: error instanceof Error ? error.message : String(error) }) }
    }
    return migrated
  }

  private revisionRow(sourceId: string, revisionId: string): RevisionRow {
    const row = this.store.database.prepare('SELECT * FROM source_revisions WHERE id = ? AND source_id = ?').get(revisionId, sourceId) as RevisionRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The source revision does not exist.')
    return row
  }
  private decodeSource(row: SourceRow): ProjectSource {
    const expired = row.current_revision_id && row.policy !== 'import_once' && (row.policy === 'paused' || row.next_refresh_at && row.next_refresh_at <= this.now())
    return { id: row.id, kind: row.kind, title: row.title, canonicalUri: row.canonical_uri, repositoryPath: row.repository_path ?? undefined, workItemId: row.work_item_id ?? undefined, policy: row.policy, state: row.state === 'ready' && expired ? 'stale' : row.state, currentRevisionId: row.current_revision_id ?? undefined, observedUpstreamRevision: row.observed_upstream_revision ?? undefined, verifiedUpstreamRevision: row.verified_upstream_revision ?? undefined, refreshSeconds: row.refresh_seconds, lastAttemptAt: row.last_attempt_at ?? undefined, lastSuccessfulCheckAt: row.last_successful_check_at ?? undefined, lastContentChangeAt: row.last_content_change_at ?? undefined, nextRefreshAt: row.next_refresh_at ?? undefined, staleReason: row.stale_reason ?? (expired ? row.policy === 'paused' ? 'Source refresh is paused.' : 'The source freshness check is overdue.' : undefined), deletedAt: row.deleted_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }
  }
  private decodePassage(row: PassageRow): SourcePassage {
    const source = this.getSource(row.source_id)
    const revision = this.revisionRow(row.source_id, row.revision_id)
    return {
      citation: { sourceId: row.source_id, revisionId: row.revision_id, passageId: row.id, contentHash: revision.content_hash, normalizedHash: revision.normalized_hash, passageHash: row.passage_hash, headingTrail: JSON.parse(row.heading_json) as string[], startLine: row.start_line, endLine: row.end_line, startOffset: row.start_offset, endOffset: row.end_offset, locator: `source://${row.source_id}/revisions/${row.revision_id}/passages/${row.ordinal}#L${row.start_line}-L${row.end_line}` },
      title: source.title, text: row.text, sourceKind: source.kind, canonicalUri: source.canonicalUri,
      historical: Boolean(source.deletedAt) || source.currentRevisionId !== row.revision_id, readiness: source.state, structure: JSON.parse(row.structure_json) as SourcePassage['structure'], relevance: -(row.rank ?? 0), workItemId: source.workItemId, trust: 'untrusted_reference'
    }
  }
  private invalidate(sourceId: string, reason: string, currentRevisionId?: string): void {
    this.store.database.prepare('UPDATE source_dependents SET stale = 1, reason = ?, queued_at = COALESCE(queued_at, ?) WHERE source_id = ? AND (? IS NULL OR revision_id != ?)')
      .run(reason, this.now(), sourceId, currentRevisionId ?? null, currentRevisionId ?? null)
  }
  private event(sourceId: string, job: KnowledgeIntakeJob | undefined, stage: string, outcome: string, message?: string): void {
    this.store.database.prepare('INSERT INTO source_intake_events (source_id,job_id,attempt,stage,outcome,message,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(sourceId, job?.id ?? null, job?.attempts ?? 0, stage, outcome, message ? redactEvidence(message).slice(0, 2000) : null, this.now())
  }
  private nextRefresh(source: ProjectSource): string | null { return source.policy === 'paused' || source.policy === 'import_once' ? null : new Date(this.clock().now().getTime() + source.refreshSeconds * 1000).toISOString() }
  private clock(): Clock { return this.dependencies.clock ?? systemClock }
  private now(): string { return this.clock().now().toISOString() }
}

function decodeRevision(row: RevisionRow): SourceRevision {
  return { id: row.id, sourceId: row.source_id, contentHash: row.content_hash, normalizedHash: row.normalized_hash, upstreamRevision: row.upstream_revision ?? undefined, acquiredBy: row.acquired_by, acquiredAt: row.acquired_at, converter: row.converter, converterVersion: row.converter_version, outcome: row.outcome, manifest: JSON.parse(row.manifest_json) as SourceRevisionManifest }
}

function redactMetadata(value: unknown): unknown {
  if (typeof value === 'string') return redactEvidence(value)
  if (Array.isArray(value)) return value.map(redactMetadata)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /password|secret|token|api[_-]?key/i.test(key) ? '[REDACTED]' : redactMetadata(entry)]))
  return value
}

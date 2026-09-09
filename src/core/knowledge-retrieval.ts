import { createHash } from 'node:crypto'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { redactEvidence } from './evidence-policy'
import { KnowledgeRecordsRepository } from './knowledge-records'
import { ProjectDirectoryRepository } from './project-directory'
import type { ProjectStore } from './project-store'
import { SourceCatalogRepository, type SourcePassage } from './source-catalog'
import { SemanticIndexRepository } from './semantic-index'
import { sourceSearchExpression } from './source-passages'
import {
  KNOWLEDGE_RETRIEVAL_SOURCE_TYPES, RETRIEVAL_POLICY, retrievalGroups,
  type KnowledgeRetrievalOptions, type KnowledgeRetrievalResponse, type KnowledgeRetrievalResult
} from './knowledge-retrieval-contracts'

interface Candidate extends KnowledgeRetrievalResult { key: string; text: string; lexicalScore: number; semanticSimilarity?: number }
const optionsSchema = z.object({ limit: z.number().int().min(1).max(100).default(40), sourceTypes: z.array(z.enum(KNOWLEDGE_RETRIEVAL_SOURCE_TYPES)).max(6).optional(), workItemId: z.string().optional(), maxCharacters: z.number().int().min(1).max(100_000).default(24_000) })
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Shared evidence selection for MCP, chat, planning and task packets. No provider or network calls. */
export class KnowledgeRetrievalService {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  async retrieve(query: string, options: KnowledgeRetrievalOptions = {}): Promise<KnowledgeRetrievalResponse> {
    const normalized = z.string().max(2000).parse(query).trim()
    const parsed = optionsSchema.parse(options)
    const capturedAt = this.clock.now().toISOString()
    const snapshot = this.store.database.transaction(() => ({ candidates: this.lexicalCandidates(normalized, capturedAt), corpusRevision: this.corpusRevision(capturedAt), configFingerprint: this.configFingerprint() }))()
    const fallback = (reason: string): KnowledgeRetrievalResponse => ({ ...this.retrieveLexical(normalized, options), fallbackReason: reason })
    try {
      const semantic = await new SemanticIndexRepository(this.store, this.clock).search(normalized, options.signal)
      if (semantic.fallbackReason) return fallback(semantic.fallbackReason)
      return this.store.database.transaction(() => {
        if (snapshot.corpusRevision !== this.corpusRevision() || snapshot.configFingerprint !== this.configFingerprint()) return fallback('The corpus or local index changed during retrieval; evidence was selected again lexically.')
        const candidates = new Map(snapshot.candidates.map((candidate) => [candidate.key, candidate]))
        const catalog = new SourceCatalogRepository(this.store, { clock: this.clock })
        for (const hit of semantic.hits) {
          const candidate = candidates.get(hit.passageId) ?? this.passageCandidate(catalog.getPassage(hit.passageId), normalized)
          candidate.semanticSimilarity = hit.similarity
          candidates.set(candidate.key, candidate)
        }
        const response = this.select(normalized, [...candidates.values()], parsed, { corpusRevision: snapshot.corpusRevision, configFingerprint: snapshot.configFingerprint, mode: 'hybrid' })
        response.truncated ||= semantic.truncated
        return response
      })()
    } catch (error) { return fallback(error instanceof Error ? error.message : 'Local semantic retrieval is unavailable.') }
  }

  retrieveLexical(query: string, options: KnowledgeRetrievalOptions = {}): KnowledgeRetrievalResponse {
    const normalized = z.string().max(2000).parse(query).trim()
    const parsed = optionsSchema.parse(options)
    const capturedAt = this.clock.now().toISOString()
    return this.store.database.transaction(() => this.select(normalized, this.lexicalCandidates(normalized, capturedAt), parsed, {
      mode: 'lexical', fallbackReason: new SemanticIndexRepository(this.store, this.clock).model() ? 'Synchronous evidence selection uses lexical retrieval.' : 'No local semantic model is enabled.', corpusRevision: this.corpusRevision(capturedAt), configFingerprint: this.configFingerprint()
    }))()
  }

  corpusRevision(capturedAt = this.clock.now().toISOString()): string {
    const state = this.store.database.prepare('SELECT version FROM retrieval_corpus_state WHERE id = 1').get() as { version: number }
    const due = this.store.database.prepare("SELECT count(*) AS count FROM source_catalog WHERE policy NOT IN ('import_once','paused') AND next_refresh_at <= ?").get(capturedAt) as { count: number }
    return hash(JSON.stringify([this.store.project.id, state.version, due.count]))
  }

  configFingerprint(): string {
    const model = this.store.database.prepare('SELECT enabled,model_id,model_version,model_hash,dimensions FROM semantic_model_settings WHERE id = 1').get()
    const vectors = this.store.database.prepare('SELECT version FROM retrieval_index_state WHERE id = 1').get()
    return hash(JSON.stringify([RETRIEVAL_POLICY, model, vectors]))
  }

  private lexicalCandidates(query: string, capturedAt: string): Candidate[] {
    const expression = sourceSearchExpression(query)
    if (!expression) return []
    const candidates: Candidate[] = []
    const catalog = new SourceCatalogRepository(this.store, { clock: this.clock })
    const eligible = "s.state = 'ready' AND s.deleted_at IS NULL AND s.policy NOT IN ('paused','metadata_only') AND p.revision_id = s.current_revision_id AND (s.policy = 'import_once' OR s.next_refresh_at IS NULL OR s.next_refresh_at > ?)"
    const passageIds = this.store.database.prepare(`SELECT p.id FROM source_passage_search f JOIN source_passages p ON p.id = f.passage_id JOIN source_catalog s ON s.id = p.source_id
      WHERE source_passage_search MATCH ? AND ${eligible} ORDER BY bm25(source_passage_search,0,5,3,1),p.source_id,p.ordinal LIMIT 100`).all(expression, capturedAt) as Array<{ id: string }>
    const metadataIds = this.store.database.prepare(`SELECT p.id FROM source_catalog s JOIN source_passages p ON p.source_id = s.id WHERE (s.repository_path = ? OR s.id = ? OR s.canonical_uri = ?) AND ${eligible} ORDER BY p.ordinal LIMIT 30`).all(query, query, query, capturedAt) as Array<{ id: string }>
    for (const id of new Set([...passageIds, ...metadataIds].map((row) => row.id))) candidates.push(this.passageCandidate(catalog.getPassage(id), query))
    // Catalog identity is authoritative even when paused, unavailable, or superseded.
    // Never use an old FTS projection as a fallback around that policy.
    const legacy = this.store.database.prepare(`SELECT k.source_id,CASE WHEN w.id IS NOT NULL THEN w.display_id || ' · ' || w.title ELSE k.title END AS title,substr(k.content,1,16000) AS content,s.kind,s.source_work_item_id,s.relative_or_external_location
      FROM knowledge_search k LEFT JOIN knowledge_sources s ON s.id = k.source_id LEFT JOIN work_items w ON w.id = s.source_work_item_id
      WHERE knowledge_search MATCH ? AND NOT EXISTS(SELECT 1 FROM source_catalog c WHERE c.id = k.source_id)
      AND (s.status = 'indexed' OR k.source_id LIKE 'wiki:%') ORDER BY rank,k.source_id LIMIT 100`).all(expression) as Array<{
      source_id: string; title: string; content: string; kind: string | null; source_work_item_id: string | null; relative_or_external_location: string | null
    }>
    for (const row of legacy) {
      const wiki = row.source_id.startsWith('wiki:')
      const completed = row.kind === 'work_completion' && row.source_work_item_id
      const sourceId = wiki ? row.source_id : completed ? `completed:${completed}` : `raw:${row.source_id}`
      const text = redactEvidence(row.content)
      candidates.push(this.candidate(query, { key: sourceId, sourceId, canonicalSourceId: row.source_id,
        sourceType: wiki ? 'wiki_article' : completed ? 'completed_work' : 'raw_source', title: redactEvidence(row.title), text,
        location: row.relative_or_external_location ?? `knowledge/wiki/${row.source_id.slice(5)}.md`,
        workItemId: completed || undefined, provenance: { kind: 'legacy', revisionId: `legacy:${hash(text)}`, contentHash: hash(text), locator: `workstack://legacy/${row.source_id}` } }))
    }
    const tasks = this.store.database.prepare(`SELECT w.id,w.display_id,w.title,w.status,w.updated_at,
      substr(w.description_markdown,1,8000) AS description,substr(w.acceptance_criteria_markdown,1,8000) AS criteria,
      substr(c.summary_markdown,1,8000) AS summary,substr(c.validation_markdown,1,8000) AS validation,
      substr(c.implementation_notes_markdown,1,8000) AS notes,substr(c.session_summary_markdown,1,4000) AS handoff,substr(c.known_limitations_markdown,1,4000) AS limitations,substr(c.files_changed_json,1,4000) AS files,substr(c.components_changed_json,1,4000) AS components
      FROM work_items w LEFT JOIN completion_records c ON c.work_item_id = w.id
      WHERE w.id IN (SELECT work_item_id FROM work_item_search WHERE work_item_search MATCH ? UNION SELECT id FROM work_items WHERE lower(display_id) = lower(?) OR id = ?) AND w.status IN ('backlog','completed')
      AND (w.status = 'backlog' OR NOT EXISTS(SELECT 1 FROM source_catalog s WHERE s.work_item_id = w.id AND s.kind = 'work_completion') AND NOT EXISTS(SELECT 1 FROM knowledge_sources legacy WHERE legacy.source_work_item_id = w.id AND legacy.kind = 'work_completion' AND legacy.status = 'indexed'))
      ORDER BY w.updated_at DESC,w.id LIMIT 100`).all(expression, query, query) as Array<{ id: string; display_id: string; title: string; status: string; updated_at: string; description: string; criteria: string; summary: string | null; validation: string | null; notes: string | null; handoff: string | null; limitations: string | null; files: string | null; components: string | null }>
    for (const row of tasks) {
      const completed = row.status === 'completed'
      const text = redactEvidence([row.title, row.description, row.criteria, row.summary, row.validation, row.notes, row.handoff, row.limitations, row.files, row.components].filter(Boolean).join('\n')).slice(0, 16_000)
      const contentHash = hash(JSON.stringify(row))
      candidates.push(this.candidate(query, { key: `task:${row.id}`, sourceId: `${completed ? 'completed' : 'backlog'}:${row.id}`, sourceType: completed ? 'completed_work' : 'backlog', title: `${row.display_id} · ${redactEvidence(row.title)}`,
        text, workItemId: row.id, location: `work-items/${row.id}/${completed ? 'completion' : 'work-item'}.md`,
        provenance: { kind: 'task', revisionId: `${row.id}@${contentHash}`, contentHash, locator: `workstack://task/${row.id}` } }))
    }
    for (const record of new KnowledgeRecordsRepository(this.store, { clock: this.clock }).search(query, { limit: 30 })) {
      const row = this.store.database.prepare('SELECT snapshot_json FROM knowledge_record_history WHERE record_id = ? AND version = ?').get(record.id, record.version) as { snapshot_json: string }
      candidates.push(this.candidate(query, { key: record.id, sourceId: record.id, canonicalSourceId: record.id, sourceType: 'knowledge_record', recordId: record.id,
        title: `${record.title} (${record.status})`, text: redactEvidence(`${record.markdown}\n${record.rationale}`).slice(0, 16_000), location: record.locator,
        provenance: { kind: 'record', revisionId: `${record.id}@${record.version}`, contentHash: hash(row.snapshot_json), locator: record.locator } }))
    }
    const directory = new ProjectDirectoryRepository(this.store)
    const entityIds = this.store.database.prepare(`SELECT e.id FROM project_entity_search f JOIN project_entities e ON e.id = f.entity_id WHERE project_entity_search MATCH ? AND e.status = 'active' ORDER BY bm25(project_entity_search,0,5,3,1),e.id LIMIT 100`).all(expression) as Array<{ id: string }>
    for (const { id } of entityIds) {
      const entity = directory.get(id)
      const text = redactEvidence(`${entity.displayName}\n${entity.aliases.join(', ')}\n${entity.definition}`)
      const row = this.store.database.prepare('SELECT snapshot_json FROM project_entity_history WHERE entity_id = ? ORDER BY id DESC LIMIT 1').get(entity.id) as { snapshot_json: string }
      candidates.push(this.candidate(query, { key: entity.id, sourceId: entity.id, canonicalSourceId: entity.id, sourceType: 'project_entity', entityId: entity.id,
        title: entity.displayName, text, location: entity.locator, provenance: { kind: 'entity', revisionId: `${entity.id}@${entity.version}`, contentHash: hash(row.snapshot_json), locator: entity.locator } }))
    }
    return candidates.filter((candidate) => candidate.lexicalScore > 0).sort((left, right) => right.lexicalScore - left.lexicalScore || compareCandidates(left, right)).slice(0, RETRIEVAL_POLICY.maxCandidates)
  }

  private passageCandidate(passage: SourcePassage, query: string): Candidate {
    const id = passage.citation.sourceId
    const sourceType = passage.sourceKind === 'wiki' ? 'wiki_article' : passage.sourceKind === 'work_completion' && passage.workItemId ? 'completed_work' : 'raw_source'
    const sourceId = sourceType === 'wiki_article' ? id : sourceType === 'completed_work' ? `completed:${passage.workItemId}` : `raw:${id}`
    const location = this.store.database.prepare("SELECT k.relative_or_external_location AS location,CASE WHEN s.kind = 'work_completion' AND w.id IS NOT NULL THEN w.display_id || ' · ' || w.title ELSE ? END AS title FROM knowledge_sources k JOIN source_catalog s ON s.id = k.id LEFT JOIN work_items w ON w.id = s.work_item_id WHERE k.id = ?").get(passage.title, id) as { location: string; title: string }
    return this.candidate(query, { key: passage.citation.passageId, sourceId, canonicalSourceId: id, sourceType, title: location.title,
      text: passage.text, location: location.location, workItemId: passage.workItemId, citation: passage.citation,
      provenance: { kind: 'passage', revisionId: passage.citation.revisionId, contentHash: passage.citation.contentHash, locator: passage.citation.locator } })
  }

  private candidate(query: string, input: Omit<Candidate, 'lexicalScore' | 'excerpt' | 'relevance'>): Candidate {
    const index = input.text.toLocaleLowerCase('en-US').indexOf(query.toLocaleLowerCase('en-US').split(/\s+/)[0])
    return { ...input, excerpt: input.text.slice(Math.max(0, index - 40), Math.max(0, index - 40) + 220).trim(), relevance: 0,
      lexicalScore: lexicalScore(input.title, `${input.location}\n${input.text}`, query) + (exactIdentifier(`${input.title}\n${input.location}\n${input.text}`, query) ? 100 : 0), trust: 'untrusted_reference' }
  }

  private select(query: string, candidates: Candidate[], options: z.infer<typeof optionsSchema>, metadata: Pick<KnowledgeRetrievalResponse, 'mode' | 'fallbackReason' | 'corpusRevision' | 'configFingerprint'>): KnowledgeRetrievalResponse {
    const filtered = candidates.filter((candidate) => (!options.sourceTypes || options.sourceTypes.includes(candidate.sourceType)))
    const lexical = filtered.filter((candidate) => candidate.lexicalScore > 0).sort((left, right) => right.lexicalScore - left.lexicalScore || compareCandidates(left, right))
    const ranks = new Map(lexical.map((candidate, index) => [candidate.key, index + 1]))
    const semantic = filtered.filter((candidate) => candidate.semanticSimilarity !== undefined).sort((left, right) => right.semanticSimilarity! - left.semanticSimilarity! || compareCandidates(left, right))
    const semanticRanks = new Map(semantic.map((candidate, index) => [candidate.key, index + 1]))
    const ranked = filtered.map((candidate) => {
      const lexicalRank = ranks.get(candidate.key)
      const semanticRank = semanticRanks.get(candidate.key)
      const identifier = exactIdentifier(`${candidate.title}\n${candidate.location}\n${candidate.text}`, query)
      const relevance = (options.workItemId && candidate.workItemId === options.workItemId ? RETRIEVAL_POLICY.taskMatchBoost : 0) + (identifier ? RETRIEVAL_POLICY.exactIdentifierBoost : 0) + (lexicalRank ? RETRIEVAL_POLICY.lexicalWeight / (RETRIEVAL_POLICY.rankOffset + lexicalRank) : 0) + (semanticRank ? RETRIEVAL_POLICY.semanticWeight / (RETRIEVAL_POLICY.rankOffset + semanticRank) : 0)
      const { key: _key, lexicalScore: _score, semanticSimilarity, ...result } = candidate
      void _key; void _score
      return { ...result, relevance, diagnostics: { lexicalRank, semanticRank, semanticSimilarity, exactIdentifier: identifier, rankingPolicy: RETRIEVAL_POLICY.version } }
    }).sort((left, right) => right.relevance - left.relevance)
    let remaining = options.maxCharacters
    let truncated = candidates.length >= RETRIEVAL_POLICY.maxCandidates
    const seen = new Set<string>()
    const results: KnowledgeRetrievalResult[] = []
    for (const result of ranked) {
      if (seen.has(result.sourceId)) continue
      if (results.length >= options.limit) { truncated = true; break }
      const text = result.text!
      if (text.length > remaining) { truncated = true; continue }
      results.push(result)
      seen.add(result.sourceId)
      remaining -= text.length
    }
    return { query, ...metadata, results, groups: retrievalGroups(results), truncated }
  }
}

function terms(query: string): string[] { return [...new Set(Array.from(query.toLocaleLowerCase('en-US').matchAll(/[\p{L}\p{N}_./:#-]+/gu), (match) => match[0]))].slice(0, 24) }
function lexicalScore(title: string, content: string, query: string): number {
  const tokens = terms(query)
  const name = title.toLocaleLowerCase('en-US')
  const text = content.toLocaleLowerCase('en-US')
  return tokens.reduce((sum, token) => sum + (name.includes(token) ? 20 : 0) + (text.includes(token) ? 5 : 0), 0) + (query && name.includes(query.toLocaleLowerCase('en-US')) ? 30 : 0)
}
function exactIdentifier(content: string, query: string): boolean { return terms(query).some((term) => /[_.:/#-]/.test(term) && content.toLocaleLowerCase('en-US').includes(term)) }
function compareCandidates(left: KnowledgeRetrievalResult, right: KnowledgeRetrievalResult): number { return KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.indexOf(left.sourceType) - KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.indexOf(right.sourceType) || left.title.localeCompare(right.title, 'en-US') || left.sourceId.localeCompare(right.sourceId, 'en-US') }

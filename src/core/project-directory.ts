import { createHash, randomUUID } from 'node:crypto'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { redactEvidence } from './evidence-policy'
import type { ProjectStore } from './project-store'
import { SourceCatalogRepository, type ProjectSource, type SourceCitation } from './source-catalog'
import { referenceKey } from './knowledge-references'
import { projectStructuredKnowledgeGraph } from './structured-knowledge-graph'
import { projectEntityInputSchema, type DirectoryLookup, type ProjectEntity, type ProjectEntityDetail, type ProjectEntityHistory, type ProjectEntityInput, type ProjectEntityUpdate, type ProjectMention } from './project-directory-contracts'

interface EntityRow { id: string; kind: ProjectEntity['kind']; display_name: string; aliases_json: string; definition: string; references_json: string; status: ProjectEntity['status']; merged_into: string | null; version: number; created_at: string; updated_at: string }
interface MentionRow { id: string; source_id: string; revision_id: string; entity_id: string | null; candidate_ids_json: string; surface: string; citation_json: string; start_offset: number; end_offset: number; resolution: ProjectMention['resolution']; active: number; manual: number }
export interface DirectoryChange { actor: string; reason: string }
export interface DirectoryMergeInput extends DirectoryChange { expectedSourceVersion: number; expectedTargetVersion: number }
export interface DirectorySplitInput extends DirectoryChange { expectedVersion: number; entry: ProjectEntityInput; aliases: string[]; mentionIds: string[] }

export class ProjectDirectoryRepository {
  constructor(private readonly store: ProjectStore, private readonly dependencies: { clock?: Clock } = {}) {}

  create(input: ProjectEntityInput, actor = 'local-user'): ProjectEntity {
    const parsed = this.validate(input)
    return this.store.database.transaction(() => {
      const count = (this.store.database.prepare("SELECT COUNT(*) AS count FROM project_entities WHERE status='active'").get() as { count: number }).count
      if (count >= 1000) throw new WorkstackError('VALIDATION_ERROR', 'The local directory supports up to 1,000 active entries.')
      const id = `entity:${randomUUID()}`
      this.store.database.prepare(`INSERT INTO project_entities (id,kind,display_name,aliases_json,definition,references_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, parsed.kind, parsed.displayName, JSON.stringify(parsed.aliases), parsed.definition, JSON.stringify(parsed.references), this.now(), this.now())
      this.saved(id, 'created', actor, 'Created directory entry.')
      return this.get(id)
    }).immediate()
  }

  update(id: string, input: ProjectEntityUpdate, actor = 'local-user', reason = 'Updated directory entry.'): ProjectEntity {
    return this.store.database.transaction(() => {
      const existing = this.get(id)
      this.assertEditable(existing, input.expectedVersion)
      const parsed = this.validate({ ...existing, ...input })
      this.store.database.prepare('UPDATE project_entities SET display_name=?,aliases_json=?,definition=?,references_json=?,version=version+1,updated_at=? WHERE id=?')
        .run(parsed.displayName, JSON.stringify(parsed.aliases), parsed.definition, JSON.stringify(parsed.references), this.now(), id)
      this.saved(id, 'updated', actor, reason)
      return this.get(id)
    }).immediate()
  }

  get(id: string): ProjectEntity {
    const row = this.store.database.prepare('SELECT * FROM project_entities WHERE id=?').get(id) as EntityRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The component or glossary entry does not exist in this project.')
    return decodeEntity(row)
  }

  canonicalId(id: string): string {
    const visited = new Set<string>()
    let entry = this.get(id)
    while (entry.mergedInto) {
      if (visited.has(entry.id)) throw new WorkstackError('VALIDATION_ERROR', 'The directory contains a merge cycle.')
      visited.add(entry.id)
      entry = this.get(entry.mergedInto)
    }
    return entry.id
  }

  list(options: { kind?: ProjectEntity['kind']; includeHistorical?: boolean } = {}): ProjectEntity[] {
    return (this.store.database.prepare('SELECT * FROM project_entities ORDER BY display_name COLLATE NOCASE,id').all() as EntityRow[])
      .filter((row) => (!options.kind || row.kind === options.kind) && (options.includeHistorical || row.status === 'active')).map(decodeEntity)
  }

  lookup(query: string, options: { limit?: number; suggestions?: boolean } = {}): DirectoryLookup {
    const normalized = normalizeDirectoryName(query)
    if (!normalized || query.length > 500) return { query, match: 'none', candidates: [] }
    const entries = this.list()
    const exact = entries.filter((entry) => [entry.displayName, ...entry.aliases].some((name) => normalizeDirectoryName(name) === normalized))
    const limit = Math.max(1, Math.min(100, options.limit ?? 20))
    if (exact.length) return { query, match: exact.length > 1 ? 'ambiguous' : 'exact', candidates: exact.slice(0, limit) }
    if (options.suggestions === false) return { query, match: 'none', candidates: [] }
    const simplified = suggestionKey(query)
    const suggestions = entries.filter((entry) => [entry.displayName, ...entry.aliases].some((name) => suggestionKey(name) === simplified || (normalized.length >= 3 && normalizeDirectoryName(name).includes(normalized))))
    return { query, match: suggestions.length ? 'suggestion' : 'none', candidates: suggestions.slice(0, limit) }
  }

  detail(id: string, options: { includeHistoricalMentions?: boolean } = {}): ProjectEntityDetail {
    const entity = this.get(id)
    const canonicalEntity = this.get(this.canonicalId(id))
    const mentions = this.mentions(canonicalEntity.id, { includeHistorical: options.includeHistoricalMentions })
    const cappedSource = this.store.database.prepare('SELECT source_id FROM project_mentions WHERE active=1 GROUP BY source_id HAVING COUNT(*)>=5000 LIMIT 1').get()
    return { entity, canonicalEntity, mentions, history: this.history(id), mentionsTruncated: mentions.length >= 500 || Boolean(cappedSource), mentionLimits: { returned: 500, perSource: 5000 } }
  }

  history(id: string): ProjectEntityHistory[] {
    this.get(id)
    return (this.store.database.prepare('SELECT * FROM project_entity_history WHERE entity_id=? ORDER BY id DESC').all(id) as Array<{ id: number; entity_id: string; action: string; actor: string; reason: string; created_at: string; snapshot_json: string }>)
      .map((row) => ({ id: row.id, entityId: row.entity_id, action: row.action, actor: row.actor, reason: row.reason, createdAt: row.created_at, snapshot: JSON.parse(row.snapshot_json) as ProjectEntity }))
  }

  merge(sourceId: string, targetId: string, input: DirectoryMergeInput): ProjectEntityDetail {
    return this.store.database.transaction(() => {
      const source = this.get(sourceId)
      const target = this.get(targetId)
      this.assertEditable(source, input.expectedSourceVersion)
      this.assertEditable(target, input.expectedTargetVersion)
      if (source.id === target.id || source.kind !== target.kind) throw new WorkstackError('VALIDATION_ERROR', 'Merge two different active entries of the same kind.')
      const aliases = uniqueAliases([...target.aliases, source.displayName, ...source.aliases], target.displayName)
      if (aliases.length > 100) throw new WorkstackError('VALIDATION_ERROR', 'Merging would exceed 100 approved aliases; remove obsolete aliases first.')
      const references = [...new Map([...target.references, ...source.references].map((reference) => [referenceKey(reference), reference])).values()]
      if (references.length > 200) throw new WorkstackError('VALIDATION_ERROR', 'Merging would exceed 200 evidence references; curate the entries first.')
      this.store.database.prepare('UPDATE project_entities SET aliases_json=?,references_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(aliases), JSON.stringify(references), this.now(), target.id)
      this.store.database.prepare("UPDATE project_entities SET status='merged',merged_into=?,version=version+1,updated_at=? WHERE id=?").run(target.id, this.now(), source.id)
      this.saved(source.id, 'merged', input.actor, `${input.reason} Surviving identity: ${target.id}.`)
      this.saved(target.id, 'merge_target', input.actor, `${input.reason} Merged identity: ${source.id}.`)
      return this.detail(target.id)
    }).immediate()
  }

  split(id: string, input: DirectorySplitInput): ProjectEntityDetail {
    return this.store.database.transaction(() => {
      const source = this.get(id)
      this.assertEditable(source, input.expectedVersion)
      if (source.kind !== input.entry.kind || input.aliases.some((alias) => !source.aliases.some((existing) => normalizeDirectoryName(existing) === normalizeDirectoryName(alias)))) throw new WorkstackError('VALIDATION_ERROR', 'Split aliases must belong to the original entry, and the new entry must have the same kind.')
      this.synchronizeMentions()
      const chosen = [...new Set(input.mentionIds)].map((mentionId) => this.mentionRow(mentionId))
      if (chosen.some((mention) => mention.resolution === 'resolved' ? !mention.entity_id || this.canonicalId(mention.entity_id) !== source.id : mention.resolution !== 'candidate' || !(JSON.parse(mention.candidate_ids_json) as string[]).some((candidate) => this.canonicalId(candidate) === source.id))) throw new WorkstackError('VALIDATION_ERROR', 'Selected mentions must refer to the original entry.')
      const created = this.create({ ...input.entry, aliases: [...(input.entry.aliases ?? []), ...input.aliases] }, input.actor)
      this.store.database.prepare('UPDATE project_entities SET aliases_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(source.aliases.filter((alias) => !input.aliases.some((moved) => normalizeDirectoryName(moved) === normalizeDirectoryName(alias)))), this.now(), id)
      this.saved(id, 'split', input.actor, `${input.reason} New identity: ${created.id}.`)
      this.saved(created.id, 'split_from', input.actor, `${input.reason} Split from: ${id}.`)
      for (const mention of chosen) this.resolveMention(mention.id, created.id, input.actor, input.reason)
      return this.detail(created.id, { includeHistoricalMentions: true })
    }).immediate()
  }

  retire(id: string, expectedVersion: number, actor: string, reason: string): ProjectEntity {
    return this.store.database.transaction(() => {
      const entry = this.get(id)
      this.assertEditable(entry, expectedVersion)
      this.store.database.prepare("UPDATE project_entities SET status='retired',version=version+1,updated_at=? WHERE id=?").run(this.now(), id)
      this.saved(id, 'retired', actor, reason)
      return this.get(id)
    }).immediate()
  }

  resolveMention(mentionId: string, entityId: string | null, actor: string, reason: string): ProjectMention {
    requireReason(actor, reason)
    return this.store.database.transaction(() => {
      const before = this.mentionRow(mentionId)
      const canonicalId = entityId ? this.canonicalId(entityId) : null
      if (canonicalId && this.get(canonicalId).status !== 'active') throw new WorkstackError('VALIDATION_ERROR', 'A resolved mention needs an active project identity.')
      this.store.database.prepare('UPDATE project_mentions SET entity_id=?,resolution=?,manual=1 WHERE id=?').run(canonicalId, canonicalId ? 'resolved' : 'dismissed', mentionId)
      const after = this.mentionRow(mentionId)
      this.store.database.prepare('INSERT INTO project_mention_history (mention_id,actor,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(mentionId, redactEvidence(actor), redactEvidence(reason), JSON.stringify(before), JSON.stringify(after), this.now())
      return this.decodeMention(after)
    }).immediate()
  }

  mentions(entityId?: string, options: { includeHistorical?: boolean; limit?: number } = {}): ProjectMention[] {
    this.synchronizeMentions()
    const canonicalId = entityId ? this.canonicalId(entityId) : undefined
    return (this.store.database.prepare('SELECT * FROM project_mentions ORDER BY source_id,start_offset,id').all() as MentionRow[])
      .filter((row) => (options.includeHistorical || row.active) && (!canonicalId || row.resolution === 'resolved' && row.entity_id && this.canonicalId(row.entity_id) === canonicalId || row.resolution === 'candidate' && (JSON.parse(row.candidate_ids_json) as string[]).some((id) => this.canonicalId(id) === canonicalId)))
      .slice(0, Math.max(1, Math.min(2000, options.limit ?? 500))).map((row) => this.decodeMention(row))
  }

  /** Reconciles exact current source revisions lazily before every mention read; unrelated sources remain untouched. */
  synchronizeMentions(): void {
    this.store.database.transaction(() => {
      const catalog = new SourceCatalogRepository(this.store, { clock: this.dependencies.clock })
      const version = (this.store.database.prepare('SELECT version FROM project_directory_state WHERE id=1').get() as { version: number }).version
      const names = new Map<string, { forms: Set<string>; ids: Set<string> }>()
      for (const entry of this.list()) for (const form of [entry.displayName, ...entry.aliases]) {
        const key = normalizeDirectoryName(form)
        const candidate = names.get(key) ?? { forms: new Set<string>(), ids: new Set<string>() }
        candidate.forms.add(form); candidate.ids.add(entry.id); names.set(key, candidate)
      }
      const forms = [...new Set([...names.values()].flatMap((candidate) => [...candidate.forms]))].sort((left, right) => right.length - left.length || left.localeCompare(right))
      const matcher = forms.length ? new RegExp(forms.map(escapeRegex).join('|'), 'giu') : undefined
      for (const source of catalog.listSources()) {
        const prior = this.store.database.prepare('SELECT * FROM project_mention_scopes WHERE source_id=?').get(source.id) as { revision_id: string | null; directory_version: number; readiness: string } | undefined
        if (prior?.revision_id === (source.currentRevisionId ?? null) && prior.directory_version === version && prior.readiness === source.state) continue
        this.store.database.prepare('UPDATE project_mentions SET active=0 WHERE source_id=?').run(source.id)
        if (source.currentRevisionId && !source.deletedAt && matcher) this.indexSource(source, matcher, names, catalog)
        this.store.database.prepare('INSERT INTO project_mention_scopes (source_id,revision_id,directory_version,readiness) VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision_id=excluded.revision_id,directory_version=excluded.directory_version,readiness=excluded.readiness')
          .run(source.id, source.currentRevisionId ?? null, version, source.state)
      }
    }).immediate()
  }

  private indexSource(source: ProjectSource, matcher: RegExp, names: Map<string, { forms: Set<string>; ids: Set<string> }>, catalog: SourceCatalogRepository): void {
    const passages = this.store.database.prepare('SELECT id FROM source_passages WHERE revision_id=? ORDER BY ordinal').all(source.currentRevisionId) as Array<{ id: string }>
    let count = 0
    for (const row of passages) {
      const passage = catalog.getPassage(row.id)
      matcher.lastIndex = 0
      for (const match of passage.text.matchAll(matcher)) {
        if (count >= 5000) break
        const surface = match[0]
        const localStart = match.index
        if ((isIdentifierCharacter(surface[0]) && isIdentifierCharacter(passage.text[localStart - 1])) || (isIdentifierCharacter(surface.at(-1)) && isIdentifierCharacter(passage.text[localStart + surface.length]))) continue
        const ids = [...(names.get(normalizeDirectoryName(surface))?.ids ?? [])].sort()
        if (!ids.length) continue
        const start = passage.citation.startOffset + localStart
        const end = start + surface.length
        const id = `mention:${createHash('sha256').update(`${source.id}:${source.currentRevisionId}:${start}:${end}`).digest('hex').slice(0, 32)}`
        this.store.database.prepare(`INSERT INTO project_mentions (id,source_id,revision_id,entity_id,candidate_ids_json,surface,citation_json,start_offset,end_offset,resolution,active)
          VALUES (?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET active=1,candidate_ids_json=excluded.candidate_ids_json,
          entity_id=CASE WHEN manual=1 THEN project_mentions.entity_id ELSE excluded.entity_id END,
          resolution=CASE WHEN manual=1 THEN project_mentions.resolution ELSE excluded.resolution END`)
          .run(id, source.id, source.currentRevisionId, ids.length === 1 ? ids[0] : null, JSON.stringify(ids), surface, JSON.stringify(passage.citation), start, end, ids.length === 1 ? 'resolved' : 'candidate')
        count += 1
      }
    }
  }
  private mentionRow(id: string): MentionRow {
    const row = this.store.database.prepare('SELECT * FROM project_mentions WHERE id=?').get(id) as MentionRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The source mention does not exist in this project.')
    return row
  }
  private decodeMention(row: MentionRow): ProjectMention {
    const source = new SourceCatalogRepository(this.store, { clock: this.dependencies.clock }).getSource(row.source_id)
    return { id: row.id, entityId: row.entity_id ? this.canonicalId(row.entity_id) : undefined, candidateIds: [...new Set((JSON.parse(row.candidate_ids_json) as string[]).map((id) => this.canonicalId(id)))], surface: row.surface,
      citation: JSON.parse(row.citation_json) as SourceCitation, startOffset: row.start_offset, endOffset: row.end_offset, resolution: row.resolution,
      historical: !row.active || Boolean(source.deletedAt) || source.currentRevisionId !== row.revision_id, readiness: source.state, workItemId: source.workItemId }
  }
  private validate(input: ProjectEntityInput) {
    const parsed = projectEntityInputSchema.parse(input)
    const displayName = redactEvidence(parsed.displayName)
    return { ...parsed, displayName, definition: redactEvidence(parsed.definition), aliases: uniqueAliases((parsed.aliases ?? []).map(redactEvidence), displayName), references: parsed.references ?? [] }
  }
  private assertEditable(entry: ProjectEntity, expectedVersion: number): void {
    if (entry.status !== 'active' || entry.version !== expectedVersion) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The entry changed or is historical. Reload its current identity before editing.')
  }
  private saved(id: string, action: string, actor: string, reason: string): void {
    requireReason(actor, reason)
    this.store.database.prepare('INSERT INTO project_entity_history (entity_id,action,actor,reason,created_at,snapshot_json) VALUES (?,?,?,?,?,?)').run(id, action, redactEvidence(actor), redactEvidence(reason), this.now(), JSON.stringify(this.get(id)))
    projectStructuredKnowledgeGraph(this.store, this.get(id))
    this.store.database.prepare('UPDATE project_directory_state SET version=version+1 WHERE id=1').run()
  }
  private now(): string { return (this.dependencies.clock ?? systemClock).now().toISOString() }
}
export function normalizeDirectoryName(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu, ' ') }
function suggestionKey(value: string): string { return normalizeDirectoryName(value).replace(/[^\p{L}\p{N}]/gu, '') }
function uniqueAliases(values: string[], name: string): string[] { return [...new Map(values.filter((value) => normalizeDirectoryName(value) !== normalizeDirectoryName(name)).map((value) => [normalizeDirectoryName(value), value.trim()])).values()] }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function isIdentifierCharacter(value: string | undefined): boolean { return value ? /[\p{L}\p{N}_]/u.test(value) : false }
function requireReason(actor: string, reason: string): void { if (!actor.trim() || actor.length > 200 || !reason.trim() || reason.length > 20_000) throw new WorkstackError('VALIDATION_ERROR', 'An actor and meaningful correction reason are required.') }
function decodeEntity(row: EntityRow): ProjectEntity { return { id: row.id, kind: row.kind, displayName: row.display_name, aliases: JSON.parse(row.aliases_json) as string[], definition: row.definition, references: JSON.parse(row.references_json) as ProjectEntity['references'], status: row.status, mergedInto: row.merged_into ?? undefined, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, locator: `project-entity://${row.id}`, trust: 'untrusted_reference' } }

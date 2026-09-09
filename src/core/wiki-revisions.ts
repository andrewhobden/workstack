import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ProjectStore } from './project-store'
import { WorkstackError } from './errors'
import { systemClock, type Clock } from './clock'
import { SourceCatalogRepository, type SourceCitation } from './source-catalog'

export interface WikiRevisionPage { slug: string; content: string; contentHash: string }
export interface WikiRevision {
  id: string; requestKey: string; title: string; baseRevisionId: string | null
  status: 'proposed' | 'published' | 'superseded' | 'rejected'
  author: string; rationale: string; evidence: Record<string, unknown>; actor: string | null; reviewNote: string | null; createdAt: string; reviewedAt: string | null
}
export interface WikiRevisionReview { revision: WikiRevision; pages: WikiRevisionPage[]; changes: Array<{ slug: string; before: string; after: string }> }
export interface WikiRevisionInput {
  requestKey: string; title: string; pages: Array<{ slug: string; content: string }>
  author?: string; rationale?: string; evidence?: Record<string, unknown>; baseRevisionId?: string | null
}
interface RevisionRow {
  id: string; request_key: string; title: string; base_revision_id: string | null; status: WikiRevision['status']; author: string; rationale: string
  evidence_json: string; actor: string | null; review_note: string | null; created_at: string; reviewed_at: string | null
}

/** Returns null only when no canonical snapshot exists, so old generated files cannot reappear after a restore. */
export function readPublishedWikiPages(database: Database.Database): WikiRevisionPage[] | null {
  const id = (database.prepare('SELECT revision_id FROM wiki_publication WHERE id = 1').get() as { revision_id: string } | undefined)?.revision_id
  return id ? readPages(database, id) : null
}

/** Generated articles publish through one SQLite pointer; an unfinished draft never changes readers. */
export class WikiRevisionRepository {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  currentId(): string | null { return (this.store.database.prepare('SELECT revision_id FROM wiki_publication WHERE id = 1').get() as { revision_id: string } | undefined)?.revision_id ?? null }
  currentPages(): WikiRevisionPage[] { return readPublishedWikiPages(this.store.database) ?? this.legacyPages() }

  /** Capture any legacy articles once, before an asynchronous generator starts reading its base. */
  snapshot(): { revisionId: string | null; pages: WikiRevisionPage[] } {
    return this.store.database.transaction(() => {
      this.captureLegacyBaseline()
      return { revisionId: this.currentId(), pages: this.currentPages() }
    }).immediate()
  }

  list(): WikiRevision[] { return (this.store.database.prepare('SELECT * FROM wiki_revisions ORDER BY created_at DESC,rowid DESC').all() as RevisionRow[]).map(decode) }
  findByRequestKey(requestKey: string): WikiRevisionReview | undefined {
    const row = this.store.database.prepare('SELECT id FROM wiki_revisions WHERE request_key = ?').get(requestKey) as { id: string } | undefined
    return row ? this.review(row.id) : undefined
  }

  stage(input: WikiRevisionInput): WikiRevisionReview {
    if (!input.requestKey.trim() || input.requestKey.length > 500 || !input.title.trim() || input.title.length > 1000 || !input.pages.length) throw new WorkstackError('VALIDATION_ERROR', 'A wiki proposal requires an identity, title and changed pages.')
    const slugs = new Set<string>()
    for (const value of input.pages) {
      if (!/^generated-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) || !value.content.trim() || value.content.length > 200_000 || slugs.has(value.slug)) throw new WorkstackError('VALIDATION_ERROR', 'Generated pages need unique reserved slugs and nonempty content of at most 200,000 characters.')
      slugs.add(value.slug)
    }
    const evidence = JSON.stringify(input.evidence ?? {})
    if (evidence.length > 2_000_000) throw new WorkstackError('VALIDATION_ERROR', 'Wiki proposal evidence exceeds the review limit.')
    return this.store.database.transaction(() => {
      const existing = this.findByRequestKey(input.requestKey)
      if (existing) return existing
      this.captureLegacyBaseline()
      const base = input.baseRevisionId === undefined ? this.currentId() : input.baseRevisionId
      const inherited = base ? this.pages(base) : []
      const pages = new Map(inherited.map((value) => [value.slug, value]))
      input.pages.forEach((value) => pages.set(value.slug, page(value.slug, value.content)))
      this.validateCitations(input.evidence ?? {})
      validateLocalLinks([...pages.values()], this.store.paths.wikiPath)
      const id = randomUUID()
      this.store.database.prepare(`INSERT INTO wiki_revisions (id,request_key,title,base_revision_id,status,author,rationale,evidence_json,created_at)
        VALUES (?,?,?,?,'proposed',?,?,?,?)`).run(id, input.requestKey, input.title.trim(), base, input.author?.trim() || 'wiki-automation', input.rationale?.trim() || 'Review the proposed changes against the attached evidence.', evidence, this.clock.now().toISOString())
      this.insertPages(id, [...pages.values()])
      return this.review(id)
    }).immediate()
  }

  review(id: string): WikiRevisionReview {
    const revision = this.get(id)
    const pages = this.pages(id)
    const base = new Map((revision.baseRevisionId ? this.pages(revision.baseRevisionId) : []).map((value) => [value.slug, value.content]))
    const next = new Map(pages.map((value) => [value.slug, value.content]))
    const changes = [...new Set([...base.keys(), ...next.keys()])].sort().filter((slug) => base.get(slug) !== next.get(slug))
      .map((slug) => ({ slug, before: base.get(slug) ?? '', after: next.get(slug) ?? '' }))
    return { revision, pages, changes }
  }

  publish(id: string, actor: string, note = ''): WikiRevisionReview {
    if (!actor.trim()) throw new WorkstackError('VALIDATION_ERROR', 'A reviewer identity is required.')
    return this.store.database.transaction(() => {
      const revision = this.get(id)
      if (revision.status === 'published' && this.currentId() === id) return this.review(id)
      if (revision.status !== 'proposed') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only a proposed revision can be published.')
      if (revision.baseRevisionId !== this.currentId()) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The wiki changed after this proposal. Regenerate or reconcile it against the current revision before publishing.')
      const pages = this.pages(id)
      this.validateCitations(revision.evidence)
      validateLocalLinks(pages, this.store.paths.wikiPath)
      const priorPages = this.currentPages()
      this.store.database.prepare("UPDATE wiki_revisions SET status = 'superseded' WHERE status = 'published'").run()
      this.store.database.prepare("UPDATE wiki_revisions SET status = 'published', actor = ?, review_note = ?, reviewed_at = ? WHERE id = ?").run(actor.trim(), note, this.clock.now().toISOString(), id)
      this.store.database.prepare('INSERT INTO wiki_publication (id,revision_id) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET revision_id = excluded.revision_id').run(id)
      this.store.database.prepare("DELETE FROM knowledge_search WHERE source_id LIKE 'wiki:generated-%'").run()
      const index = this.store.database.prepare('INSERT INTO knowledge_search (source_id,title,content) VALUES (?,?,?)')
      const catalog = new SourceCatalogRepository(this.store, { clock: this.clock })
      for (const value of pages) {
        index.run(`wiki:${value.slug}`, `Wiki: ${value.slug}`, value.content)
        const source = catalog.registerSource({ id: `wiki:${value.slug}`, kind: 'wiki', title: value.slug, canonicalUri: `wiki://${this.store.project.id}/${value.slug}`, policy: 'import_once' })
        catalog.publishRevision({ sourceId: source.id, original: value.content, upstreamRevision: id, acquiredBy: actor.trim(), converter: 'workstack-wiki', converterVersion: '1', metadata: { wikiRevisionId: id, authority: 'reviewed', reviewNote: note } })
      }
      for (const old of priorPages) {
        if (!pages.some((value) => value.slug === old.slug) && this.store.database.prepare('SELECT id FROM source_catalog WHERE id = ?').get(`wiki:${old.slug}`)) catalog.recordFreshness(`wiki:${old.slug}`, { unavailable: true, deleted: true, reason: `Removed by published wiki revision ${id}.` })
      }
      return this.review(id)
    }).immediate()
  }

  reject(id: string, actor: string, reason: string): WikiRevision {
    if (!actor.trim() || !reason.trim()) throw new WorkstackError('VALIDATION_ERROR', 'A reviewer and rejection reason are required.')
    const changed = this.store.database.prepare("UPDATE wiki_revisions SET status = 'rejected', actor = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND status = 'proposed'").run(actor.trim(), reason.trim(), this.clock.now().toISOString(), id)
    if (changed.changes !== 1) throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only proposed revisions can be rejected.')
    return this.get(id)
  }

  /** Reconcile only independent edits whose unchanged text can be proven; ambiguous rewrites need a new reviewed draft. */
  reconcile(id: string, actor: string, reason: string): WikiRevisionReview {
    if (!actor.trim() || !reason.trim()) throw new WorkstackError('VALIDATION_ERROR', 'A reviewer and reconciliation reason are required.')
    return this.store.database.transaction(() => {
      const current = this.snapshot()
      const requestKey = `reconcile:${id}:${current.revisionId}`
      const existing = this.findByRequestKey(requestKey)
      if (existing) return existing
      const proposal = this.review(id)
      if (proposal.revision.status !== 'proposed') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only a proposed revision can be reconciled.')
      if (proposal.revision.baseRevisionId === current.revisionId) return proposal
      const pages = proposal.changes.map((change) => {
        const currentContent = current.pages.find((value) => value.slug === change.slug)?.content ?? ''
        if (currentContent === change.before) return { slug: change.slug, content: change.after }
        const key = proposal.revision.evidence.sectionKey
        const start = typeof key === 'string' ? `<!-- workstack-update:${key}:start -->` : ''
        const end = typeof key === 'string' ? `<!-- workstack-update:${key}:end -->` : ''
        const begin = start ? change.after.indexOf(start) : -1
        const finish = begin >= 0 ? change.after.indexOf(end, begin) : -1
        const section = finish >= 0 ? change.after.slice(begin, finish + end.length) : ''
        if (!section || `${change.before.trim()}\n\n${section}\n`.trim() !== change.after || currentContent.includes(start)) throw new WorkstackError('INVALID_STATE_TRANSITION', `Both revisions changed ${change.slug}. Create a new reviewed draft to resolve the conflicting edits.`)
        return { slug: change.slug, content: `${currentContent.trim()}\n\n${section}\n`.trim() }
      })
      const reconciled = this.stage({ requestKey, title: proposal.revision.title, author: proposal.revision.author, rationale: reason, pages,
        baseRevisionId: current.revisionId, evidence: { ...proposal.revision.evidence, reconciledFrom: id } })
      this.reject(id, actor, `${reason} Reconciled as ${reconciled.revision.id}.`)
      return reconciled
    }).immediate()
  }

  restore(id: string, actor: string, reason: string): WikiRevisionReview {
    if (!reason.trim()) throw new WorkstackError('VALIDATION_ERROR', 'Explain why this revision should be restored.')
    return this.store.database.transaction(() => {
      const source = this.review(id)
      if (!['published', 'superseded'].includes(source.revision.status)) throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only a previously published revision can be restored.')
      const staged = this.stage({ requestKey: `restore:${randomUUID()}`, title: `Restore ${source.revision.title}`, author: actor, rationale: reason, pages: source.pages, evidence: { restoredFrom: id } })
      const wanted = new Set(source.pages.map((value) => value.slug))
      for (const value of staged.pages) if (!wanted.has(value.slug)) this.store.database.prepare('DELETE FROM wiki_revision_pages WHERE revision_id = ? AND slug = ?').run(staged.revision.id, value.slug)
      return this.publish(staged.revision.id, actor, reason)
    }).immediate()
  }

  private get(id: string): WikiRevision {
    const row = this.store.database.prepare('SELECT * FROM wiki_revisions WHERE id = ?').get(id) as RevisionRow | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'Wiki revision not found.')
    return decode(row)
  }
  private pages(id: string): WikiRevisionPage[] { this.get(id); return readPages(this.store.database, id) }
  private insertPages(id: string, pages: WikiRevisionPage[]): void {
    const insert = this.store.database.prepare('INSERT INTO wiki_revision_pages (revision_id,slug,content,content_hash) VALUES (?,?,?,?)')
    for (const value of pages) insert.run(id, value.slug, value.content, value.contentHash)
  }
  private legacyPages(): WikiRevisionPage[] {
    if (!existsSync(this.store.paths.wikiPath)) return []
    return readdirSync(this.store.paths.wikiPath).filter((name) => /^generated-[a-z0-9-]+\.md$/.test(name) && lstatSync(path.join(this.store.paths.wikiPath, name)).isFile())
      .sort().map((name) => page(name.slice(0, -3), readFileSync(path.join(this.store.paths.wikiPath, name), 'utf8')))
  }
  private captureLegacyBaseline(): void {
    if (this.currentId()) return
    const pages = this.legacyPages()
    if (!pages.length) return
    const id = randomUUID()
    const now = this.clock.now().toISOString()
    this.store.database.prepare(`INSERT INTO wiki_revisions (id,request_key,title,status,author,rationale,evidence_json,actor,review_note,created_at,reviewed_at)
      VALUES (?,?,'Imported existing generated wiki','published','legacy-import','Preserve existing articles as the comparison baseline.','{}','legacy-import','Existing content retained; no new factual review claimed.',?,?)`).run(id, `legacy:${id}`, now, now)
    this.insertPages(id, pages)
    this.store.database.prepare('INSERT INTO wiki_publication (id,revision_id) VALUES (1,?)').run(id)
  }
  private validateCitations(evidence: Record<string, unknown>): void {
    if (evidence.sourceCitations === undefined) return
    if (!Array.isArray(evidence.sourceCitations) || evidence.sourceCitations.length > 500) throw new WorkstackError('VALIDATION_ERROR', 'Wiki evidence must contain bounded source citations.')
    const catalog = new SourceCatalogRepository(this.store, { clock: this.clock })
    for (const citation of evidence.sourceCitations) catalog.readCitation(citation as SourceCitation)
  }
}
function page(slug: string, content: string): WikiRevisionPage { return { slug, content, contentHash: createHash('sha256').update(content).digest('hex') } }
function readPages(database: Database.Database, id: string): WikiRevisionPage[] {
  return (database.prepare('SELECT slug,content,content_hash FROM wiki_revision_pages WHERE revision_id = ? ORDER BY slug').all(id) as Array<{ slug: string; content: string; content_hash: string }>).map((value) => ({ slug: value.slug, content: value.content, contentHash: value.content_hash }))
}
function decode(row: RevisionRow): WikiRevision { return { id: row.id, requestKey: row.request_key, title: row.title, baseRevisionId: row.base_revision_id, status: row.status, author: row.author, rationale: row.rationale, evidence: JSON.parse(row.evidence_json) as Record<string, unknown>, actor: row.actor, reviewNote: row.review_note, createdAt: row.created_at, reviewedAt: row.reviewed_at } }
function validateLocalLinks(pages: WikiRevisionPage[], wikiRoot: string): void {
  const slugs = new Set(pages.map((value) => value.slug))
  for (const value of pages) for (const match of value.content.matchAll(/\]\((?:\.\/)?([a-z0-9][a-z0-9-]*)\.md(?:#[^)]*)?\)/g)) {
    const slug = match[1]
    const manualPath = path.join(wikiRoot, `${slug}.md`)
    if (!slugs.has(slug) && (slug.startsWith('generated-') || !existsSync(manualPath) || !lstatSync(manualPath).isFile())) throw new WorkstackError('VALIDATION_ERROR', `Wiki proposal contains a missing local article: ${slug}.`)
  }
}

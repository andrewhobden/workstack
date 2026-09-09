import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { ProjectStore } from './project-store'
import { KnowledgeJobsRepository } from './knowledge-jobs'
import { WikiRevisionRepository } from './wiki-revisions'
import { KnowledgeRetrievalService } from './knowledge-retrieval'
import { SourceCatalogRepository } from './source-catalog'
import type { ProjectKnowledgeRetrieval } from './knowledge-retrieval-contracts'
export { KNOWLEDGE_RETRIEVAL_SOURCE_TYPES } from './knowledge-retrieval-contracts'
export type { KnowledgeRetrievalSourceType, KnowledgeRetrievalResult, KnowledgeRetrievalGroup, ProjectKnowledgeRetrieval } from './knowledge-retrieval-contracts'

export interface KnowledgeSource {
  id: string
  kind: 'file' | 'work_completion' | 'manual' | 'folder' | 'other'
  displayName: string
  relativeOrExternalLocation: string
  status: 'pending' | 'indexed' | 'failed'
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}

export interface WikiArticle {
  slug: string
  content: string
}

const GENERATED_WIKI_SLUG_PREFIX = 'generated-'

interface KnowledgeSourceRow {
  source_work_item_id?: string | null
  error_message?: string | null
  id: string
  kind: KnowledgeSource['kind']
  display_name: string
  relative_or_external_location: string
  status: KnowledgeSource['status']
  created_at: string
  updated_at: string
}

const manualSourceSchema = z.object({
  displayName: z.string().trim().min(1),
  filename: z.string().trim().min(1),
  content: z.string().trim().min(1)
})

export class KnowledgeRepository {
  constructor(
    private readonly store: ProjectStore,
    private readonly dependencies: { clock?: Clock; id?: () => string } = {}
  ) {}

  addManualSource(input: { displayName: string; filename: string; content: string }): KnowledgeSource {
    const parsed = manualSourceSchema.parse(input)
    const now = (this.dependencies.clock ?? systemClock).now().toISOString()
    const id = (this.dependencies.id ?? randomUUID)()
    const filename = safeFilename(parsed.filename)
    const relativeOrExternalLocation = `knowledge/raw/${id}-${filename}`
    const source: KnowledgeSource = {
      id,
      kind: 'manual',
      displayName: parsed.displayName,
      relativeOrExternalLocation,
      status: 'indexed',
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    }
    this.store.database.transaction(() => {
      mkdirSync(this.store.paths.rawKnowledgePath, { recursive: true })
      writeFileSync(path.join(this.store.paths.workstackPath, relativeOrExternalLocation), parsed.content, 'utf8')
      this.store.database
        .prepare(
          `INSERT INTO knowledge_sources (
            id, kind, display_name, relative_or_external_location, status, created_at, updated_at
          ) VALUES (@id, @kind, @displayName, @relativeOrExternalLocation, @status, @createdAt, @updatedAt)`
        )
        .run(source)
      this.store.database
        .prepare('INSERT INTO knowledge_search (source_id, title, content) VALUES (?, ?, ?)')
        .run(id, source.displayName, parsed.content)
      const catalog = new SourceCatalogRepository(this.store, this.dependencies)
      catalog.registerSource({ id, kind: 'manual', title: source.displayName, canonicalUri: `workstack://manual/${id}`, repositoryPath: relativeOrExternalLocation })
      catalog.publishRevision({ sourceId: id, original: parsed.content })
    }).immediate()
    return toKnowledgeSource(this.store.database.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as KnowledgeSourceRow)
  }

  listSources(): KnowledgeSource[] {
    return (this.store.database
      .prepare('SELECT * FROM knowledge_sources ORDER BY created_at DESC, id DESC')
      .all() as KnowledgeSourceRow[]).map(toKnowledgeSource)
  }

  processNextJob(): KnowledgeSource | undefined {
    const jobs = new KnowledgeJobsRepository(this.store, { clock: this.dependencies.clock })
    const claimed = jobs.claimNext('legacy')
    if (!claimed) return undefined
    const { job, owner } = claimed
    const now = (this.dependencies.clock ?? systemClock).now().toISOString()
    try {
      return this.store.database.transaction(() => {
        jobs.assertOwner(job.id, owner)
        const source = this.store.database.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(job.sourceId) as KnowledgeSourceRow
        const content = this.completionContent(source) ?? readFileSync(path.join(this.store.paths.workstackPath, source.relative_or_external_location), 'utf8')
        this.store.database.prepare('DELETE FROM knowledge_search WHERE source_id = ?').run(source.id)
        this.store.database.prepare('INSERT INTO knowledge_search (source_id, title, content) VALUES (?, ?, ?)').run(source.id, source.display_name, content)
        this.appendCompletionKnowledge(source, content)
        this.store.database.prepare("UPDATE knowledge_sources SET status = 'indexed', error_message = NULL, updated_at = ? WHERE id = ?").run(now, source.id)
        jobs.complete(job.id, owner)
        return { ...toKnowledgeSource(source), status: 'indexed' as const, errorMessage: null, updatedAt: now }
      }).immediate()
    } catch (error) {
      jobs.fail(job.id, owner, error)
      this.store.database.prepare("UPDATE knowledge_sources SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(String(error), now, job.sourceId)
      return this.listSources().find((source) => source.id === job.sourceId)
    }
  }

  private completionContent(source: KnowledgeSourceRow): string | undefined {
    if (source.kind !== 'work_completion' || !source.source_work_item_id) return undefined
    const row = this.store.database.prepare('SELECT * FROM completion_records WHERE work_item_id = ?').get(source.source_work_item_id) as Record<string, unknown> | undefined
    if (!row) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The completion evidence is missing; it cannot be indexed as empty content.')
    return ['# Completion', row.summary_markdown, '## Worker handoff', row.session_summary_markdown, '## Implementation notes', row.implementation_notes_markdown,
      '## Validation', row.validation_markdown, '## Known limitations', row.known_limitations_markdown, '## Files changed', row.files_changed_json,
      '## Components changed', row.components_changed_json, '## Delivery', row.branch, row.commit_sha, row.pr_url].filter(Boolean).join('\n\n')
  }

  retryFailedJobs(): number {
    const jobs = new KnowledgeJobsRepository(this.store, { clock: this.dependencies.clock })
    const failed = jobs.list('legacy').filter((job) => job.status === 'failed')
    failed.forEach((job) => jobs.retry(job.id))
    return failed.length
  }

  listWikiArticles(): WikiArticle[] {
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    const manual = readdirSync(this.store.paths.wikiPath)
      .filter((filename) => filename.endsWith('.md') && !filename.startsWith('generated-'))
      .sort()
      .map((filename) => ({ slug: filename.slice(0, -3), content: readFileSync(path.join(this.store.paths.wikiPath, filename), 'utf8') }))
    return [...manual, ...new WikiRevisionRepository(this.store).currentPages().map(({ slug, content }) => ({ slug, content }))].sort((left, right) => left.slug.localeCompare(right.slug))
  }

  saveWikiArticle(slug: string, content: string): WikiArticle {
    const safeSlug = wikiSlug(slug)
    if (isGeneratedWikiSlug(safeSlug)) {
      throw new WorkstackError('VALIDATION_ERROR', 'Generated wiki articles are reserved for automation.')
    }
    return this.writeWikiArticle(safeSlug, content)
  }

  saveGeneratedWikiArticle(slug: string, content: string): WikiArticle {
    const safeSlug = wikiSlug(slug)
    if (!isGeneratedWikiSlug(safeSlug)) {
      throw new WorkstackError('VALIDATION_ERROR', 'The generated wiki API only accepts reserved generated article slugs.')
    }
    const revisions = new WikiRevisionRepository(this.store, this.dependencies.clock ?? systemClock)
    const staged = revisions.stage({ requestKey: `explicit-write:${randomUUID()}`, title: `Update ${safeSlug}`, pages: [{ slug: safeSlug, content }], author: 'explicit-generated-writer', rationale: 'Explicit generated-article write through the local compatibility API.' })
    revisions.publish(staged.revision.id, 'explicit-generated-writer', 'Explicit write; automated generation uses the review queue.')
    return { slug: safeSlug, content }
  }

  private writeWikiArticle(slug: string, content: string): WikiArticle {
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    const article = { slug, content }
    writeFileSync(path.join(this.store.paths.wikiPath, `${slug}.md`), content, 'utf8')
    this.store.database.transaction(() => {
      this.store.database.prepare('DELETE FROM knowledge_search WHERE source_id = ?').run(`wiki:${slug}`)
      this.store.database.prepare('INSERT INTO knowledge_search (source_id, title, content) VALUES (?, ?, ?)').run(
        `wiki:${slug}`,
        `Wiki: ${slug}`,
        content
      )
      const catalog = new SourceCatalogRepository(this.store, this.dependencies)
      const title = `Wiki: ${content.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug}`
      catalog.registerSource({ id: `wiki:${slug}`, kind: 'wiki', title, canonicalUri: `workstack://wiki/${slug}`, repositoryPath: `knowledge/wiki/${slug}.md` })
      this.store.database.prepare('UPDATE source_catalog SET title = ? WHERE id = ?').run(title, `wiki:${slug}`)
      this.store.database.prepare('UPDATE knowledge_sources SET display_name = ? WHERE id = ?').run(title, `wiki:${slug}`)
      catalog.publishRevision({ sourceId: `wiki:${slug}`, original: content, outcome: content.trim() ? 'complete' : 'unsupported', limitations: content.trim() ? [] : ['The wiki article is empty.'] })
    })()
    return article
  }

  search(query: string): Array<{ sourceId: string; title: string; excerpt: string; score: number }> {
    return new KnowledgeRetrievalService(this.store, this.dependencies.clock ?? systemClock).retrieveLexical(query, { limit: 20, sourceTypes: ['wiki_article', 'raw_source', 'completed_work'] }).results.map((result) => ({
      sourceId: result.canonicalSourceId ?? result.sourceId, title: result.sourceType === 'wiki_article' ? `Wiki: ${result.sourceId.slice(5)}` : result.title, excerpt: result.excerpt, score: result.relevance
    }))
  }

  retrieve(query: string, limit = 40): ProjectKnowledgeRetrieval {
    return new KnowledgeRetrievalService(this.store, this.dependencies.clock ?? systemClock).retrieveLexical(query, { limit })
  }

  private appendCompletionKnowledge(source: KnowledgeSourceRow, content: string): void {
    if (source.kind !== 'work_completion') return
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    upsertProjection(path.join(this.store.paths.wikiPath, 'completed-work.md'), source.id, `## ${source.display_name}\n\n${content}\n`)
    upsertProjection(path.join(this.store.paths.knowledgePath, 'log.md'), source.id, `- Indexed ${source.display_name} (${source.id}).\n`)
  }
}

function toKnowledgeSource(row: KnowledgeSourceRow): KnowledgeSource {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    relativeOrExternalLocation: row.relative_or_external_location,
    status: row.status, errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function safeFilename(filename: string): string {
  return filename.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9._-]/g, '-') || 'source.md'
}

function wikiSlug(slug: string): string {
  const safeSlug = slug.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(safeSlug)) {
    throw new WorkstackError('VALIDATION_ERROR', 'Wiki article names may contain lowercase letters, numbers, and hyphens only.')
  }
  return safeSlug
}

function isGeneratedWikiSlug(slug: string): boolean {
  return slug.startsWith(GENERATED_WIKI_SLUG_PREFIX)
}

function upsertProjection(filename: string, sourceId: string, content: string): void {
  const key = Buffer.from(sourceId).toString('hex')
  const start = `<!-- workstack-source:${key}:start -->`
  const end = `<!-- workstack-source:${key}:end -->`
  const previous = existsSync(filename) ? readFileSync(filename, 'utf8') : ''
  const begin = previous.indexOf(start)
  const finish = previous.indexOf(end, begin)
  const section = `${start}\n${content}\n${end}`
  const next = begin >= 0 && finish >= begin ? `${previous.slice(0, begin)}${section}${previous.slice(finish + end.length)}` : `${previous}\n\n${section}\n`
  const temporary = `${filename}.${randomUUID()}.tmp`
  writeFileSync(temporary, next, 'utf8')
  renameSync(temporary, filename)
}

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { ProjectStore } from './project-store'

export interface KnowledgeSource {
  id: string
  kind: 'file' | 'work_completion' | 'manual' | 'folder' | 'other'
  displayName: string
  relativeOrExternalLocation: string
  status: 'pending' | 'indexed' | 'failed'
  createdAt: string
  updatedAt: string
}

export interface WikiArticle {
  slug: string
  content: string
}

export const KNOWLEDGE_RETRIEVAL_SOURCE_TYPES = ['wiki_article', 'raw_source', 'completed_work', 'backlog'] as const

export type KnowledgeRetrievalSourceType = (typeof KNOWLEDGE_RETRIEVAL_SOURCE_TYPES)[number]

export interface KnowledgeRetrievalResult {
  sourceId: string
  sourceType: KnowledgeRetrievalSourceType
  title: string
  excerpt: string
  location: string
  relevance: number
  workItemId?: string
}

export interface KnowledgeRetrievalGroup {
  sourceType: KnowledgeRetrievalSourceType
  label: string
  results: KnowledgeRetrievalResult[]
}

export interface ProjectKnowledgeRetrieval {
  query: string
  results: KnowledgeRetrievalResult[]
  groups: KnowledgeRetrievalGroup[]
}

interface KnowledgeSourceRow {
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
    }).immediate()
    return source
  }

  listSources(): KnowledgeSource[] {
    return (this.store.database
      .prepare('SELECT * FROM knowledge_sources ORDER BY created_at DESC, id DESC')
      .all() as KnowledgeSourceRow[]).map(toKnowledgeSource)
  }

  processNextJob(): KnowledgeSource | undefined {
    const job = this.store.database
      .prepare("SELECT id, source_id FROM knowledge_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string; source_id: string } | undefined
    if (!job) return undefined
    const now = (this.dependencies.clock ?? systemClock).now().toISOString()
    try {
      const source = this.store.database.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(job.source_id) as KnowledgeSourceRow
      const content = readFileSync(path.join(this.store.paths.workstackPath, source.relative_or_external_location), 'utf8')
      this.store.database.transaction(() => {
        this.store.database.prepare('DELETE FROM knowledge_search WHERE source_id = ?').run(source.id)
        this.store.database.prepare('INSERT INTO knowledge_search (source_id, title, content) VALUES (?, ?, ?)').run(source.id, source.display_name, content)
        this.store.database.prepare("UPDATE knowledge_sources SET status = 'indexed', error_message = NULL, updated_at = ? WHERE id = ?").run(now, source.id)
        this.store.database.prepare("UPDATE knowledge_jobs SET status = 'completed', attempts = attempts + 1, error_message = NULL, updated_at = ? WHERE id = ?").run(now, job.id)
      })()
      this.appendCompletionKnowledge(source, content)
      return { ...toKnowledgeSource(source), status: 'indexed', updatedAt: now }
    } catch (error) {
      const message = String(error)
      this.store.database.transaction(() => {
        this.store.database.prepare("UPDATE knowledge_sources SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(message, now, job.source_id)
        this.store.database.prepare("UPDATE knowledge_jobs SET status = 'failed', attempts = attempts + 1, error_message = ?, updated_at = ? WHERE id = ?").run(message, now, job.id)
      })()
      return this.listSources().find((source) => source.id === job.source_id)
    }
  }

  retryFailedJobs(): number {
    const now = (this.dependencies.clock ?? systemClock).now().toISOString()
    return this.store.database.prepare("UPDATE knowledge_jobs SET status = 'pending', error_message = NULL, updated_at = ? WHERE status = 'failed'").run(now).changes
  }

  listWikiArticles(): WikiArticle[] {
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    return readdirSync(this.store.paths.wikiPath)
      .filter((filename) => filename.endsWith('.md'))
      .sort()
      .map((filename) => ({ slug: filename.slice(0, -3), content: readFileSync(path.join(this.store.paths.wikiPath, filename), 'utf8') }))
  }

  saveWikiArticle(slug: string, content: string): WikiArticle {
    const safeSlug = slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(safeSlug)) throw new Error('Wiki article names may contain lowercase letters, numbers, and hyphens only.')
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    const article = { slug: safeSlug, content }
    writeFileSync(path.join(this.store.paths.wikiPath, `${safeSlug}.md`), content, 'utf8')
    this.store.database.transaction(() => {
      this.store.database.prepare('DELETE FROM knowledge_search WHERE source_id = ?').run(`wiki:${safeSlug}`)
      this.store.database.prepare('INSERT INTO knowledge_search (source_id, title, content) VALUES (?, ?, ?)').run(
        `wiki:${safeSlug}`,
        `Wiki: ${safeSlug}`,
        content
      )
    })()
    return article
  }

  search(query: string): Array<{ sourceId: string; title: string; excerpt: string; score: number }> {
    const normalized = query.trim()
    if (!normalized) {
      return []
    }
    const rows = this.store.database
      .prepare(
        `SELECT source_id, title, content
         FROM knowledge_search
         WHERE knowledge_search MATCH ?
         ORDER BY rank
         LIMIT 20`
      )
      .all(normalized.split(/\s+/).map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ')) as Array<{
        source_id: string
        title: string
        content: string
      }>
    return rows.map((row, index) => ({
      sourceId: row.source_id,
      title: row.title,
      excerpt: excerptFor(row.content, normalized),
      score: 1 / (index + 1)
    }))
  }

  retrieve(query: string, limit = 40): ProjectKnowledgeRetrieval {
    const normalized = query.trim()
    if (!normalized) {
      return { query: normalized, results: [], groups: retrievalGroups([]) }
    }

    const sourceById = new Map(this.listSources().map((source) => [source.id, source]))
    const candidates: RetrievalCandidate[] = [
      ...this.listWikiArticles().map((article) => ({
        sourceId: `wiki:${article.slug}`,
        sourceType: 'wiki_article' as const,
        title: articleTitle(article),
        excerpt: excerptFor(article.content, normalized),
        location: `knowledge/wiki/${article.slug}.md`,
        content: article.content
      })),
      ...(this.store.database
        .prepare('SELECT source_id, title, content FROM knowledge_search')
        .all() as Array<{ source_id: string; title: string; content: string }>)
        .flatMap((row) => {
          const source = sourceById.get(row.source_id)
          if (!source || source.kind === 'work_completion') return []
          return [{
            sourceId: `raw:${source.id}`,
            sourceType: 'raw_source' as const,
            title: source.displayName,
            excerpt: excerptFor(row.content, normalized),
            location: source.relativeOrExternalLocation,
            content: `${row.title}\n${row.content}`
          }]
        }),
      ...(this.store.database
        .prepare(
          `SELECT wi.id, wi.display_id, wi.title, wi.description_markdown, wi.acceptance_criteria_markdown,
                  cr.summary_markdown, cr.implementation_notes_markdown, cr.validation_markdown,
                  cr.known_limitations_markdown, cr.files_changed_json, cr.components_changed_json
           FROM work_items wi
           LEFT JOIN completion_records cr ON cr.work_item_id = wi.id
           WHERE wi.status = 'completed'`
        )
        .all() as CompletedWorkRow[])
        .map((row) => {
          const content = completedWorkContent(row)
          return {
            sourceId: `completed:${row.id}`,
            sourceType: 'completed_work' as const,
            title: `${row.display_id} · ${row.title}`,
            excerpt: excerptFor(content, normalized),
            location: `work-items/${row.id}/completion.md`,
            workItemId: row.id,
            content
          }
        }),
      ...(this.store.database
        .prepare(
          `SELECT id, display_id, title, description_markdown, acceptance_criteria_markdown
           FROM work_items WHERE status = 'backlog'`
        )
        .all() as BacklogWorkRow[])
        .map((row) => {
          const content = `${row.title}\n${row.description_markdown}\n${row.acceptance_criteria_markdown}`
          return {
            sourceId: `backlog:${row.id}`,
            sourceType: 'backlog' as const,
            title: `${row.display_id} · ${row.title}`,
            excerpt: excerptFor(content, normalized),
            location: `work-items/${row.id}/work-item.md`,
            workItemId: row.id,
            content
          }
        })
    ]

    const results = candidates
      .map(({ content, ...candidate }) => ({ ...candidate, relevance: lexicalRelevance(`${candidate.title}\n${content}`, normalized) }))
      .filter((result) => result.relevance > 0)
      .sort(compareRetrievalResults)
      .slice(0, limit)

    return { query: normalized, results, groups: retrievalGroups(results) }
  }

  private appendCompletionKnowledge(source: KnowledgeSourceRow, content: string): void {
    if (source.kind !== 'work_completion') return
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    appendFileSync(path.join(this.store.paths.wikiPath, 'completed-work.md'), `\n\n## ${source.display_name}\n\n${content}\n`, 'utf8')
    appendFileSync(path.join(this.store.paths.knowledgePath, 'log.md'), `\n- Indexed ${source.display_name} (${source.id}).\n`, 'utf8')
  }
}

interface CompletedWorkRow {
  id: string
  display_id: string
  title: string
  description_markdown: string
  acceptance_criteria_markdown: string
  summary_markdown: string | null
  implementation_notes_markdown: string | null
  validation_markdown: string | null
  known_limitations_markdown: string | null
  files_changed_json: string | null
  components_changed_json: string | null
}

interface BacklogWorkRow {
  id: string
  display_id: string
  title: string
  description_markdown: string
  acceptance_criteria_markdown: string
}

interface RetrievalCandidate extends Omit<KnowledgeRetrievalResult, 'relevance'> {
  content: string
}

function toKnowledgeSource(row: KnowledgeSourceRow): KnowledgeSource {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    relativeOrExternalLocation: row.relative_or_external_location,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function safeFilename(filename: string): string {
  return filename.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9._-]/g, '-') || 'source.md'
}

function excerptFor(content: string, query: string): string {
  const firstTerm = query.toLowerCase().split(/\s+/)[0]
  const index = content.toLowerCase().indexOf(firstTerm)
  const start = index < 0 ? 0 : Math.max(0, index - 40)
  return content.slice(start, start + 220).trim()
}

function articleTitle(article: WikiArticle): string {
  const heading = article.content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading ? `Wiki: ${heading}` : `Wiki: ${article.slug}`
}

function completedWorkContent(row: CompletedWorkRow): string {
  return [
    row.title,
    row.description_markdown,
    row.acceptance_criteria_markdown,
    row.summary_markdown ?? '',
    row.implementation_notes_markdown ?? '',
    row.validation_markdown ?? '',
    row.known_limitations_markdown ?? '',
    row.files_changed_json ?? '',
    row.components_changed_json ?? ''
  ].join('\n')
}

function lexicalRelevance(content: string, query: string): number {
  const normalizedContent = content.toLowerCase()
  const normalizedQuery = query.toLowerCase()
  const terms = [...new Set(normalizedQuery.match(/[a-z0-9_-]+/g) ?? [])]
  if (!terms.some((term) => normalizedContent.includes(term))) return 0

  const phraseMatches = countOccurrences(normalizedContent, normalizedQuery)
  const termMatches = terms.reduce((total, term) => total + countOccurrences(normalizedContent, term), 0)
  const title = content.split('\n', 1)[0].toLowerCase()
  const titleMatches = terms.reduce((total, term) => total + countOccurrences(title, term), 0)
  return phraseMatches * 100 + titleMatches * 20 + termMatches
}

function countOccurrences(content: string, term: string): number {
  let count = 0
  let start = 0
  while (true) {
    const index = content.indexOf(term, start)
    if (index === -1) return count
    count += 1
    start = index + term.length
  }
}

function compareRetrievalResults(left: KnowledgeRetrievalResult, right: KnowledgeRetrievalResult): number {
  if (right.relevance !== left.relevance) return right.relevance - left.relevance
  const typeOrder = KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.indexOf(left.sourceType) - KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.indexOf(right.sourceType)
  if (typeOrder !== 0) return typeOrder
  const titleOrder = left.title.localeCompare(right.title, 'en-US')
  if (titleOrder !== 0) return titleOrder
  return left.sourceId.localeCompare(right.sourceId, 'en-US')
}

function retrievalGroups(results: KnowledgeRetrievalResult[]): KnowledgeRetrievalGroup[] {
  const labels: Record<KnowledgeRetrievalSourceType, string> = {
    wiki_article: 'Wiki articles',
    raw_source: 'Raw sources',
    completed_work: 'Completed work',
    backlog: 'Backlog'
  }
  return KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.map((sourceType) => ({
    sourceType,
    label: labels[sourceType],
    results: results.filter((result) => result.sourceType === sourceType)
  }))
}

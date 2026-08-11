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

  private appendCompletionKnowledge(source: KnowledgeSourceRow, content: string): void {
    if (source.kind !== 'work_completion') return
    mkdirSync(this.store.paths.wikiPath, { recursive: true })
    appendFileSync(path.join(this.store.paths.wikiPath, 'completed-work.md'), `\n\n## ${source.display_name}\n\n${content}\n`, 'utf8')
    appendFileSync(path.join(this.store.paths.knowledgePath, 'log.md'), `\n- Indexed ${source.display_name} (${source.id}).\n`, 'utf8')
  }
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
  const index = content.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0])
  return content.slice(Math.max(0, index - 40), index + 180).trim()
}

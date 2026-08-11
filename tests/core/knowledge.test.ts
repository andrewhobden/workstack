import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

const cleanupPaths: string[] = []
afterEach(async () => Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('KnowledgeRepository', () => {
  it('stores raw evidence, preserves a safe source identity, and retrieves relevant excerpts', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-knowledge-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Knowledge' })
    const knowledge = new KnowledgeRepository(store)

    const source = knowledge.addManualSource({
      displayName: 'Architecture notes',
      filename: '../architecture.md',
      content: '# Architecture\n\nWorkstack uses SQLite WAL for atomic agent leases.'
    })

    expect(source).toMatchObject({
      kind: 'manual',
      displayName: 'Architecture notes',
      status: 'indexed',
      relativeOrExternalLocation: expect.stringMatching(/^knowledge\/raw\//)
    })
    expect(knowledge.listSources()).toEqual([source])
    expect(knowledge.search('atomic leases')).toMatchObject([
      {
        sourceId: source.id,
        title: 'Architecture notes',
        excerpt: expect.stringContaining('atomic agent leases')
      }
    ])
    expect(knowledge.search('missing')).toEqual([])
    expect(knowledge.search('   ')).toEqual([])
    expect(
      knowledge.addManualSource({ displayName: 'Fallback source', filename: '///', content: 'Fallback evidence.' })
        .relativeOrExternalLocation
    ).toMatch(/source\.md$/)
    expect(knowledge.processNextJob()).toBeUndefined()
    const now = new Date().toISOString()
    const completionSourceId = 'completion-source'
    const failedSourceId = 'failed-source'
    await mkdir(path.join(store.paths.workItemsPath, 'work-1'), { recursive: true })
    await writeFile(path.join(store.paths.workItemsPath, 'work-1', 'completion.md'), '# Completion\n\nDurable behavior.')
    store.database.prepare(
      "INSERT INTO knowledge_sources (id, kind, display_name, relative_or_external_location, status, created_at, updated_at) VALUES (?, 'work_completion', ?, ?, 'pending', ?, ?)"
    ).run(completionSourceId, 'Completion: KB-1', 'work-items/work-1/completion.md', now, now)
    store.database.prepare(
      "INSERT INTO knowledge_jobs (id, source_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)"
    ).run('job-1', completionSourceId, now, now)
    expect(knowledge.processNextJob()).toMatchObject({ id: completionSourceId, status: 'indexed' })
    await expect(readFile(path.join(store.paths.wikiPath, 'completed-work.md'), 'utf8')).resolves.toContain('Durable behavior.')
    await expect(readFile(path.join(store.paths.knowledgePath, 'log.md'), 'utf8')).resolves.toContain('Completion: KB-1')
    store.database.prepare(
      "INSERT INTO knowledge_jobs (id, source_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)"
    ).run('job-manual', source.id, now, now)
    expect(knowledge.processNextJob()).toMatchObject({ id: source.id, status: 'indexed' })
    store.database.prepare(
      "INSERT INTO knowledge_sources (id, kind, display_name, relative_or_external_location, status, created_at, updated_at) VALUES (?, 'work_completion', ?, ?, 'pending', ?, ?)"
    ).run(failedSourceId, 'Missing completion', 'work-items/missing/completion.md', now, now)
    store.database.prepare(
      "INSERT INTO knowledge_jobs (id, source_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)"
    ).run('job-2', failedSourceId, now, now)
    expect(knowledge.processNextJob()).toMatchObject({ id: failedSourceId, status: 'failed' })
    expect(knowledge.retryFailedJobs()).toBe(1)
    expect(knowledge.retryFailedJobs()).toBe(0)
    expect(knowledge.listWikiArticles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'completed-work' })
    ]))
    expect(knowledge.saveWikiArticle('Architecture', '# Architecture\n\nUser-authored design.')).toEqual({
      slug: 'architecture',
      content: '# Architecture\n\nUser-authored design.'
    })
    expect(knowledge.listWikiArticles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'architecture', content: '# Architecture\n\nUser-authored design.' })
    ]))
    expect(knowledge.search('user-authored')).toMatchObject([{ sourceId: 'wiki:architecture', title: 'Wiki: architecture' }])
    knowledge.saveWikiArticle('lease-design', '# Lease design\n\nAtomic lease recovery is documented here.')
    const workItems = new WorkItemRepository(store)
    const backlog = workItems.create({ title: 'Add atomic lease recovery', descriptionMarkdown: 'Backlog implementation notes.' })
    const completed = workItems.create({ title: 'Verify atomic lease handoff', descriptionMarkdown: 'Completed implementation.' })
    const withoutCompletion = workItems.create({ title: 'Null completion record' })
    store.database.prepare("UPDATE work_items SET status = 'completed', completed_at = ? WHERE id = ?").run(now, completed.id)
    store.database.prepare("UPDATE work_items SET status = 'completed', completed_at = ? WHERE id = ?").run(now, withoutCompletion.id)
    store.database.prepare(
      `INSERT INTO completion_records (
        work_item_id, summary_markdown, implementation_notes_markdown, validation_markdown,
        known_limitations_markdown, created_at
      ) VALUES (?, ?, '', ?, '', ?)`
    ).run(completed.id, 'Atomic lease handoff completed.', 'Validated handoff.', now)

    const retrieval = knowledge.retrieve('atomic lease')
    expect(retrieval.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: 'wiki:lease-design',
        sourceType: 'wiki_article',
        location: 'knowledge/wiki/lease-design.md'
      }),
      expect.objectContaining({
        sourceId: `raw:${source.id}`,
        sourceType: 'raw_source',
        location: source.relativeOrExternalLocation
      }),
      expect.objectContaining({
        sourceId: `completed:${completed.id}`,
        sourceType: 'completed_work',
        workItemId: completed.id,
        location: `work-items/${completed.id}/completion.md`
      }),
      expect.objectContaining({
        sourceId: `backlog:${backlog.id}`,
        sourceType: 'backlog',
        workItemId: backlog.id,
        location: `work-items/${backlog.id}/work-item.md`
      })
    ]))
    expect(retrieval.groups.map((group) => [group.sourceType, group.results.length])).toEqual([
      ['wiki_article', expect.any(Number)],
      ['raw_source', expect.any(Number)],
      ['completed_work', expect.any(Number)],
      ['backlog', expect.any(Number)]
    ])
    expect(knowledge.retrieve('atomic lease')).toEqual(retrieval)
    expect(knowledge.retrieve('missing').results).toEqual([])
    expect(knowledge.retrieve('null completion').results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: `completed:${withoutCompletion.id}` })
    ]))
    expect(knowledge.retrieve('   ')).toMatchObject({ query: '', results: [] })
    knowledge.saveWikiArticle('plain', 'Plain fallback title.')
    expect(knowledge.retrieve('plain').results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'wiki:plain', title: 'Wiki: plain' })
    ]))
    expect(knowledge.retrieve('!!!').results).toEqual([])
    knowledge.addManualSource({ displayName: 'Equal', filename: 'equal.md', content: 'No matching raw body.' })
    knowledge.saveWikiArticle('equal-a', '# Equal')
    knowledge.saveWikiArticle('equal-b', '# Equal')
    knowledge.saveWikiArticle('equal-z', '# Another Equal')
    const equalResultIds = knowledge.retrieve('equal').results.map((result) => result.sourceId)
    expect(equalResultIds).toEqual(expect.arrayContaining([
      'wiki:equal-a',
      'wiki:equal-b',
      'wiki:equal-z',
      expect.stringMatching(/^raw:/)
    ]))
    expect(equalResultIds.indexOf('wiki:equal-a')).toBeLessThan(equalResultIds.findIndex((id) => id.startsWith('raw:')))
    expect(() => knowledge.saveWikiArticle('../unsafe', 'no')).toThrow()
    store.close()
  })
})

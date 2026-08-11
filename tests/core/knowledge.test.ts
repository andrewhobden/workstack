import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { ProjectStore } from '../../src/core/project-store'

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
    expect(() => knowledge.saveWikiArticle('../unsafe', 'no')).toThrow()
    store.close()
  })
})

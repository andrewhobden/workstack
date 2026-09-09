import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { KnowledgeRetrievalService } from '../../src/core/knowledge-retrieval'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { ProjectStore } from '../../src/core/project-store'
import { SemanticIndexRepository } from '../../src/core/semantic-index'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { WorkItemRepository } from '../../src/core/work-items'

const stores: ProjectStore[] = []; const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-retrieval-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Retrieval', workItemPrefix: 'RET' }); stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00Z'))
  return { root, store, clock, retrieval: new KnowledgeRetrievalService(store, clock), catalog: new SourceCatalogRepository(store, { clock }), semantic: new SemanticIndexRepository(store, clock) }
}
const modelPack = { formatVersion: 1, modelId: 'unit-fixture', version: '1', dimensions: 2, vocabulary: { durable: [1, 0], queue: [1, 0], resilient: [1, 0], scheduler: [1, 0], irrelevant: [0, 1] } }

describe('shared retrieval', () => {
  it('preserves canonical passage evidence, exact paths and task IDs, with bounded deterministic groups', async () => {
    const { store, catalog, retrieval } = await fixture()
    const source = catalog.registerSource({ kind: 'repo_file', title: 'Queue API', repositoryPath: 'src/queue-api.ts', canonicalUri: 'repo:src/queue-api.ts' })
    catalog.publishRevision({ sourceId: source.id, original: 'export class QueueApi { /* queue durable */ }' })
    const item = new WorkItemRepository(store).create({ title: 'Unrelated task', descriptionMarkdown: 'queue recovery' })
    const match = retrieval.retrieveLexical('src/queue-api.ts')
    // The repository path is also authoritative searchable metadata, even without matching source text.
    expect(match.results[0]).toMatchObject({ canonicalSourceId: source.id, text: expect.stringContaining('QueueApi'), diagnostics: { exactIdentifier: true }, citation: { sourceId: source.id } })
    expect(retrieval.retrieveLexical(item.displayId).results[0]).toMatchObject({ workItemId: item.id, diagnostics: { exactIdentifier: true } })
    expect(retrieval.retrieveLexical(item.id).results[0].workItemId).toBe(item.id)
    const result = await retrieval.retrieve('queue', { workItemId: item.id })
    expect(result.results.map((candidate) => candidate.sourceType)).toEqual(expect.arrayContaining(['raw_source', 'backlog']))
    expect(result).toEqual(await retrieval.retrieve('queue', { workItemId: item.id }))
    expect(retrieval.retrieveLexical('queue', { limit: 1 })).toMatchObject({ truncated: true, results: [expect.any(Object)] })
    expect(retrieval.retrieveLexical('queue', { sourceTypes: ['raw_source'], limit: 1 }).results).toHaveLength(1)
    expect(retrieval.retrieveLexical('queue', { maxCharacters: 1 })).toMatchObject({ results: [], truncated: true })
    expect(retrieval.retrieveLexical('!!!')).toMatchObject({ results: [], mode: 'lexical' })
    expect(() => retrieval.retrieveLexical('x'.repeat(2001))).toThrow()
    expect(() => retrieval.retrieveLexical('queue', { limit: 101 })).toThrow()
    expect(catalog.readCitation(result.results.find((candidate) => candidate.citation)!.citation!).passage.text).toBe(result.results.find((candidate) => candidate.citation)!.text)
  })

  it('never bypasses source policies through legacy FTS and excludes historical native guidance', async () => {
    const { store, catalog, clock, retrieval } = await fixture()
    const knowledge = new KnowledgeRepository(store)
    const manual = knowledge.addManualSource({ displayName: 'Queue manual', filename: 'queue.md', content: 'Queue guidance.' })
    expect(retrieval.retrieveLexical('Queue').results.some((result) => result.canonicalSourceId === manual.id)).toBe(true)
    catalog.updatePolicy(manual.id, 'paused')
    expect(retrieval.retrieveLexical('Queue').results).toEqual([])
    catalog.updatePolicy(manual.id, 'metadata_only')
    catalog.recordFreshness(manual.id, { metadataOnly: true })
    expect(retrieval.retrieveLexical('Queue').results).toEqual([])
    catalog.updatePolicy(manual.id, 'tracked_content', 60)
    catalog.publishRevision({ sourceId: manual.id, original: 'Queue guidance.' })
    const before = retrieval.corpusRevision()
    clock.advance(61_000)
    expect(retrieval.corpusRevision()).not.toBe(before)
    expect(retrieval.retrieveLexical('Queue').results).toEqual([])
    const records = new KnowledgeRecordsRepository(store)
    const old = records.create({ kind: 'decision', title: 'Queue old', markdown: 'Queue uses old storage.', status: 'accepted' })
    const current = records.create({ kind: 'decision', title: 'Queue current', markdown: 'Queue uses new storage.', status: 'accepted' })
    records.supersede(old.id, current.id, 'reviewer', 'Replacement accepted.')
    const entity = new ProjectDirectoryRepository(store).create({ kind: 'term', displayName: 'Queue glossary', aliases: ['JobQ'], definition: 'Queue meaning.' })
    const results = retrieval.retrieveLexical('Queue').results
    expect(results.map((result) => result.sourceId)).toEqual(expect.arrayContaining([current.id, entity.id]))
    expect(results.map((result) => result.sourceId)).not.toContain(old.id)
    expect(results.find((result) => result.entityId === entity.id)?.provenance).toMatchObject({ revisionId: `${entity.id}@1`, kind: 'entity' })
    expect(retrieval.retrieveLexical('JobQ').results[0].entityId).toBe(entity.id)
    expect(retrieval.retrieveLexical('missing').results).toEqual([])
  })

  it('finds semantic-only passages and reports exact revisions, fallback, cancellation and concurrent changes', async () => {
    const { root, store, catalog, semantic, retrieval } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Background processing', canonicalUri: 'manual:background' })
    catalog.publishRevision({ sourceId: source.id, original: 'Durable queue.' })
    const model = path.join(root, 'vectors.json'); await writeFile(model, JSON.stringify(modelPack))
    expect(await retrieval.retrieve('resilient scheduler')).toMatchObject({ mode: 'lexical', results: [], fallbackReason: expect.stringContaining('No local') })
    await semantic.configure(model)
    expect(await retrieval.retrieve('resilient scheduler')).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('no current passages') })
    expect(await semantic.processNext()).toMatchObject({ status: 'completed' })
    expect(await retrieval.retrieve('queue')).toMatchObject({ mode: 'hybrid', results: [{ canonicalSourceId: source.id, diagnostics: { lexicalRank: 1, semanticRank: 1 } }] })
    const result = await retrieval.retrieve('resilient scheduler')
    expect(result).toMatchObject({ mode: 'hybrid', results: [{ canonicalSourceId: source.id, text: 'Durable queue.', diagnostics: { semanticRank: 1, semanticSimilarity: 1, lexicalRank: undefined } }] })
    const querying = retrieval.retrieve('resilient scheduler')
    expect(await retrieval.retrieve('queue')).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('busy') })
    await querying
    const controller = new AbortController(); controller.abort()
    expect(await retrieval.retrieve('queue', { signal: controller.signal })).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('cancelled') })
    const aborted = new AbortController(); const pending = retrieval.retrieve('queue', { signal: aborted.signal }); aborted.abort()
    expect(await pending).toMatchObject({ mode: 'lexical', results: [{ canonicalSourceId: source.id }], fallbackReason: expect.stringContaining('cancelled') })
    const changing = retrieval.retrieve('queue')
    new WorkItemRepository(store).create({ title: 'Changed corpus queue' })
    expect(await changing).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('changed during retrieval') })
    await writeFile(model, JSON.stringify({ ...modelPack, version: '2' }))
    expect(await retrieval.retrieve('queue')).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('bytes changed') })
    await semantic.configure(model)
    expect(semantic.status().indexedPassages).toBe(0)
    await semantic.processNext()
    catalog.publishRevision({ sourceId: source.id, original: 'Irrelevant.' })
    expect(await retrieval.retrieve('resilient scheduler')).toMatchObject({ mode: 'lexical', results: [], fallbackReason: expect.stringContaining('no current passages') })
    semantic.schedule(); await semantic.processNext()
    expect(await retrieval.retrieve('resilient scheduler')).toMatchObject({ mode: 'hybrid', results: [] })
    semantic.disable()
    expect(await retrieval.retrieve('Irrelevant')).toMatchObject({ mode: 'lexical', results: [{ text: 'Irrelevant.' }] })
  })

  it('retains synthetic provenance for uncatalogued legacy indexes without confusing completed and wiki identities', async () => {
    const { store, retrieval } = await fixture()
    const task = new WorkItemRepository(store).create({ title: 'Legacy queue delivery' })
    const now = new Date().toISOString()
    store.database.prepare("UPDATE work_items SET status = 'completed' WHERE id = ?").run(task.id)
    store.database.prepare("INSERT INTO knowledge_sources(id,kind,display_name,relative_or_external_location,source_work_item_id,status,created_at,updated_at) VALUES ('legacy','work_completion','Legacy completion','work-items/result.md',?,'indexed',?,?)").run(task.id, now, now)
    store.database.prepare("INSERT INTO knowledge_search(source_id,title,content) VALUES ('legacy','Legacy completion','Queue content.'),('wiki:old','Wiki: old','Queue archive.')").run()
    expect(retrieval.retrieveLexical('queue').results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: `completed:${task.id}`, canonicalSourceId: 'legacy', provenance: expect.objectContaining({ kind: 'legacy' }) }),
      expect.objectContaining({ sourceId: 'wiki:old', location: 'knowledge/wiki/old.md', provenance: expect.objectContaining({ kind: 'legacy' }) })
    ]))
    vi.spyOn(SemanticIndexRepository.prototype, 'search').mockRejectedValue('non-error failure')
    expect(await retrieval.retrieve('queue')).toMatchObject({ mode: 'lexical', fallbackReason: 'Local semantic retrieval is unavailable.' })
  })
  it('projects catalogued completion identity and preserves a completion without a task association as raw evidence', async () => {
    const { catalog, store, retrieval } = await fixture()
    const task = new WorkItemRepository(store).create({ title: 'Deliver queue' })
    const source = catalog.registerSource({ kind: 'work_completion', title: 'Queue delivery', canonicalUri: 'completion:delivery', workItemId: task.id })
    catalog.publishRevision({ sourceId: source.id, original: 'Queue is delivered.' })
    const detached = catalog.registerSource({ kind: 'work_completion', title: 'Queue history', canonicalUri: 'completion:detached' })
    catalog.publishRevision({ sourceId: detached.id, original: 'Queue historical notes.' })
    expect(retrieval.retrieveLexical('queue').results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: `completed:${task.id}`, sourceType: 'completed_work', canonicalSourceId: source.id }),
      expect.objectContaining({ sourceId: `raw:${detached.id}`, sourceType: 'raw_source' })
    ]))
  })

  it('publishes updated manual wiki titles and withdraws cleared articles from retrieval', async () => {
    const { store, retrieval, catalog } = await fixture()
    const wiki = new KnowledgeRepository(store)
    wiki.saveWikiArticle('queue', '# Queue v1\nDurable jobs.')
    const previous = retrieval.retrieveLexical('Durable').results[0]
    wiki.saveWikiArticle('queue', '# Queue v2\nDurable new jobs.')
    expect(retrieval.retrieveLexical('Durable').results[0]).toMatchObject({ title: 'Wiki: Queue v2' })
    expect(catalog.getSource('wiki:queue').currentRevisionId).not.toBe(previous.citation?.revisionId)
    wiki.saveWikiArticle('queue', '')
    expect(retrieval.retrieveLexical('Queue').results).toEqual([])
    expect(catalog.getSource('wiki:queue').state).toBe('unavailable')
  })

  it('fails a legacy completion job that lacks the authoritative completion record', async () => {
    const { store } = await fixture()
    const task = new WorkItemRepository(store).create({ title: 'Missing completion' })
    const now = new Date().toISOString()
    store.database.prepare("INSERT INTO knowledge_sources(id,kind,display_name,relative_or_external_location,source_work_item_id,status,created_at,updated_at) VALUES ('missing-completion','work_completion','Missing evidence','work-items/absent.md',?,'pending',?,?)").run(task.id, now, now)
    store.database.prepare("INSERT INTO knowledge_jobs(id,source_id,status,attempts,created_at,updated_at,processor) VALUES ('missing-completion-job','missing-completion','pending',0,?,?,'legacy')").run(now, now)
    expect(new KnowledgeRepository(store).processNextJob()).toMatchObject({ id: 'missing-completion', status: 'failed', errorMessage: expect.stringContaining('completion evidence is missing') })
    expect(store.database.prepare("SELECT source_id FROM knowledge_search WHERE source_id = 'missing-completion'").all()).toEqual([])
  })

})

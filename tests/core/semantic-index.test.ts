import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { SemanticIndexRepository, SEMANTIC_LIMITS } from '../../src/core/semantic-index'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { KnowledgeRetrievalService } from '../../src/core/knowledge-retrieval'

const stores: ProjectStore[] = []; const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const pack = { formatVersion: 1, modelId: 'fixture', version: '1', dimensions: 2, vocabulary: { durable: [1, 0], queue: [1, 0], resilient: [1, 0], scheduler: [1, 0], unrelated: [0, 1] } }
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-semantic-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Semantic' }); stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00Z'))
  const modelPath = path.join(root, 'model.json'); await writeFile(modelPath, JSON.stringify(pack))
  const catalog = new SourceCatalogRepository(store, { clock })
  const source = catalog.registerSource({ kind: 'manual', title: 'Queue', canonicalUri: 'manual:queue' })
  catalog.publishRevision({ sourceId: source.id, original: 'Durable queue.' })
  return { root, store, modelPath, clock, catalog, source, index: new SemanticIndexRepository(store, clock) }
}

describe('optional offline semantic indexing', () => {
  it('validates user-selected model packs and maintains an offline disabled default', async () => {
    const { index, root, modelPath } = await fixture()
    expect(index.status()).toMatchObject({ enabled: false, indexedPassages: 0, eligiblePassages: 1, limits: SEMANTIC_LIMITS })
    expect(index.schedule()).toBe(0)
    expect(await index.processNext()).toBeUndefined()
    expect(() => index.reindex()).toThrow('Select a local model')
    expect(() => index.cancel('missing')).toThrow('does not exist')
    expect(() => index.retry('missing')).toThrow('does not exist')
    await expect(index.configure('relative.json')).rejects.toThrow('absolute')
    await expect(index.configure(path.join(root, 'missing.json'))).rejects.toThrow('ENOENT')
    await expect(index.configure(root)).rejects.toThrow('regular model file')
    const linked = path.join(root, 'linked.json'); await symlink(modelPath, linked)
    await expect(index.configure(linked)).rejects.toThrow('regular model file')
    const invalid = path.join(root, 'invalid.json')
    for (const value of ['not json', JSON.stringify(null), JSON.stringify({ ...pack, formatVersion: 2 }), JSON.stringify({ ...pack, dimensions: 129 }), JSON.stringify({ ...pack, vocabulary: {} }), JSON.stringify({ ...pack, vocabulary: { durable: [1] } }), JSON.stringify({ ...pack, vocabulary: { Durable: [1, 0] } }), JSON.stringify({ ...pack, vocabulary: { durable: [1_000_001, 0] } }), ' '.repeat(SEMANTIC_LIMITS.modelBytes + 1)]) {
      await writeFile(invalid, value)
      await expect(index.configure(invalid)).rejects.toThrow()
    }
    const cancelled = new AbortController(); cancelled.abort()
    await expect(index.configure(modelPath, cancelled.signal)).rejects.toThrow('cancelled')
    expect(index.status().enabled).toBe(false)
  })

  it('persists current model identity and idempotent leased jobs, then indexes bounded batches and resumes retries', async () => {
    const { index, modelPath, catalog, source, store } = await fixture()
    catalog.publishRevision({ sourceId: source.id, original: Array.from({ length: 70 }, (_, n) => `# Block ${n}\nDurable queue ${n}.\n`).join('\n') })
    expect(await index.configure(modelPath)).toMatchObject({ enabled: true, model: { modelId: 'fixture', version: '1', dimensions: 2, vocabularySize: 5 }, jobs: [{ status: 'pending' }] })
    index.schedule(); index.schedule()
    expect(index.jobs.list('semantic')).toHaveLength(1)
    const job = index.jobs.list('semantic')[0]
    expect(index.cancel(job.id).jobs[0]).toMatchObject({ status: 'failed', stage: 'cancelled' })
    expect(index.retry(job.id).jobs[0].status).toBe('pending')
    const processing = index.processNext()
    expect(index.status().busy).toBe(true)
    expect(await index.processNext()).toBeUndefined()
    expect(await processing).toMatchObject({ status: 'completed', attempts: 1 })
    expect(index.status().indexedPassages).toBe(index.status().eligiblePassages)
    expect(index.jobs.list('semantic')[0].payload.offset).toBeGreaterThan(SEMANTIC_LIMITS.batch)
    expect(await index.processNext()).toBeUndefined()
    expect(index.schedule()).toBe(0)
    const row = store.database.prepare('SELECT * FROM semantic_passage_vectors LIMIT 1').get() as Record<string, unknown>
    expect(row).toMatchObject({ model_id: 'fixture', model_version: '1', dimensions: 2, model_hash: index.model()?.hash, input_hash: row.passage_hash })
    expect((await index.search('resilient scheduler')).hits.length).toBeGreaterThan(0)
    const fingerprint = new KnowledgeRetrievalService(store).configFingerprint()
    expect(index.reindex().indexedPassages).toBe(0)
    expect(new KnowledgeRetrievalService(store).configFingerprint()).not.toBe(fingerprint)
    const superseded = index.processNext(); index.reindex()
    expect(await superseded).toBeUndefined()
    const newJob = index.jobs.list('semantic')[0]
    const abort = new AbortController(); const pending = index.processNext(abort.signal); abort.abort()
    expect(await pending).toMatchObject({ status: 'failed', nextAttemptAt: null, errorMessage: expect.stringContaining('cancelled') })
    index.retry(newJob.id)
    const retrying = index.processNext(); index.cancel(newJob.id)
    expect(await retrying).toMatchObject({ status: 'failed', stage: 'cancelled' })
    index.retry(newJob.id)
    const disabling = index.processNext(); index.disable()
    expect(await disabling).toMatchObject({ status: 'failed', stage: 'cancelled' })
    expect(index.status().enabled).toBe(false)
  })

  it('rejects stale source/model/input vectors and safely fails a mid-batch change', async () => {
    const { index, modelPath, catalog, source, store } = await fixture()
    await index.configure(modelPath); await index.processNext()
    store.database.prepare("UPDATE semantic_passage_vectors SET input_hash = 'wrong'").run()
    expect(index.status().indexedPassages).toBe(0)
    index.reindex(); await index.processNext()
    store.database.prepare('UPDATE semantic_passage_vectors SET dimensions = 3').run()
    expect(index.status().indexedPassages).toBe(0)
    index.reindex(); await index.processNext()
    store.database.prepare("UPDATE semantic_passage_vectors SET vector_json = '[100,0]'").run()
    await expect(index.search('queue')).rejects.toThrow('indexed vector is invalid')
    index.reindex()
    const processing = index.processNext()
    catalog.publishRevision({ sourceId: source.id, original: 'Unrelated revision.' })
    expect(await processing).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('model or source changed') })
    index.schedule()
    expect(await index.processNext()).toMatchObject({ status: 'completed' })
    expect((await index.search('resilient scheduler')).hits).toEqual([])
    const currentJob = index.jobs.list('semantic').find((job) => job.status === 'completed')!
    index.reindex()
    store.database.prepare("UPDATE knowledge_jobs SET payload_json = json_set(payload_json, '$.modelHash', 'another-model') WHERE processor = 'semantic'").run()
    expect(await index.processNext()).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('selected model changed') })
    expect(() => index.retry(currentJob.id)).toThrow('does not exist')
    index.reindex()
    catalog.updatePolicy(source.id, 'paused')
    expect(await index.processNext()).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('no longer eligible') })
    expect(index.status().indexedPassages).toBe(0)
  })

  it('recovers expired leases and persisted offsets without a competing worker committing stale output', async () => {
    const { index, modelPath, clock, store } = await fixture()
    await index.configure(modelPath)
    const processing = index.processNext(); clock.advance(121_000)
    expect(await processing).toMatchObject({ status: 'running' })
    expect(await index.processNext()).toMatchObject({ status: 'completed', attempts: 2 })
    index.reindex()
    store.database.prepare("UPDATE knowledge_jobs SET payload_json = json_set(payload_json, '$.offset', -1) WHERE processor = 'semantic'").run()
    expect(await index.processNext()).toMatchObject({ status: 'failed', errorMessage: expect.any(String) })
    index.disable()
  })

  it('caps semantic search independently from lexical evidence and reports corpus truncation', async () => {
    const { index, modelPath, store } = await fixture()
    await index.configure(modelPath); await index.processNext()
    const row = store.database.prepare('SELECT * FROM source_passages LIMIT 1').get() as Record<string, unknown>
    store.database.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
      INSERT INTO source_passages SELECT ?||':copy:'||x,source_id,revision_id,x,heading_json,start_line,end_line,start_offset,end_offset,text,passage_hash,structure_json FROM source_passages,n WHERE id=?`).run(row.id, row.id)
    store.database.prepare(`INSERT INTO semantic_passage_vectors SELECT p.id,p.source_id,p.revision_id,p.passage_hash,p.passage_hash,v.model_id,v.model_version,v.model_hash,v.dimensions,v.vector_json,v.created_at FROM source_passages p CROSS JOIN (SELECT * FROM semantic_passage_vectors LIMIT 1) v WHERE p.id!=v.passage_id`).run()
    expect(index.status()).toMatchObject({ indexedPassages: 5000, eligiblePassages: 5001, truncated: true })
    expect(await index.search('resilient scheduler')).toMatchObject({ truncated: true, hits: expect.any(Array) })
    expect((await index.search('resilient scheduler')).hits).toHaveLength(100)
    const retrieval = await new KnowledgeRetrievalService(store).retrieve('resilient scheduler')
    expect(retrieval).toMatchObject({ mode: 'hybrid', truncated: true })
    expect(retrieval.results).toHaveLength(1)
  })
})

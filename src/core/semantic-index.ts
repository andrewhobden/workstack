import { RETRIEVAL_POLICY } from './knowledge-retrieval-contracts'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { KnowledgeJobsRepository, type KnowledgeIntakeJob } from './knowledge-jobs'
import type { ProjectStore } from './project-store'
import { SourceCatalogRepository } from './source-catalog'

import { SEMANTIC_LIMITS, type SemanticModel, type SemanticStatus } from './semantic-index-contracts'
export { SEMANTIC_LIMITS } from './semantic-index-contracts'
export type { SemanticModel, SemanticStatus } from './semantic-index-contracts'
interface ModelRow { enabled: number; path: string; model_id: string; model_version: string; model_hash: string; dimensions: number; vocabulary_size: number }
interface PassageInput { id: string; source_id: string; revision_id: string; passage_hash: string; text: string }
interface SemanticHit { passageId: string; similarity: number }
interface WorkerResult { model: SemanticModel; vectors?: number[][]; hits?: SemanticHit[] }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const eligible = "s.state = 'ready' AND s.deleted_at IS NULL AND s.policy NOT IN ('paused','metadata_only') AND p.revision_id = s.current_revision_id AND (s.policy = 'import_once' OR s.next_refresh_at IS NULL OR s.next_refresh_at > ?)"
let active: { projectId: string; cancel: () => void } | undefined

// Constant program only: local model bytes are parsed as JSON, never evaluated. All tokenization,
// model loading, embedding and cosine search take place on the resource-limited worker.
const workerProgram = String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
try {
  const { modelPath, expectedHash, operation, texts, query, entries, limits, minimumSimilarity } = workerData;
  const stat = fs.lstatSync(modelPath);
  if (!stat.isFile() || stat.size > limits.modelBytes) throw new Error('Select a regular model file no larger than 8 MiB.');
  const fd = fs.openSync(modelPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const buffer = Buffer.alloc(limits.modelBytes + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > limits.modelBytes) throw new Error('The model exceeds 8 MiB.');
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && expectedHash !== digest) throw new Error('Local model bytes changed. Select the model again to rebuild its index.');
  const pack = JSON.parse(bytes.toString('utf8'));
  if (pack.formatVersion !== 1 || typeof pack.modelId !== 'string' || !pack.modelId.trim() || pack.modelId.length > 200 || typeof pack.version !== 'string' || !pack.version.trim() || pack.version.length > 100 || !Number.isInteger(pack.dimensions) || pack.dimensions < 1 || pack.dimensions > limits.dimensions || !pack.vocabulary || typeof pack.vocabulary !== 'object' || Array.isArray(pack.vocabulary)) throw new Error('Invalid local word-vector pack metadata.');
  const words = Object.keys(pack.vocabulary);
  if (!words.length || words.length > limits.vocabulary) throw new Error('The model must contain 1–10,000 vocabulary entries.');
  for (const token of words) {
    const vector = pack.vocabulary[token];
    if (!/^[\p{L}\p{N}_-]{1,100}$/u.test(token) || token !== token.toLocaleLowerCase('en-US') || !Array.isArray(vector) || vector.length !== pack.dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000)) throw new Error('Invalid model token or vector.');
  }
  const normalize = vector => { const norm = Math.hypot(...vector); return norm ? vector.map(value => value / norm) : vector; };
  const embed = text => {
    const vector = Array(pack.dimensions).fill(0);
    for (const token of (text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) || []).slice(0, 4096)) {
      if (!Object.hasOwn(pack.vocabulary, token)) continue;
      pack.vocabulary[token].forEach((value, index) => { vector[index] += value; });
    }
    return normalize(vector);
  };
  const model = { path: modelPath, modelId: pack.modelId, version: pack.version, hash: digest, dimensions: pack.dimensions, vocabularySize: words.length };
  const result = { model };
  if (operation === 'embed') {
    if (!Array.isArray(texts) || texts.length > limits.batch || texts.some(text => typeof text !== 'string' || text.length > 5000)) throw new Error('Embedding batch exceeds its resource budget.');
    result.vectors = texts.map(embed);
  }
  if (operation === 'search') {
    if (typeof query !== 'string' || query.length > 2000 || !Array.isArray(entries) || entries.length > limits.passages) throw new Error('Semantic query exceeds its resource budget.');
    const queryVector = embed(query);
    result.hits = entries.map(entry => {
      const vector = JSON.parse(entry.vector);
      if (!Array.isArray(vector) || vector.length !== pack.dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1.000001)) throw new Error('An indexed vector is invalid. Rebuild the local index.');
      return { passageId: entry.id, similarity: vector.reduce((sum, value, index) => sum + value * queryVector[index], 0) };
    }).filter(hit => hit.similarity > minimumSimilarity).sort((a,b) => b.similarity - a.similarity || a.passageId.localeCompare(b.passageId)).slice(0,100);
  }
  parentPort.postMessage({ value: result });
} catch (error) { parentPort.postMessage({ error: error.message }); }
`

function runWorker(projectId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerResult> {
  if (signal?.aborted) return Promise.reject(new Error('Local semantic work was cancelled.'))
  if (active) return Promise.reject(new Error('The local semantic worker is busy.'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerProgram, { eval: true, workerData: { ...input, limits: SEMANTIC_LIMITS, minimumSimilarity: RETRIEVAL_POLICY.semanticMinimumSimilarity }, resourceLimits: { maxOldGenerationSizeMb: SEMANTIC_LIMITS.workerMemoryMiB, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    let finished = false
    const finish = (error: Error | undefined, value?: WorkerResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      void worker.terminate().then(() => {
        active = undefined
        if (error) reject(error)
        else resolve(value!)
      })
    }
    const cancel = (): void => finish(new Error('Local semantic work was cancelled.'))
    const timer = setTimeout(() => finish(new Error('Local semantic work exceeded its 3-second time budget.')), SEMANTIC_LIMITS.workerMilliseconds)
    active = { projectId, cancel }
    signal?.addEventListener('abort', cancel, { once: true })
    worker.once('message', (message: { error?: string; value?: WorkerResult }) => finish(message.error ? new Error(message.error) : undefined, message.value))
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (code !== 0) finish(new Error('The local semantic worker stopped before completing.')) })
  })
}

/** Offline, opt-in mean-pooled word vectors. This deliberately does not download or call a model. */
export class SemanticIndexRepository {
  readonly jobs: KnowledgeJobsRepository
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) { this.jobs = new KnowledgeJobsRepository(store, { clock }) }

  model(): SemanticModel | undefined {
    const row = this.store.database.prepare('SELECT * FROM semantic_model_settings WHERE id = 1').get() as ModelRow
    return row.enabled ? { path: row.path, modelId: row.model_id, version: row.model_version, hash: row.model_hash, dimensions: row.dimensions, vocabularySize: row.vocabulary_size } : undefined
  }

  status(): SemanticStatus {
    new SourceCatalogRepository(this.store, { clock: this.clock }).refreshDependencies()
    const model = this.model()
    const eligibleCount = this.store.database.prepare(`SELECT count(*) AS count FROM source_passages p JOIN source_catalog s ON s.id = p.source_id WHERE ${eligible}`).get(this.now()) as { count: number }
    return { enabled: !!model, model, indexedPassages: model ? this.currentVectors(model).length : 0, eligiblePassages: eligibleCount.count, truncated: eligibleCount.count > SEMANTIC_LIMITS.passages, busy: active?.projectId === this.store.project.id, jobs: this.jobs.list('semantic'), limits: SEMANTIC_LIMITS }
  }

  async configure(modelPath: string, signal?: AbortSignal): Promise<SemanticStatus> {
    const parsed = z.string().min(1).max(4000).refine(path.isAbsolute, 'Choose an absolute local model path.').parse(modelPath)
    const { model } = await runWorker(this.store.project.id, { operation: 'inspect', modelPath: parsed }, signal)
    this.store.database.transaction(() => {
      this.store.database.prepare('UPDATE semantic_model_settings SET enabled = 1, path = ?, model_id = ?, model_version = ?, model_hash = ?, dimensions = ?, vocabulary_size = ?, configured_at = ? WHERE id = 1')
        .run(model.path, model.modelId, model.version, model.hash, model.dimensions, model.vocabularySize, this.now())
      this.store.database.prepare('DELETE FROM semantic_passage_vectors WHERE model_hash != ?').run(model.hash)
      this.schedule()
    }).immediate()
    return this.status()
  }

  disable(): SemanticStatus {
    if (active?.projectId === this.store.project.id) active.cancel()
    this.store.database.prepare('UPDATE semantic_model_settings SET enabled = 0 WHERE id = 1').run()
    for (const job of this.jobs.list('semantic')) if (job.status === 'pending' || job.status === 'running') this.jobs.cancel(job.id)
    return this.status()
  }

  schedule(): number {
    const model = this.model()
    if (!model) return 0
    const rows = this.eligiblePassages()
    let scheduled = 0
    const bySource = new Map<string, PassageInput[]>()
    for (const row of rows) { const passages = bySource.get(row.source_id) ?? []; passages.push(row); bySource.set(row.source_id, passages) }
    for (const [sourceId, passages] of bySource) {
      const key = `semantic:${model.hash}:${passages[0].revision_id}`
      const job = this.jobs.enqueue(sourceId, key, { processor: 'semantic', stage: 'embed', payload: { modelHash: model.hash, revisionId: passages[0].revision_id, offset: 0 } })
      if (job.status === 'pending') scheduled += 1
    }
    return scheduled
  }

  reindex(): SemanticStatus {
    if (!this.model()) throw new WorkstackError('INVALID_STATE_TRANSITION', 'Select a local model before rebuilding its index.')
    if (active?.projectId === this.store.project.id) active.cancel()
    this.store.database.transaction(() => {
      this.store.database.prepare("DELETE FROM knowledge_jobs WHERE processor = 'semantic'").run()
      this.store.database.prepare('DELETE FROM semantic_passage_vectors').run()
      this.schedule()
    }).immediate()
    return this.status()
  }

  cancel(jobId: string): SemanticStatus {
    this.assertSemanticJob(jobId)
    if (active?.projectId === this.store.project.id) active.cancel()
    this.jobs.cancel(jobId)
    return this.status()
  }

  retry(jobId: string): SemanticStatus { this.assertSemanticJob(jobId); this.jobs.retry(jobId); return this.status() }

  async processNext(signal?: AbortSignal): Promise<KnowledgeIntakeJob | undefined> {
    const model = this.model()
    if (!model || active) return undefined
    const claimed = this.jobs.claimNext('semantic')
    if (!claimed) return undefined
    const { job, owner } = claimed
    try {
      if (job.payload.modelHash !== model.hash) throw new Error('The selected model changed; rebuild the index.')
      const inputs = this.eligiblePassages().filter((row) => row.source_id === job.sourceId && row.revision_id === job.payload.revisionId)
      if (!inputs.length) throw new Error('The source revision is no longer eligible for semantic indexing.')
      const offset = z.number().int().min(0).max(SEMANTIC_LIMITS.passages).parse(job.payload.offset)
      for (let start = offset; start < inputs.length; start += SEMANTIC_LIMITS.batch) {
        this.jobs.heartbeat(job.id, owner)
        const batch = inputs.slice(start, start + SEMANTIC_LIMITS.batch)
        const result = await runWorker(this.store.project.id, { operation: 'embed', modelPath: model.path, expectedHash: model.hash, texts: batch.map((row) => row.text) }, signal)
        this.store.database.transaction(() => {
          this.jobs.assertOwner(job.id, owner)
          if (this.model()?.hash !== model.hash || !this.eligiblePassages().some((row) => row.id === batch[0].id)) throw new Error('The model or source changed while embedding.')
          batch.forEach((row, index) => this.store.database.prepare(`INSERT OR REPLACE INTO semantic_passage_vectors(passage_id,source_id,revision_id,passage_hash,input_hash,model_id,model_version,model_hash,dimensions,vector_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(row.id, row.source_id, row.revision_id, row.passage_hash, sha(row.text), model.modelId, model.version, model.hash, model.dimensions, JSON.stringify(result.vectors![index]), this.now()))
          this.jobs.advance(job.id, owner, 'embed', { ...job.payload, offset: start + batch.length })
        }).immediate()
      }
      this.jobs.complete(job.id, owner)
    } catch (error) {
      const current = this.jobs.list('semantic').find((candidate) => candidate.id === job.id)
      if (current?.status === 'running' && current.owner === owner && current.leaseExpiresAt! > this.now()) this.jobs.fail(job.id, owner, error, { retryable: !signal?.aborted })
    }
    return this.jobs.list('semantic').find((candidate) => candidate.id === job.id)
  }

  async search(query: string, signal?: AbortSignal): Promise<{ hits: SemanticHit[]; truncated: boolean; fallbackReason?: string }> {
    const model = this.model()
    if (!model) return { hits: [], truncated: false, fallbackReason: 'No local semantic model is enabled.' }
    const entries = this.currentVectors(model)
    if (!entries.length) return { hits: [], truncated: false, fallbackReason: 'The local semantic index has no current passages. Index selected sources first.' }
    const result = await runWorker(this.store.project.id, { operation: 'search', modelPath: model.path, expectedHash: model.hash, query, entries }, signal)
    const current = new Set(this.currentVectors(model).map((entry) => entry.id))
    return { hits: result.hits!.filter((hit) => current.has(hit.passageId)), truncated: this.status().truncated }
  }

  private currentVectors(model: SemanticModel): Array<{ id: string; vector: string }> {
    const catalog = new SourceCatalogRepository(this.store, { clock: this.clock })
    return (this.store.database.prepare(`SELECT p.id,p.source_id,v.vector_json AS vector FROM source_passages p JOIN source_catalog s ON s.id = p.source_id JOIN semantic_passage_vectors v ON v.passage_id = p.id
      WHERE ${eligible} AND v.model_hash = ? AND v.model_id = ? AND v.model_version = ? AND v.dimensions = ? AND v.passage_hash = p.passage_hash AND v.input_hash = p.passage_hash AND v.source_id = p.source_id AND v.revision_id = p.revision_id AND length(v.vector_json) <= ? ORDER BY p.source_id,p.ordinal LIMIT ?`)
      .all(this.now(), model.hash, model.modelId, model.version, model.dimensions, SEMANTIC_LIMITS.vectorCharacters, SEMANTIC_LIMITS.passages) as Array<{ id: string; source_id: string; vector: string }>).filter((row) => catalog.getSource(row.source_id).state === 'ready')
  }
  private eligiblePassages(): PassageInput[] {
    new SourceCatalogRepository(this.store, { clock: this.clock }).refreshDependencies()
    return this.store.database.prepare(`SELECT p.id,p.source_id,p.revision_id,p.passage_hash,p.text FROM source_passages p JOIN source_catalog s ON s.id = p.source_id WHERE ${eligible} ORDER BY p.source_id,p.ordinal LIMIT ?`).all(this.now(), SEMANTIC_LIMITS.passages) as PassageInput[]
  }
  private assertSemanticJob(id: string): void { if (!this.jobs.list('semantic').some((job) => job.id === id)) throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The semantic indexing job does not exist.') }
  private now(): string { return this.clock.now().toISOString() }
}

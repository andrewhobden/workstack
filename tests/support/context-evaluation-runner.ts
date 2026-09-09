import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository, type SourcePassage, type ProjectSource } from '../../src/core/source-catalog'
import { KnowledgeRetrievalService } from '../../src/core/knowledge-retrieval'
import { SemanticIndexRepository } from '../../src/core/semantic-index'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { EvidenceGraphRepository } from '../../src/core/evidence-graph'
import { graphNodeId } from '../../src/core/evidence-graph-contracts'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
import { ContextPacketRepository } from '../../src/core/context-packets'
import { FrozenClock } from '../../src/core/clock'
import { mean, percentile, scoreContextEvaluation, type ContextEvaluationCase, type ContextEvaluationCorpus, type ContextEvaluationHit, type ContextEvaluationReport, type ContextEvaluationSample } from '../../src/core/context-evaluation'
import type { ContextPacket, ContextPolicy } from '../../src/core/context-packet-contracts'

type FixtureDocument = { key: string; text: string; source: ProjectSource }
export async function runContextEvaluation(options: { corpusPath?: string; iterations?: number; modelPath?: string; semanticBudgetMs?: number } = {}): Promise<ContextEvaluationReport> {
  const corpusText = await readFile(options.corpusPath ?? path.join(process.cwd(), 'tests/fixtures/context-evaluation/corpus.v1.json'), 'utf8')
  const corpus = JSON.parse(corpusText) as ContextEvaluationCorpus
  if (corpus.schemaVersion !== 1 || !corpus.sources.length || !corpus.cases.length || corpus.largeCorpusDocuments < 500 || corpus.largeCorpusDocuments > 5000) throw new Error('Unsupported or incomplete evaluation corpus.')
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-context-evaluation-'))
  let store: ProjectStore | undefined
  let foreign: ProjectStore | undefined
  const iterations = Math.max(1, Math.min(20, options.iterations ?? 3))
  try {
    store = await ProjectStore.initialize({ rootPath: path.join(root, 'project'), name: 'Orchard evaluation', description: 'Durable local coding tasks.' })
    foreign = await ProjectStore.initialize({ rootPath: path.join(root, 'foreign'), name: 'Foreign isolated project' })
    const clock = new FrozenClock(new Date('2026-09-09T00:00:00.000Z'))
    const catalog = new SourceCatalogRepository(store, { clock })
    const records = new KnowledgeRecordsRepository(store, { clock })
    const directory = new ProjectDirectoryRepository(store, { clock })
    const documents = new Map<string, FixtureDocument>()
    const sourceKeys = new Map<string, string>()
    const indexStart = performance.now()
    for (const input of corpus.sources) {
      const text = input.generatedPrefixParagraphs ? `# Long specification\n${'Ordinary background paragraph about release coordination.\n\n'.repeat(input.generatedPrefixParagraphs)}${input.text}` : input.text
      if (input.path) { await mkdir(path.dirname(path.join(store.project.rootPath, input.path)), { recursive: true }); await writeFile(path.join(store.project.rootPath, input.path), text) }
      const source = catalog.registerSource({ id: `eval:${input.key}`, kind: input.path ? 'repo_file' : 'manual', title: input.title, canonicalUri: `evaluation://${store.project.id}/${input.key}`, repositoryPath: input.path })
      catalog.publishRevision({ sourceId: source.id, original: text, upstreamRevision: `${corpus.revision}:${input.key}` })
      if (input.state === 'stale') catalog.recordFreshness(source.id, { metadataOnly: true, upstreamRevision: 'changed-upstream' })
      if (input.state === 'unavailable') catalog.recordFreshness(source.id, { unavailable: true, reason: 'Offline fixture: upstream access is unavailable.' })
      documents.set(input.key, { key: input.key, text, source: catalog.getSource(source.id) }); sourceKeys.set(source.id, input.key)
    }
    for (let index = 0; index < corpus.largeCorpusDocuments; index += 1) {
      const source = catalog.registerSource({ id: `eval:filler-${index}`, kind: 'manual', title: `Module ${index}`, canonicalUri: `evaluation://${store.project.id}/filler-${index}` })
      const text = `# Module ${index}\nModuleIdentifier_${index} describes routine module behavior and unrelated fixture details.\n${'Background documentation for this independent module. '.repeat(8)}`
      catalog.publishRevision({ sourceId: source.id, original: text })
      documents.set(`filler-${index}`, { key: `filler-${index}`, text, source: catalog.getSource(source.id) }); sourceKeys.set(source.id, `filler-${index}`)
    }
    const foreignCatalog = new SourceCatalogRepository(foreign, { clock })
    const foreignSource = foreignCatalog.registerSource({ id: 'eval:foreign-only', kind: 'manual', title: 'Foreign project secret context', canonicalUri: 'evaluation://foreign/sentinel' })
    foreignCatalog.publishRevision({ sourceId: foreignSource.id, original: 'ForeignProjectSentinel_8842 must never cross project boundaries.' })
    const architecture = firstPassage(catalog, store, documents.get('architecture')!.source.id)
    directory.create({ kind: 'component', displayName: 'QueueService', aliases: ['QS'], definition: 'Durable job queue.', references: [{ kind: 'source', citation: architecture.citation }] })
    const old = records.create({ kind: 'decision', title: 'Queue memory', status: 'accepted', markdown: 'Historical process-memory queue.', references: [{ kind: 'source', citation: firstPassage(catalog, store, documents.get('old-design')!.source.id).citation }] })
    const current = records.create({ kind: 'decision', title: 'Durable queue', status: 'accepted', markdown: 'Persist RetryQueue ownership in SQLite.', references: [{ kind: 'source', citation: firstPassage(catalog, store, documents.get('current-design')!.source.id).citation }] })
    records.supersede(old.id, current.id, 'fixture-author', 'Current fixture decision replaces historical guidance.')
    store.database.pragma('wal_checkpoint(FULL)')
    const buildMs = performance.now() - indexStart
    let semanticModel: ContextEvaluationReport['semanticModel']
    if (options.modelPath) {
      const budgetMs = Math.max(1000, Math.min(120_000, options.semanticBudgetMs ?? 60_000))
      const index = new SemanticIndexRepository(store, clock)
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), budgetMs)
      const semanticStart = performance.now()
      try {
        await index.configure(options.modelPath, abort.signal)
        while (!abort.signal.aborted && await index.processNext(abort.signal)) { /* Durable bounded batches are produced by the real local indexer. */ }
      } finally { clearTimeout(timeout) }
      const status = index.status()
      if (status.model) semanticModel = { modelId: status.model.modelId, version: status.model.version, hash: status.model.hash, dimensions: status.model.dimensions, indexedPassages: status.indexedPassages, eligiblePassages: status.eligiblePassages, buildMs: performance.now() - semanticStart, budgetMs, complete: status.indexedPassages === status.eligiblePassages }
    }
    store.database.pragma('wal_checkpoint(FULL)')
    const databaseBytes = (await stat(store.paths.databasePath)).size
    await writeFile(path.join(store.project.rootPath, '.gitignore'), '.workstack/\n.workstack-*\n')
    execFileSync('git', ['init', '-q', store.project.rootPath])
    execFileSync('git', ['-C', store.project.rootPath, 'add', '.gitignore', 'src'])
    execFileSync('git', ['-C', store.project.rootPath, '-c', 'user.name=Context evaluation', '-c', 'user.email=context-evaluation@example.invalid', 'commit', '-qm', 'Independent evaluation fixture'])
    const samples: ContextEvaluationSample[] = []
    const tasks = new WorkItemRepository(store, { clock })
    const packets = new ContextPacketRepository(store, { clock })
    for (const test of corpus.cases) {
      const task = tasks.create({ title: test.task, descriptionMarkdown: test.query, acceptanceCriteriaMarkdown: 'Use the stated current project evidence. Preserve mandatory context and exact citations.' })
      if (test.checkpoint) {
        const claims = new ClaimsRepository(store, { clock })
        const claim = claims.claim(task.id, { agentId: 'interrupted-fixture-agent' })
        claims.saveCheckpoint(task.id, claim.claimToken, { progressMarkdown: 'Completed the queue storage migration.', filesChanged: ['src/lease.ts'], validationMarkdown: 'Ownership tests pass.', nextActionsMarkdown: 'Resume checkpoint reconciliation.', questionsMarkdown: 'Confirm retry policy.' })
        claims.release(task.id, claim.claimToken, 'Interrupted fixture work retained for restart.')
      }
      const policy = packets.getPolicy()
      const pins: ContextPolicy['sourcePins'] = test.mandatoryCategories.flatMap((category) => {
        if (['task', 'repository', 'checkpoint'].includes(category)) return []
        const key = category === 'purpose' && test.offlinePin ? 'offline' : category === 'decisions' ? 'current-design' : category === 'code' ? 'large-target' : category
        const document = documents.get(key)
        return document ? [{ sourceId: document.source.id, category }] : []
      })
      packets.updatePolicy({ expectedVersion: policy.version, requirements: test.mandatoryCategories.map((category) => ({ category, severity: 'hard' })), sourcePins: pins, requiredRecordIds: test.tags.includes('supersession') ? [current.id] : [], allowSoftOverride: false, tokenBudget: 32000, operatorInstructions: '' })
      samples.push(await timed(test, 'legacy_document_reference', iterations, () => {
        const ranked = [...documents.values()].map((document) => ({ document, score: legacyRelevance(`${document.source.title}\n${document.text}`, test.query) })).filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.document.source.title.localeCompare(b.document.source.title, 'en-US')).slice(0, 10)
        return { hits: ranked.map(({ document }) => ({ sourceKey: document.key, citationValid: false, historical: document.source.state === 'stale', excluded: document.source.state === 'unavailable', foreign: false })), tokenEstimate: ranked.reduce((sum, entry) => sum + Buffer.byteLength(entry.document.text.slice(0, 220)), 0) }
      }))
      samples.push(await timed(test, 'passage_lexical', iterations, () => {
        const hits = catalog.search(test.query, { limit: 10, maxChars: 24_000 })
        return { hits: hits.map((hit) => verifyHit(catalog, sourceKeys, hit)), tokenEstimate: hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.text), 0) }
      }))
      samples.push(await timed(test, 'unified_lexical', iterations, () => {
        const result = new KnowledgeRetrievalService(store!, clock).retrieveLexical(test.query, { limit: 10 })
        const hits = result.results.flatMap((hit) => hit.citation ? [verifyHit(catalog, sourceKeys, catalog.readCitation(hit.citation).passage)] : [])
        return { hits, tokenEstimate: result.results.reduce((sum, hit) => sum + Buffer.byteLength(hit.text ?? hit.excerpt), 0), supersededCurrentRecords: result.results.filter((hit) => hit.recordId && records.get(hit.recordId).status === 'superseded').length }
      }))
      samples.push(await timed(test, 'graph_neighborhood', iterations, () => {
        const passages = new Map(catalog.search(test.query, { limit: 10 }).map((passage) => [passage.citation.sourceId, passage]))
        const entityIds = new Set([test.query, ...test.query.split(/\s+/)].flatMap((term) => { const result = directory.lookup(term, { suggestions: false }); return result.match === 'exact' ? result.candidates.map((entry) => entry.id) : [] }))
        for (const id of entityIds) {
          const entity = directory.get(id)
          const graph = new EvidenceGraphRepository(store!).query({ nodeId: graphNodeId(entity.kind, id), depth: 2, maxNodes: 30, maxEdges: 50 })
          for (const node of graph.nodes) if (node.type === 'source' && sourceKeys.has(node.reference)) {
            const source = catalog.getSource(node.reference)
            if (source.state === 'ready' && !source.deletedAt) passages.set(source.id, firstPassage(catalog, store!, source.id))
          }
        }
        const hits = [...passages.values()].slice(0, 10)
        return { hits: hits.map((hit) => verifyHit(catalog, sourceKeys, hit)), tokenEstimate: hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.text), 0) }
      }))
      if (semanticModel?.indexedPassages) samples.push(await timed(test, 'hybrid_local_model', iterations, async () => {
        const result = await new KnowledgeRetrievalService(store!, clock).retrieve(test.query, { limit: 10 })
        if (result.mode !== 'hybrid') throw new Error(`Configured model evaluation fell back to lexical: ${result.fallbackReason}`)
        return { hits: result.results.flatMap((hit) => hit.citation ? [verifyHit(catalog, sourceKeys, catalog.readCitation(hit.citation).passage)] : []), tokenEstimate: result.results.reduce((sum, hit) => sum + Buffer.byteLength(hit.text ?? hit.excerpt), 0), supersededCurrentRecords: result.results.filter((hit) => hit.recordId && records.get(hit.recordId).status === 'superseded').length }
      }))
      else samples.push({ caseId: test.id, stage: 'hybrid_local_model', status: 'unavailable', unavailableReason: options.modelPath ? 'The selected local model produced no current indexed passages within its budget.' : 'No reviewed semantic model asset is bundled with the offline corpus. Run an explicitly configured local model evaluation separately.', hits: [], tokenEstimate: 0, latencyMs: [] })
      samples.push(await timed(test, 'context_packet', iterations, async () => {
        const packet = semanticModel?.indexedPassages ? await packets.preview(task.id) : packets.prepareLexical(task.id)
        return packetSample(packet, catalog, sourceKeys)
      }))
    }
    const scores = samples.map((sample) => scoreContextEvaluation(corpus.cases.find((test) => test.id === sample.caseId)!, sample))
    const comparisons = scores.filter((score) => score.stage !== 'legacy_document_reference' && score.status === 'available').map((score) => {
      const baseline = scores.find((candidate) => candidate.caseId === score.caseId && candidate.stage === 'legacy_document_reference')!
      const recallDelta = score.recallAt10 !== null && baseline.recallAt10 !== null ? score.recallAt10 - baseline.recallAt10 : null
      return { caseId: score.caseId, stage: score.stage, baseline: baseline.stage, recallDelta, mandatoryCoverageDelta: null,
        regressions: [...(recallDelta !== null && recallDelta < 0 ? ['recall@10 regressed from document lexical reference'] : []), ...score.violations] }
    })
    const violations = scores.filter((score) => score.stage !== 'legacy_document_reference' && score.status === 'available').flatMap((score) => score.violations.map((violation) => `${score.caseId}/${score.stage}: ${violation}`))
    const stages = [...new Set(scores.map((score) => score.stage))]
    const sqlite = (store.database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
    let gitRevision: string | null = null
    let gitWorkingTreeDirty: boolean | null = null
    try { gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* Report an unavailable checkout revision explicitly. */ }
    try { gitWorkingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { /* Unavailable status remains null. */ }
    return { schemaVersion: 1, corpusRevision: corpus.revision, corpusHash: createHash('sha256').update(corpusText).digest('hex'), corpusReview: corpus.review, generatedAt: new Date().toISOString(), tokenEstimator: 'utf8_bytes_upper_bound', observations: samples, semanticModel,
      environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', sqlite, gitRevision, gitWorkingTreeDirty },
      index: { sources: catalog.listSources().length, passages: (store.database.prepare('SELECT COUNT(*) AS count FROM source_passages').get() as { count: number }).count, sourceCharacters: [...documents.values()].reduce((sum, document) => sum + document.text.length, 0), databaseBytes, buildMs, providerCalls: 0, providerTokens: 0, estimatedProviderCostUsd: 0 },
      scores, comparisons, gates: { passed: !violations.length, violations }, summary: stages.map((stage) => ({ stage, meanRecallAt10: mean(scores.filter((score) => score.stage === stage).map((score) => score.recallAt10)), meanReciprocalRank: mean(scores.filter((score) => score.stage === stage).map((score) => score.reciprocalRank)), meanEvidenceCoverage: mean(scores.filter((score) => score.stage === stage).map((score) => score.evidenceCoverage)), p50Ms: percentile(samples.filter((sample) => sample.stage === stage).flatMap((sample) => sample.latencyMs), 0.5), p95Ms: percentile(samples.filter((sample) => sample.stage === stage).flatMap((sample) => sample.latencyMs), 0.95), tokens: scores.filter((score) => score.stage === stage).reduce((sum, score) => sum + score.tokens, 0) })) }
  } finally {
    store?.close(); foreign?.close()
    await rm(root, { recursive: true, force: true })
  }
}

function firstPassage(catalog: SourceCatalogRepository, store: ProjectStore, sourceId: string): SourcePassage {
  const source = catalog.getSource(sourceId)
  const row = store.database.prepare('SELECT id FROM source_passages WHERE source_id=? AND revision_id=? ORDER BY ordinal LIMIT 1').get(sourceId, source.currentRevisionId) as { id: string }
  return catalog.getPassage(row.id)
}
function verifyHit(catalog: SourceCatalogRepository, sourceKeys: Map<string, string>, hit: SourcePassage): ContextEvaluationHit {
  let citationValid = false
  try { citationValid = catalog.readCitation(hit.citation).passage.citation.passageHash === hit.citation.passageHash } catch { /* A bad citation is a scored failure. */ }
  return { sourceKey: sourceKeys.get(hit.citation.sourceId) ?? 'foreign-only', citation: hit.citation, citationValid, historical: hit.historical || hit.readiness === 'stale', excluded: hit.readiness !== 'ready', foreign: !sourceKeys.has(hit.citation.sourceId) }
}
function packetSample(packet: ContextPacket, catalog: SourceCatalogRepository, sourceKeys: Map<string, string>): Omit<ContextEvaluationSample, 'caseId' | 'stage' | 'status' | 'latencyMs'> {
  const citations = [...new Map(packet.sections.flatMap((section) => section.citations).map((citation) => [citation.passageId, citation])).values()]
  return { presentation: 'sections', hits: citations.map((citation) => verifyHit(catalog, sourceKeys, catalog.readCitation(citation).passage)), categories: packet.sections.filter((section) => section.state === 'included').map((section) => section.category), missingCategories: packet.gaps.map((gap) => gap.category), canExecute: packet.canExecute, tokenEstimate: packet.budget.used, supersededCurrentRecords: packet.recordVersions.filter((record) => record.status === 'superseded').length }
}
async function timed(test: ContextEvaluationCase, stage: string, iterations: number, run: () => Omit<ContextEvaluationSample, 'caseId' | 'stage' | 'status' | 'latencyMs'> | Promise<Omit<ContextEvaluationSample, 'caseId' | 'stage' | 'status' | 'latencyMs'>>): Promise<ContextEvaluationSample> {
  const latencyMs: number[] = []
  let value: Awaited<ReturnType<typeof run>> | undefined
  for (let index = 0; index < iterations; index += 1) { const start = performance.now(); value = await run(); latencyMs.push(performance.now() - start) }
  return { caseId: test.id, stage, status: 'available', ...value!, latencyMs }
}
/** Frozen baseline ranking from 5543694's lexicalRelevance; no freshness or citation capabilities are retrofitted. */
function legacyRelevance(content: string, query: string): number {
  const normalized = content.toLowerCase(); const phrase = query.toLowerCase(); const terms = [...new Set(phrase.match(/[a-z0-9_-]+/g) ?? [])]
  const count = (text: string, term: string) => term ? text.split(term).length - 1 : 0
  if (!terms.some((term) => normalized.includes(term))) return 0
  return count(normalized, phrase) * 100 + terms.reduce((sum, term) => sum + count(normalized.split('\n', 1)[0], term), 0) * 20 + terms.reduce((sum, term) => sum + count(normalized, term), 0)
}

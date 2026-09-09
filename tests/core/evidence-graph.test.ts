import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { decodeDependencyGraphArtifact, encodeDependencyGraphArtifact } from '../../src/core/dependency-graph-artifact'
import { EvidenceGraphRepository, graphFileNodeId } from '../../src/core/evidence-graph'
import { graphNodeId, type GraphScopeInput, type GraphProvenance } from '../../src/core/evidence-graph-contracts'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { createHash } from 'node:crypto'

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.database.open) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-evidence-graph-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Evidence graph' })
  stores.push(store)
  return { root, store, graph: new EvidenceGraphRepository(store, new FrozenClock(new Date('2026-09-09T00:00:00Z'))) }
}
const provenance: GraphProvenance = { sourceId: 'declared-policy', revisionId: 'policy-v1', locator: 'workstack://declaration/policy-v1', contentHash: 'a'.repeat(64) }
const snapshot = { nodes: [{ path: 'src/api.ts' }, { path: 'src/schema.ts' }], edges: [{ from: 'src/api.ts', to: 'src/schema.ts' }], truncated: false }
const delta = { addedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [], truncated: false }
const api = graphFileNodeId('src/api.ts')
const component = graphNodeId('component', 'entity:api')
function scope(overrides: Partial<GraphScopeInput> = {}): GraphScopeInput {
  return { scopeKey: 'design', revisionId: 'v1', nodes: [
    { type: 'file', reference: 'src/api.ts', label: 'API file' },
    { type: 'component', reference: 'entity:api', label: 'Public API' },
    { type: 'test', reference: 'tests/api.test.ts', label: 'API contract' },
    { type: 'decision', reference: 'record:format', label: 'Use JSON' },
    { type: 'task', reference: 'completed-task', label: 'Previous API implementation' }
  ], edges: [
    { from: api, to: component, type: 'part_of', basis: 'declared', provenance },
    { from: component, to: api, type: 'supports', basis: 'declared', provenance },
    { from: 'test:tests/api.test.ts', to: api, type: 'tests', basis: 'observed', provenance },
    { from: 'decision:record:format', to: component, type: 'supports', basis: 'declared', provenance },
    { from: 'task:completed-task', to: component, type: 'implements', basis: 'declared', provenance },
    { from: component, to: 'component:unknown', type: 'related_to', basis: 'inferred', provenance }
  ], ...overrides }
}

describe('shared dependency artifact contract', () => {
  it('decodes current, released versionless envelopes, top-level and metadata snapshots while retaining revision and truncation', () => {
    const encoded = encodeDependencyGraphArtifact(snapshot, delta, 'prior-artifact')
    expect(decodeDependencyGraphArtifact(encoded)).toMatchObject({ formatVersion: 1, format: 'snapshot-envelope', baselineArtifactId: 'prior-artifact', snapshot, delta, truncated: false })
    expect(decodeDependencyGraphArtifact(JSON.stringify({ snapshot, delta, baselineArtifactId: null }))).toMatchObject({ formatVersion: 0, format: 'legacy-envelope', snapshot })
    expect(decodeDependencyGraphArtifact(encodeDependencyGraphArtifact({ ...snapshot, truncated: true }, delta, null))?.truncated).toBe(true)
    expect(decodeDependencyGraphArtifact(encodeDependencyGraphArtifact(snapshot, { ...delta, truncated: true }, null))?.truncated).toBe(true)
    expect(decodeDependencyGraphArtifact(JSON.stringify(snapshot))).toMatchObject({ format: 'legacy-snapshot', truncated: false })
    expect(decodeDependencyGraphArtifact(JSON.stringify({ ...snapshot, truncated: true }))?.truncated).toBe(true)
    expect(decodeDependencyGraphArtifact(JSON.stringify({ nodes: [], edges: [] }))?.snapshot.truncated).toBe(false)
    expect(decodeDependencyGraphArtifact('Old Markdown', { graph: snapshot })).toMatchObject({ format: 'metadata-snapshot', truncated: false })
    expect(decodeDependencyGraphArtifact('Old Markdown', { graph: snapshot, truncated: true })?.truncated).toBe(true)
    expect(decodeDependencyGraphArtifact('Old Markdown', { graph: { ...snapshot, truncated: true } })?.truncated).toBe(true)
  })
  it('rejects invalid or oversized artifacts and unsafe paths, including unknown envelope versions', () => {
    for (const value of ['', 'null', 'false', '[]', '{', '{}', '1', JSON.stringify({ version: 2, snapshot, delta, baselineArtifactId: null }), JSON.stringify({ snapshot }), 'x'.repeat(4_000_001)]) expect(decodeDependencyGraphArtifact(value)).toBeUndefined()
    for (const file of ['/absolute', 'C:/absolute', 'dir\\file', '../outside', 'a/../outside', `bad${String.fromCharCode(0)}`, `bad${String.fromCharCode(127)}`]) {
      expect(decodeDependencyGraphArtifact(JSON.stringify({ ...snapshot, nodes: [{ path: file }] }))).toBeUndefined()
    }
    expect(() => encodeDependencyGraphArtifact({ ...snapshot, nodes: [{ path: '/absolute' }] }, delta, null)).toThrow()
    expect(graphFileNodeId('test/api.ts')).toBe('test:test/api.ts')
    expect(graphFileNodeId('src/api.spec.ts')).toBe('test:src/api.spec.ts')
  })
})

describe('typed evidence graph', () => {
  it('navigates typed relationships in either direction with explanation paths, cycles and unresolved inferred links', async () => {
    const { graph } = await fixture()
    graph.replaceScope(scope())
    const result = graph.query({ nodeId: component, depth: 5 })
    expect(result.nodes).toHaveLength(6)
    expect(result.edges).toHaveLength(6)
    expect(result.truncated).toBe(false)
    expect(result.nodes.find((node) => node.type === 'test')).toMatchObject({ distance: 2, path: [{ to: api }, { to: 'test:tests/api.test.ts', direction: 'incoming' }] })
    expect(result.edges.find((edge) => edge.basis === 'inferred')).toMatchObject({ unresolved: true, provenanceState: 'unverified', direction: 'outgoing', provenance, graphRevisionId: 'v1' })
    expect(graph.query({ nodeId: api, direction: 'incoming', depth: 1 }).edges.map((edge) => edge.type).sort()).toEqual(['supports', 'tests'])
    expect(graph.query({ nodeId: component, direction: 'outgoing', edgeTypes: ['supports'], bases: ['declared'] }).nodes.map((node) => node.id)).toEqual([component, api])
    expect(graph.query({ nodeId: component, edgeTypes: [], bases: [] }).edges).toEqual([])
    expect(() => graph.query({ nodeId: 'component:missing' })).toThrow('Unknown evidence graph node')
    expect(() => graph.query({ nodeId: component, depth: 6 })).toThrow()
    expect(() => graph.query({ nodeId: 'invented:node' })).toThrow()
    expect(() => graph.replaceScope(scope({ edges: [{ from: 'file:', to: api, type: 'imports', basis: 'observed', provenance }] }))).toThrow()
  })

  it('bounds traversal and explicitly reports partial snapshots, depth, node and edge limits', async () => {
    const { graph } = await fixture()
    graph.replaceScope(scope({ truncated: true }))
    expect(graph.query({ nodeId: component, depth: 0 })).toMatchObject({ nodes: [{ id: component }], edges: [], truncated: true, truncationReasons: expect.arrayContaining(['depth limit', 'source snapshot is partial']) })
    expect(graph.query({ nodeId: component, maxNodes: 1 }).truncationReasons).toContain('node limit')
    const bounded = graph.query({ nodeId: component, maxEdges: 1 })
    expect(bounded.edges).toHaveLength(1)
    expect(bounded.truncationReasons).toContain('edge limit')
    expect(bounded.nodes.length).toBeLessThanOrEqual(2)
    expect(bounded.revisions).toMatchObject([{ scopeKey: 'design', revisionId: 'v1', truncated: true }])
    graph.replaceScope(scope({ scopeKey: 'extra', edges: [] }))
    expect(graph.query({ nodeId: component, maxEdges: 1 }).truncationReasons).toContain('revision limit')
  })

  it('verifies native record and directory revision citations and derives labels from current scope membership', async () => {
    const { graph, store } = await fixture()
    const records = new KnowledgeRecordsRepository(store)
    const record = records.create({ kind: 'decision', status: 'accepted', title: 'API format', markdown: 'Use JSON.' })
    const directory = new ProjectDirectoryRepository(store)
    const entity = directory.create({ kind: 'component', displayName: 'API', definition: 'Project API boundary.' })
    const cite = (id: string, version: number, snapshot: unknown): GraphProvenance => ({ sourceId: id, revisionId: `${id}@${version}`, locator: `workstack://native/${id}`, contentHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') })
    let counter = 0
    const publish = (source: GraphProvenance) => graph.replaceScope(scope({ revisionId: `native-${++counter}`, edges: [{ from: api, to: component, type: 'supports', basis: 'declared', provenance: source }] }))
    const state = () => graph.query({ nodeId: api }).edges.find((edge) => edge.scopeKey === 'design')!.provenanceState
    const recordCitation = cite(record.id, record.version, records.history(record.id)[0].snapshot)
    publish(recordCitation)
    expect(state()).toBe('current')
    records.update(record.id, { title: 'Updated API format', expectedVersion: record.version })
    expect(state()).toBe('stale')
    publish({ ...recordCitation, contentHash: '0'.repeat(64) })
    expect(state()).toBe('unverified')
    publish(cite(entity.id, entity.version, directory.history(entity.id)[0].snapshot))
    expect(state()).toBe('current')
    const retired = directory.retire(entity.id, entity.version, 'reviewer', 'No longer used.')
    publish(cite(entity.id, retired.version, directory.history(entity.id)[0].snapshot))
    expect(state()).toBe('stale')
    graph.replaceScope({ scopeKey: 'a-label', revisionId: 'one', nodes: [{ type: 'component', reference: 'labelled', label: 'First' }], edges: [] })
    graph.replaceScope({ scopeKey: 'b-label', revisionId: 'one', nodes: [{ type: 'component', reference: 'labelled', label: 'Second' }], edges: [] })
    expect(graph.query({ nodeId: 'component:labelled' }).nodes[0].label).toBe('First')
    graph.removeScope('a-label')
    expect(graph.query({ nodeId: 'component:labelled' }).nodes[0].label).toBe('Second')
  })

  it('reconciles revisions atomically, deduplicates replay, preserves unresolved cross-scope links and persists across reopen', async () => {
    const { graph, store, root } = await fixture()
    graph.replaceScope(scope())
    graph.replaceScope(scope())
    expect(graph.query({ nodeId: component, depth: 5 }).edges).toHaveLength(6)
    expect(() => graph.replaceScope(scope({ truncated: true }))).toThrow('immutable')
    expect(graph.query({ nodeId: component }).revisions[0].truncated).toBe(false)
    graph.replaceScope(scope({ scopeKey: 'other', nodes: [{ type: 'requirement', reference: 'record:req', label: 'API required', resolved: false }], edges: [{ from: 'requirement:record:req', to: component, type: 'requires', basis: 'declared', provenance }] }))
    graph.replaceScope(scope({ revisionId: 'v2', nodes: [], edges: [] }))
    expect(() => graph.replaceScope(scope())).toThrow('Historical graph revisions')
    const current = graph.query({ nodeId: component })
    expect(current.nodes.every((node) => !node.resolved)).toBe(true)
    expect(current.edges).toMatchObject([{ type: 'requires', graphRevisionId: 'v1', scopeKey: 'other', unresolved: true }])
    store.close()
    const reopened = await ProjectStore.open(root)
    stores.push(reopened)
    const persisted = new EvidenceGraphRepository(reopened)
    expect(persisted.query({ nodeId: component })).toEqual(current)
    persisted.removeScope('other')
    expect(() => persisted.query({ nodeId: component })).toThrow('Unknown')
    persisted.removeScope('design')
    expect(reopened.database.prepare('SELECT count(*) AS count FROM evidence_graph_edges').get()).toEqual({ count: 0 })
    expect(reopened.database.prepare('SELECT count(*) AS count FROM evidence_graph_revisions').get()).toEqual({ count: 0 })
  })

  it('retains precise source evidence and reports freshness, unavailable evidence and citation mismatch truthfully', async () => {
    const { graph, store } = await fixture()
    const catalog = new SourceCatalogRepository(store)
    const source = catalog.registerSource({ kind: 'manual', canonicalUri: 'workstack://api-contract', title: 'API policy' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: '# API\n\nContract requires JSON.' })
    const citation = catalog.search('Contract')[0].citation
    const cited: GraphProvenance = { sourceId: source.id, revisionId: revision.id, contentHash: revision.contentHash, locator: citation.locator, passageId: citation.passageId }
    const publish = (evidence: GraphProvenance, version: string) => graph.replaceScope(scope({ revisionId: version, edges: [{ from: api, to: component, type: 'supports', basis: 'declared', provenance: evidence }] }))
    const state = () => graph.query({ nodeId: api }).edges[0].provenanceState
    publish(cited, 'cited-v1')
    expect(state()).toBe('current')
    catalog.updatePolicy(source.id, 'paused')
    expect(state()).toBe('stale')
    catalog.updatePolicy(source.id, 'metadata_only')
    expect(state()).toBe('unavailable')
    catalog.updatePolicy(source.id, 'tracked_content')
    store.database.prepare('UPDATE source_catalog SET next_refresh_at = ? WHERE id = ?').run('2026-09-08T00:00:00Z', source.id)
    expect(state()).toBe('stale')
    store.database.prepare('UPDATE source_catalog SET next_refresh_at = NULL WHERE id = ?').run(source.id)
    catalog.recordFreshness(source.id, { unavailable: true, reason: 'Unavailable' })
    expect(state()).toBe('unavailable')
    catalog.recordFreshness(source.id, { unavailable: true, reason: 'Deleted', deleted: true })
    expect(state()).toBe('unavailable')
    catalog.publishRevision({ sourceId: source.id, original: '# Updated\n\nContract now requires a schema.' })
    expect(state()).toBe('stale')
    publish({ ...cited, contentHash: '0'.repeat(64) }, 'bad-hash')
    expect(state()).toBe('unverified')
    publish({ ...cited, passageId: 'missing' }, 'bad-passage')
    expect(state()).toBe('unverified')
    const withoutPassage = { ...cited }
    delete withoutPassage.passageId
    publish(withoutPassage, 'whole-revision')
    expect(state()).toBe('stale')
  })

  it('projects actual artifact insertions, reconciles removed imports and excludes sensitive paths', async () => {
    const { graph, store } = await fixture()
    const automation = new WikiAutomationRepository(store)
    const job = automation.createJob({ title: 'Imports', promptMarkdown: 'Inspect imports', sourcePaths: [] })
    const first = automation.addArtifact(job.id, { kind: 'dependency_graph', title: 'Graph', contentMarkdown: encodeDependencyGraphArtifact(snapshot, delta, null) })
    expect(graph.query({ nodeId: api })).toMatchObject({ edges: [{ type: 'imports', basis: 'observed', graphRevisionId: first.id, provenanceState: 'current' }], truncated: false })
    const second = automation.addArtifact(job.id, { kind: 'dependency_graph', title: 'Changed graph', contentMarkdown: encodeDependencyGraphArtifact({ nodes: [{ path: 'src/api.ts' }, { path: '.env' }], edges: [{ from: 'src/api.ts', to: '.env' }, { from: '.env', to: 'src/api.ts' }], truncated: true }, delta, first.id) })
    expect(graph.query({ nodeId: api })).toMatchObject({ edges: [], revisions: [{ revisionId: second.id }], truncated: true })
    expect(() => graph.query({ nodeId: 'file:.env' })).toThrow('Unknown')
    expect(graph.projectArtifact(second, ['src/api.ts'])).toBe(true)
    const invalid = automation.addArtifact(job.id, { kind: 'dependency_graph', title: 'Unreadable', contentMarkdown: '{' })
    expect(graph.projectArtifact(invalid, [])).toBe(false)
    const article = automation.addArtifact(job.id, { kind: 'wiki_article', title: 'Wiki', contentMarkdown: '# Article' })
    expect(graph.projectArtifact(article, [])).toBe(false)
    expect(automation.getDependencyGraphSnapshot(article)).toBeUndefined()
    // An unknown or mismatched artifact citation is retained as unverified evidence.
    graph.replaceScope(scope({ edges: [{ from: api, to: component, type: 'documents', basis: 'declared', provenance: { ...provenance, sourceId: first.id, revisionId: 'mismatch' } }] }))
    expect(graph.query({ nodeId: component }).edges[0].provenanceState).toBe('unverified')
    graph.replaceScope(scope({ revisionId: 'bad-artifact-hash', edges: [{ from: api, to: component, type: 'documents', basis: 'declared', provenance: { ...provenance, sourceId: first.id, revisionId: first.id } }] }))
    expect(graph.query({ nodeId: component }).edges[0].provenanceState).toBe('unverified')
  })
})

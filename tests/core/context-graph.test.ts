import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { EvidenceGraphRepository } from '../../src/core/evidence-graph'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { CONTEXT_GRAPH_LIMITS, filterContextGraph, queryContextGraph, type ContextGraphNeighborhood } from '../../src/core/context-graph'
import type { GraphScopeInput } from '../../src/core/evidence-graph-contracts'

const roots: string[] = []; const stores: ProjectStore[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-context-graph-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Graph context' }); stores.push(store)
  const catalog = new SourceCatalogRepository(store)
  const source = catalog.registerSource({ kind: 'manual', title: 'Graph evidence', canonicalUri: 'manual://graph-evidence' })
  const revision = catalog.publishRevision({ sourceId: source.id, original: 'Observed project relationships.' })
  const provenance = { sourceId: source.id, revisionId: revision.id, contentHash: revision.contentHash, locator: 'manual://graph-evidence' }
  return { store, catalog, source, provenance, graph: new EvidenceGraphRepository(store) }
}
const file = (reference: string, resolved = true): GraphScopeInput['nodes'][number] => ({ type: 'file', reference, label: reference, resolved })
function expectCompletePaths(result: ContextGraphNeighborhood) {
  const nodes = new Set(result.nodes.map((node) => node.id)); const edges = new Set(result.edges.map((edge) => edge.id)); const seeds = new Set(result.seeds.map((seed) => seed.nodeId))
  for (const entry of [...result.nodes, ...result.edges]) for (const origin of entry.origins) {
    expect(seeds.has(origin.seedId)).toBe(true)
    expect(origin.path.length).toBeLessThanOrEqual(2)
    expect(new Set(origin.path.map((step) => step.edgeId)).size).toBe(origin.path.length)
    let previous = origin.seedId
    for (const step of origin.path) {
      expect(step.from).toBe(previous)
      expect(nodes.has(step.from)).toBe(true); expect(nodes.has(step.to)).toBe(true); expect(edges.has(step.edgeId)).toBe(true)
      previous = step.to
    }
  }
  for (const node of result.nodes) {
    expect(node.distance).toBe(node.path.length)
    expect(node.origins.some((origin) => JSON.stringify(origin.path) === JSON.stringify(node.path))).toBe(true)
    for (const origin of node.origins) expect(origin.path.at(-1)?.to ?? origin.seedId).toBe(node.id)
  }
  for (const edge of result.edges) {
    expect(edge.direction).toBe(edge.path.at(-1)?.direction)
    expect(edge.origins.some((origin) => JSON.stringify(origin.path) === JSON.stringify(edge.path))).toBe(true)
    for (const origin of edge.origins) expect(origin.path.at(-1)?.edgeId).toBe(edge.id)
  }
}

describe('bounded task and declared-file graph context', () => {
  it('finds exact file/test seeds without a task node and retains both provenance and per-seed explanations', async () => {
    const { store, graph, provenance } = await fixture()
    graph.replaceScope({ scopeKey: 'observed', revisionId: 'observed-v1', nodes: [file('src/alpha.ts'), file('src/beta.ts'), { type: 'test', reference: 'tests/alpha.test.ts', label: 'Alpha tests' }], edges: [
      { from: 'file:src/alpha.ts', to: 'file:src/beta.ts', type: 'imports', basis: 'observed', provenance },
      { from: 'test:tests/alpha.test.ts', to: 'file:src/alpha.ts', type: 'tests', basis: 'declared', provenance }
    ] })
    graph.replaceScope({ scopeKey: 'inferred', revisionId: 'inferred-v1', nodes: [], edges: [
      { from: 'file:src/alpha.ts', to: 'file:src/beta.ts', type: 'related_to', basis: 'inferred', provenance: { ...provenance, contentHash: '0'.repeat(64) } }
    ] })
    const result = queryContextGraph(store, { workItemId: 'missing-task', declaredPaths: ['tests/alpha.test.ts', 'src/missing.ts', 'src/alpha.ts', 'src/alpha.ts'] })
    expect(result.seeds).toEqual([{ nodeId: 'file:src/alpha.ts', reason: 'declared_path', reference: 'src/alpha.ts' }, { nodeId: 'test:tests/alpha.test.ts', reason: 'declared_path', reference: 'tests/alpha.test.ts' }])
    expect(result.nodes).toHaveLength(3); expect(result.edges).toHaveLength(3); expect(result.truncated).toBe(false)
    expect(result.edges.find((edge) => edge.type === 'imports')).toMatchObject({ provenance, provenanceState: 'current', basis: 'observed', origins: [{ seedId: 'file:src/alpha.ts' }, { seedId: 'test:tests/alpha.test.ts' }] })
    expect(result.edges.find((edge) => edge.type === 'related_to')).toMatchObject({ provenanceState: 'unverified', basis: 'inferred' })
    expect(result.edges.find((edge) => edge.type === 'tests')?.origins.map((origin) => origin.path.at(-1)?.direction)).toEqual(['incoming', 'outgoing'])
    expectCompletePaths(result)
    expect(queryContextGraph(store, { workItemId: 'missing-task', declaredPaths: ['src/alpha.ts', 'tests/alpha.test.ts'] })).toEqual(result)
  })

  it('combines task and file neighborhoods at depth two without relabeling stale, unresolved or excluded evidence', async () => {
    const { store, graph, provenance, source, catalog } = await fixture()
    const references = ['a', 'x', 'y', 'z', '.env']
    graph.replaceScope({ scopeKey: 'task-scope', revisionId: 'task-v1', truncated: true,
      nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, ...references.map((reference) => file(reference, reference !== 'x'))],
      edges: [
        { from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance },
        ...[['a', 'x'], ['x', 'y'], ['y', 'z'], ['z', '.env']].map(([from, to]) => ({ from: `file:${from}`, to: `file:${to}`, type: 'imports' as const, basis: 'observed' as const, provenance }))
      ] })
    catalog.publishRevision({ sourceId: source.id, original: 'A newer source revision needs a graph refresh.' })
    const result = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: ['y'] })
    expect(result.seeds.map((seed) => seed.nodeId)).toEqual(['task:current-task', 'file:y'])
    expect(result.nodes.find((node) => node.id === 'file:x')).toMatchObject({ distance: 1, resolved: false, origins: [{ seedId: 'task:current-task', path: [{}, {}] }, { seedId: 'file:y', path: [{}] }] })
    expect(result.nodes.some((node) => node.id === 'file:.env')).toBe(true)
    expect(result.edges.every((edge) => edge.provenanceState === 'stale')).toBe(true)
    expect(result.edges.some((edge) => edge.unresolved)).toBe(true)
    expect(result.truncationReasons).toEqual(expect.arrayContaining(['depth limit', 'source snapshot is partial']))
    expectCompletePaths(result)
  })

  it('caps selected seeds and aggregate nodes while retaining complete selected explanation paths', async () => {
    const { store, graph, provenance } = await fixture()
    const paths = Array.from({ length: 12 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
    const nodes: GraphScopeInput['nodes'] = [{ type: 'task', reference: 'large-task', label: 'Large task' }]
    const edges: GraphScopeInput['edges'] = []
    for (const reference of paths) {
      nodes.push(file(reference))
      for (let index = 0; index < 4; index++) {
        const dependency = `${reference}.dependency${index}`; nodes.push(file(dependency))
        edges.push({ from: `file:${reference}`, to: `file:${dependency}`, type: 'imports', basis: 'observed', provenance })
      }
    }
    graph.replaceScope({ scopeKey: 'wide-graph', revisionId: 'wide-v1', nodes, edges })
    const result = queryContextGraph(store, { workItemId: 'large-task', declaredPaths: [...paths, ...Array.from({ length: 100 }, (_, index) => `missing${index}`)] })
    expect(result.seeds).toHaveLength(10); expect(result.seeds[0].nodeId).toBe('task:large-task')
    expect(result.nodes).toHaveLength(30); expect(result.edges.length).toBeLessThanOrEqual(50)
    expect(result.truncationReasons).toEqual(expect.arrayContaining(['declared path limit', 'seed limit', 'node limit']))
    expect(result.limits).toEqual(CONTEXT_GRAPH_LIMITS)
    expectCompletePaths(result)
  })

  it('caps aggregate edges and revisions independently and retains revision evidence for every selected edge', async () => {
    const { store, graph, provenance } = await fixture()
    for (const reference of ['a', 'b']) for (let index = 0; index < 30; index++) {
      const key = `${reference}-${index}`
      graph.replaceScope({ scopeKey: key, revisionId: `${key}-v1`, nodes: [file(reference), file(`${reference}-target`)],
        edges: [{ from: `file:${reference}`, to: `file:${reference}-target`, type: 'supports', basis: 'declared', provenance }] })
    }
    const result = queryContextGraph(store, { workItemId: 'absent-task', declaredPaths: ['a', 'b'] })
    expect(result.nodes).toHaveLength(4); expect(result.edges).toHaveLength(50); expect(result.revisions).toHaveLength(50)
    expect(result.truncationReasons).toEqual(expect.arrayContaining(['edge limit', 'revision limit']))
    expect(result.edges.every((edge) => result.revisions.some((revision) => revision.scopeKey === edge.scopeKey && revision.revisionId === edge.graphRevisionId))).toBe(true)
    expectCompletePaths(result)
  })

  it('returns explicit empty graph evidence when no exact seed exists', async () => {
    const { store } = await fixture()
    expect(queryContextGraph(store, { workItemId: 'absent-task', declaredPaths: ['missing.ts'] })).toEqual({ seeds: [], nodes: [], edges: [], revisions: [], truncated: false, truncationReasons: [], limits: CONTEXT_GRAPH_LIMITS })
  })
})

describe('context graph evidence eligibility', () => {
  it.each(['excluded', 'stale'] as const)('finds the eligible parallel bridge when the recorded shortest bridge is %s', async (state) => {
    const { store, graph, provenance, catalog } = await fixture()
    const other = catalog.registerSource({ kind: 'manual', title: 'Parallel bridge', canonicalUri: 'manual://parallel-bridge' })
    const otherRevision = catalog.publishRevision({ sourceId: other.id, original: 'A separate task association.' })
    const tests = catalog.registerSource({ kind: 'manual', title: 'Queue tests', canonicalUri: 'manual://queue-tests' })
    const testsRevision = catalog.publishRevision({ sourceId: tests.id, original: 'The queue contract validates the implementation.' })
    graph.replaceScope({ scopeKey: 'parallel', revisionId: 'parallel-v1', nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, file('src/queue.ts'), { type: 'test', reference: 'tests/queue.test.ts', label: 'Queue contract' }], edges: [
      { from: 'task:current-task', to: 'file:src/queue.ts', type: 'affects', basis: 'declared', provenance },
      { from: 'task:current-task', to: 'file:src/queue.ts', type: 'supports', basis: 'inferred', provenance: { ...provenance, sourceId: other.id, revisionId: otherRevision.id, contentHash: otherRevision.contentHash } },
      { from: 'test:tests/queue.test.ts', to: 'file:src/queue.ts', type: 'tests', basis: 'observed', provenance: { ...provenance, sourceId: tests.id, revisionId: testsRevision.id, contentHash: testsRevision.contentHash } }
    ] })
    const original = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: [] })
    const testEdge = original.edges.find((edge) => edge.type === 'tests')!
    const rejected = original.edges.find((edge) => edge.id === testEdge.origins[0].path[0].edgeId)!
    const retained = original.edges.find((edge) => edge.type !== 'tests' && edge.id !== rejected.id)!
    if (state === 'stale') catalog.publishRevision({ sourceId: rejected.provenance.sourceId, original: 'This task association changed.' })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: [] })
    expect(input.edges.find((edge) => edge.id === testEdge.id)!.origins[0].path[0].edgeId).toBe(rejected.id)
    const result = filterContextGraph(input, (edge) => edge.provenanceState === 'current' && (state !== 'excluded' || edge.provenance.sourceId !== rejected.provenance.sourceId))
    expect(result.edges.map((edge) => edge.id).sort()).toEqual([retained.id, testEdge.id].sort())
    expect(result.edges.find((edge) => edge.id === testEdge.id)).toMatchObject({ direction: 'incoming', path: [{ edgeId: retained.id }, { edgeId: testEdge.id }], origins: [{ seedId: 'task:current-task', path: [{ edgeId: retained.id }, { edgeId: testEdge.id }] }] })
    expect(result.nodes.find((node) => node.type === 'test')).toMatchObject({ label: 'Queue contract', distance: 2, path: [{ edgeId: retained.id }, { edgeId: testEdge.id }] })
    expectCompletePaths(result)
  })

  it.each(['excluded', 'stale'] as const)('removes downstream relevance supported only by a %s bridge', async (state) => {
    const { store, graph, provenance, source, catalog } = await fixture()
    const allowed = catalog.registerSource({ kind: 'manual', title: 'Allowed imports', canonicalUri: 'manual://allowed-imports' })
    const revision = catalog.publishRevision({ sourceId: allowed.id, original: 'Module a imports module b.' })
    graph.replaceScope({ scopeKey: 'bridge', revisionId: 'bridge-v1', truncated: true,
      nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, file('a'), file('unused')],
      edges: [{ from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance }] })
    graph.replaceScope({ scopeKey: 'allowed', revisionId: 'allowed-v1', nodes: [file('b')],
      edges: [{ from: 'file:a', to: 'file:b', type: 'imports', basis: 'observed', provenance: { ...provenance, sourceId: allowed.id, revisionId: revision.id, contentHash: revision.contentHash } }] })
    if (state === 'stale') catalog.publishRevision({ sourceId: source.id, original: 'A newer task mapping needs graph refresh.' })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: ['unused'] })
    const before = JSON.stringify(input)
    expect(input.edges.find((edge) => edge.scopeKey === 'allowed')!.origins[0].path).toHaveLength(2)
    expect(input.edges.find((edge) => edge.scopeKey === 'bridge')!.provenanceState).toBe(state === 'stale' ? 'stale' : 'current')
    const result = filterContextGraph(input, (edge) => edge.provenanceState === 'current' && (state !== 'excluded' || edge.provenance.sourceId !== source.id))
    expect(result.edges).toEqual([]); expect(result.nodes).toEqual([]); expect(result.seeds).toEqual([]); expect(result.revisions).toEqual([])
    expect(result.truncated).toBe(true); expect(result.truncationReasons).toEqual(input.truncationReasons); expect(result.limits).toEqual(input.limits)
    expect(JSON.stringify(input)).toBe(before)
    expectCompletePaths(result)
  })

  it('retains a valid declared-file origin and replaces an excluded canonical path and direction', async () => {
    const { store, graph, provenance, source, catalog } = await fixture()
    const allowed = catalog.registerSource({ kind: 'manual', title: 'Allowed imports', canonicalUri: 'manual://allowed-imports' })
    const revision = catalog.publishRevision({ sourceId: allowed.id, original: 'Module a imports module b.' })
    graph.replaceScope({ scopeKey: 'bridge', revisionId: 'bridge-v1', nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, file('a')],
      edges: [{ from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance }] })
    graph.replaceScope({ scopeKey: 'allowed', revisionId: 'allowed-v1', nodes: [file('b')],
      edges: [{ from: 'file:a', to: 'file:b', type: 'imports', basis: 'observed', provenance: { ...provenance, sourceId: allowed.id, revisionId: revision.id, contentHash: revision.contentHash } }] })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: ['b'] })
    const original = input.edges.find((edge) => edge.scopeKey === 'allowed')!
    expect(original).toMatchObject({ direction: 'outgoing', origins: [{ seedId: 'task:current-task' }, { seedId: 'file:b' }] })
    const result = filterContextGraph(input, (edge) => edge.provenance.sourceId !== source.id && edge.provenanceState === 'current')
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ id: original.id, direction: 'incoming', provenance: original.provenance,
      path: [{ from: 'file:b', to: 'file:a', direction: 'incoming' }], origins: [{ seedId: 'file:b', path: [{ edgeId: original.id }] }] })
    expect(result.seeds).toEqual([{ nodeId: 'file:b', reason: 'declared_path', reference: 'b' }])
    expect(result.nodes.map((node) => node.id).sort()).toEqual(['file:a', 'file:b'])
    expect(result.nodes.find((node) => node.id === 'file:a')).toMatchObject({ distance: 1, origins: [{ seedId: 'file:b' }] })
    expect(result.revisions.map((entry) => entry.scopeKey)).toEqual(['allowed'])
    expectCompletePaths(result)
  })

  it('reconstructs a node through a valid same-seed detour when its original shortest path is excluded', async () => {
    const { store, graph, provenance } = await fixture()
    graph.replaceScope({ scopeKey: 'triangle', revisionId: 'triangle-v1', nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, file('a'), file('b')], edges: [
      { from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance },
      { from: 'task:current-task', to: 'file:b', type: 'affects', basis: 'declared', provenance },
      { from: 'file:a', to: 'file:b', type: 'imports', basis: 'observed', provenance }
    ] })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: [] })
    const cyclic = filterContextGraph(input, () => true)
    expect(cyclic.edges).toHaveLength(3); expect(cyclic.nodes).toHaveLength(3)
    expect(cyclic.nodes.every((node) => node.distance <= 1)).toBe(true)
    expectCompletePaths(cyclic)
    const [valid, excluded] = input.edges.filter((edge) => edge.from === 'task:current-task')
    const detour = input.edges.find((edge) => edge.type === 'imports')!
    expect(detour.origins[0].path.map((step) => step.edgeId)).toEqual([valid.id, detour.id])
    expect(input.nodes.find((node) => node.id === excluded.to)!.origins[0].path.map((step) => step.edgeId)).toEqual([excluded.id])
    const result = filterContextGraph(input, (edge) => edge.id !== excluded.id)
    expect(result.edges).toHaveLength(2)
    expect(result.nodes.find((node) => node.id === excluded.to)).toMatchObject({ distance: 2, path: [{ edgeId: valid.id }, { edgeId: detour.id }], origins: [{ seedId: 'task:current-task', path: [{ edgeId: valid.id }, { edgeId: detour.id }] }] })
    expectCompletePaths(result)
  })

  it('preserves all eligible seed explanations, chooses shortest canonical paths and handles an empty graph', async () => {
    const { store, graph, provenance } = await fixture()
    graph.replaceScope({ scopeKey: 'connected', revisionId: 'connected-v1', nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, file('a'), file('b')], edges: [
      { from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance },
      { from: 'file:a', to: 'file:b', type: 'imports', basis: 'observed', provenance }
    ] })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: ['a', 'b'] })
    const before = JSON.stringify(input)
    const result = filterContextGraph(input, () => true)
    expect(result.seeds).toEqual(input.seeds); expect(result.revisions).toEqual(input.revisions)
    expect(result.edges).toHaveLength(2); expect(result.nodes).toHaveLength(3)
    expect(result.edges.every((edge) => edge.origins.length === 3)).toBe(true)
    expect(result.edges.every((edge) => edge.path.length === 1)).toBe(true)
    expect(result.nodes.every((node) => node.distance === 0 && node.origins.length === 3)).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
    expectCompletePaths(result)
    const empty = queryContextGraph(store, { workItemId: 'absent-task', declaredPaths: [] })
    expect(filterContextGraph(empty, () => true)).toEqual(empty)
  })

  it('does not expand beyond the original depth when combining selected seed neighborhoods', async () => {
    const { store, graph, provenance } = await fixture()
    graph.replaceScope({ scopeKey: 'chain', revisionId: 'chain-v1', nodes: [{ type: 'task', reference: 'current-task', label: 'Current task' }, ...['a', 'b', 'c', 'd'].map((reference) => file(reference))], edges: [
      { from: 'task:current-task', to: 'file:a', type: 'affects', basis: 'declared', provenance },
      ...[['a', 'b'], ['b', 'c'], ['c', 'd']].map(([from, to]) => ({ from: `file:${from}`, to: `file:${to}`, type: 'imports' as const, basis: 'observed' as const, provenance }))
    ] })
    const input = queryContextGraph(store, { workItemId: 'current-task', declaredPaths: ['d'] })
    const result = filterContextGraph(input, () => true)
    expect(result.edges).toHaveLength(4); expect(result.nodes).toHaveLength(5)
    expect(result.edges.find((edge) => edge.from === 'file:b')!.origins.map((origin) => origin.seedId)).toEqual(['file:d'])
    expect(result.edges.find((edge) => edge.from === 'file:a')!.origins.map((origin) => origin.seedId)).toEqual(['task:current-task'])
    expect(result.nodes.find((node) => node.id === 'file:b')!.origins).toEqual(expect.arrayContaining([
      expect.objectContaining({ seedId: 'task:current-task', path: [{ edgeId: expect.any(String), from: 'task:current-task', to: 'file:a', direction: 'outgoing' }, { edgeId: expect.any(String), from: 'file:a', to: 'file:b', direction: 'outgoing' }] }),
      expect.objectContaining({ seedId: 'file:d', path: [{ edgeId: expect.any(String), from: 'file:d', to: 'file:c', direction: 'incoming' }, { edgeId: expect.any(String), from: 'file:c', to: 'file:b', direction: 'incoming' }] })
    ]))
    expect(result.truncated).toBe(true); expect(result.truncationReasons).toEqual(input.truncationReasons); expect(result.limits).toEqual(input.limits)
    expectCompletePaths(result)
    expect(filterContextGraph(input, () => true)).toEqual(result)
  })
})

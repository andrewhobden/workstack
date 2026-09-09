import { EvidenceGraphRepository } from './evidence-graph'
import type { GraphNeighborhood, GraphPathStep } from './evidence-graph-contracts'
import type { ProjectStore } from './project-store'

export const CONTEXT_GRAPH_LIMITS = Object.freeze({ maxSeeds: 10, maxDeclaredPaths: 100, depth: 2, maxNodes: 30, maxEdges: 50, maxRevisions: 50 })
export interface ContextGraphSeed { nodeId: string; reason: 'task' | 'declared_path'; reference: string }
export interface ContextGraphOrigin { seedId: string; path: GraphPathStep[] }
export interface ContextGraphNeighborhood extends GraphNeighborhood {
  seeds: ContextGraphSeed[]
  nodes: Array<GraphNeighborhood['nodes'][number] & { origins: ContextGraphOrigin[] }>
  edges: Array<GraphNeighborhood['edges'][number] & { origins: ContextGraphOrigin[] }>
  limits: typeof CONTEXT_GRAPH_LIMITS
}

/** Recompute bounded explanation paths over eligible selected relationships, including alternate routes. */
export function filterContextGraph(graph: ContextGraphNeighborhood, predicate: (edge: ContextGraphNeighborhood['edges'][number]) => boolean): ContextGraphNeighborhood {
  const eligible = graph.edges.filter(predicate)
  const adjacency = [...eligible].sort((left, right) => left.id.localeCompare(right.id))
  const edgeOrigins = new Map<string, ContextGraphOrigin[]>()
  for (const seed of graph.seeds) {
    const seenNodes = new Set([seed.nodeId]); const seenEdges = new Set<string>()
    const queue: Array<{ nodeId: string; path: GraphPathStep[] }> = [{ nodeId: seed.nodeId, path: [] }]
    for (const current of queue) {
      if (current.path.length >= graph.limits.depth) continue
      for (const edge of adjacency) {
        if (seenEdges.has(edge.id) || edge.from !== current.nodeId && edge.to !== current.nodeId) continue
        seenEdges.add(edge.id)
        const outgoing = edge.from === current.nodeId
        const target = outgoing ? edge.to : edge.from
        const path = [...current.path, { edgeId: edge.id, from: current.nodeId, to: target, direction: outgoing ? 'outgoing' : 'incoming' } as const]
        const origins = edgeOrigins.get(edge.id)
        if (origins) origins.push({ seedId: seed.nodeId, path })
        else edgeOrigins.set(edge.id, [{ seedId: seed.nodeId, path }])
        if (!seenNodes.has(target)) { seenNodes.add(target); queue.push({ nodeId: target, path }) }
      }
    }
  }
  const shortest = (origins: ContextGraphOrigin[]): ContextGraphOrigin[] => [...origins].sort((left, right) => left.path.length - right.path.length)
  const edges = eligible.flatMap((edge) => {
    const origins = edgeOrigins.get(edge.id)
    if (!origins) return []
    const path = shortest(origins)[0].path
    return [{ ...edge, path, direction: path[path.length - 1].direction, origins }]
  })
  const seedIds = new Set<string>()
  const nodeOrigins = new Map<string, ContextGraphOrigin[]>()
  const addNodeOrigin = (nodeId: string, origin: ContextGraphOrigin): void => {
    const existing = nodeOrigins.get(nodeId)
    if (existing) existing.push(origin)
    else nodeOrigins.set(nodeId, [origin])
  }
  for (const edge of edges) for (const origin of edge.origins) {
    seedIds.add(origin.seedId)
    addNodeOrigin(origin.seedId, { seedId: origin.seedId, path: [] })
    origin.path.forEach((step, index) => addNodeOrigin(step.to, { seedId: origin.seedId, path: origin.path.slice(0, index + 1) }))
  }
  const nodes = graph.nodes.flatMap((node) => {
    const candidates = nodeOrigins.get(node.id)
    if (!candidates) return []
    const origins = shortest(candidates).filter((origin, index, ordered) => ordered.findIndex((entry) => entry.seedId === origin.seedId) === index)
    return [{ ...node, distance: origins[0].path.length, path: origins[0].path, origins }]
  })
  const scopes = new Set(edges.map((edge) => edge.scopeKey))
  return { ...graph, edges, nodes, seeds: graph.seeds.filter((seed) => seedIds.has(seed.nodeId)), revisions: graph.revisions.filter((revision) => scopes.has(revision.scopeKey)) }
}

/** Exact task/file/test seeds share one SQLite snapshot and one aggregate budget. Callers evaluate freshness separately. */
export function queryContextGraph(store: ProjectStore, input: { workItemId: string; declaredPaths: string[] }): ContextGraphNeighborhood {
  return store.database.transaction(() => {
    const reasons = new Set<string>()
    if (input.declaredPaths.length > CONTEXT_GRAPH_LIMITS.maxDeclaredPaths) reasons.add('declared path limit')
    const candidates: ContextGraphSeed[] = [{ nodeId: `task:${input.workItemId}`, reason: 'task', reference: input.workItemId }]
    for (const reference of [...new Set(input.declaredPaths.slice(0, CONTEXT_GRAPH_LIMITS.maxDeclaredPaths))].sort()) {
      for (const type of ['file', 'test']) candidates.push({ nodeId: `${type}:${reference}`, reason: 'declared_path', reference })
    }
    const exists = store.database.prepare('SELECT 1 FROM evidence_graph_nodes WHERE id=?')
    const matching = candidates.filter((seed) => exists.get(seed.nodeId))
    if (matching.length > CONTEXT_GRAPH_LIMITS.maxSeeds) reasons.add('seed limit')
    const seeds = matching.slice(0, CONTEXT_GRAPH_LIMITS.maxSeeds)
    const graph = new EvidenceGraphRepository(store)
    const neighborhoods = seeds.map((seed) => ({ seed, neighborhood: graph.query({ nodeId: seed.nodeId, depth: CONTEXT_GRAPH_LIMITS.depth, maxNodes: CONTEXT_GRAPH_LIMITS.maxNodes, maxEdges: CONTEXT_GRAPH_LIMITS.maxEdges }) }))
    const nodes = new Map<string, ContextGraphNeighborhood['nodes'][number]>()
    const edges = new Map<string, ContextGraphNeighborhood['edges'][number]>()
    const revisions = new Map<string, GraphNeighborhood['revisions'][number]>()
    const addOrigin = (origins: ContextGraphOrigin[], seedId: string, path: GraphPathStep[]): void => {
      if (!origins.some((origin) => origin.seedId === seedId)) origins.push({ seedId, path })
    }
    for (const { seed, neighborhood } of neighborhoods) {
      nodes.set(seed.nodeId, { ...neighborhood.nodes[0], distance: 0, path: [], origins: [{ seedId: seed.nodeId, path: [] }] })
      for (const reason of neighborhood.truncationReasons) reasons.add(reason)
      for (const revision of neighborhood.revisions) revisions.set(revision.scopeKey, revision)
    }
    for (const { seed, neighborhood } of neighborhoods) {
      const sourceNodes = new Map(neighborhood.nodes.map((node) => [node.id, node]))
      const sourceEdges = new Map(neighborhood.edges.map((edge) => [edge.id, edge]))
      const includeNode = (id: string, steps: GraphPathStep[]): void => {
        const existing = nodes.get(id)
        if (existing) {
          addOrigin(existing.origins, seed.nodeId, steps)
          if (steps.length < existing.distance) { existing.distance = steps.length; existing.path = steps }
        } else nodes.set(id, { ...sourceNodes.get(id)!, distance: steps.length, path: steps, origins: [{ seedId: seed.nodeId, path: steps }] })
      }
      for (const edge of neighborhood.edges) {
        const requiredNodes = new Set(edge.path.flatMap((step) => [step.from, step.to]))
        const requiredEdges = new Set(edge.path.map((step) => step.edgeId))
        if (nodes.size + [...requiredNodes].filter((id) => !nodes.has(id)).length > CONTEXT_GRAPH_LIMITS.maxNodes) { reasons.add('node limit'); continue }
        if (edges.size + [...requiredEdges].filter((id) => !edges.has(id)).length > CONTEXT_GRAPH_LIMITS.maxEdges) { reasons.add('edge limit'); continue }
        edge.path.forEach((step, index) => {
          const steps = edge.path.slice(0, index + 1)
          includeNode(step.from, edge.path.slice(0, index)); includeNode(step.to, steps)
          const existing = edges.get(step.edgeId)
          if (existing) addOrigin(existing.origins, seed.nodeId, steps)
          else edges.set(step.edgeId, { ...sourceEdges.get(step.edgeId)!, origins: [{ seedId: seed.nodeId, path: steps }] })
        })
      }
    }
    const usedScopes = new Set([...edges.values()].map((edge) => edge.scopeKey))
    const orderedRevisions = [...revisions.values()].sort((left, right) => Number(usedScopes.has(right.scopeKey)) - Number(usedScopes.has(left.scopeKey)))
    if (orderedRevisions.length > CONTEXT_GRAPH_LIMITS.maxRevisions) reasons.add('revision limit')
    return { seeds, nodes: [...nodes.values()], edges: [...edges.values()], revisions: orderedRevisions.slice(0, CONTEXT_GRAPH_LIMITS.maxRevisions),
      truncated: reasons.size > 0, truncationReasons: [...reasons], limits: CONTEXT_GRAPH_LIMITS }
  })()
}

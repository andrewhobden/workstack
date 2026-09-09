import { createHash } from 'node:crypto'
import { systemClock, type Clock } from './clock'
import { decodeDependencyGraphArtifact } from './dependency-graph-artifact'
import { excludedEvidencePath } from './evidence-policy'
import { WorkstackError } from './errors'
import type { ProjectStore } from './project-store'
import type { WikiAutomationArtifact } from './types'
import {
  graphNodeId, graphQuerySchema, graphScopeInputSchema, type GraphEdge, type GraphNeighborhood, type GraphNode,
  type GraphNodeType, type GraphProvenance, type GraphQuery, type GraphScopeInput
} from './evidence-graph-contracts'

interface EdgeRow { id: string; from_id: string; to_id: string; type: GraphEdge['type']; basis: GraphEdge['basis']; scope_key: string; revision_id: string; provenance_json: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const graphFileNodeId = (reference: string): string => graphNodeId(fileType(reference), reference)
function fileType(reference: string): 'file' | 'test' { return /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^/]+$/.test(reference) ? 'test' : 'file' }

export class EvidenceGraphRepository {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  replaceScope(input: GraphScopeInput): void {
    const parsed = graphScopeInputSchema.parse(input)
    parsed.nodes.sort((left, right) => graphNodeId(left.type, left.reference).localeCompare(graphNodeId(right.type, right.reference)))
    parsed.edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    const hash = digest(JSON.stringify(parsed))
    this.store.database.transaction(() => {
      const current = this.store.database.prepare('SELECT revision_id FROM evidence_graph_scopes WHERE scope_key = ?').get(parsed.scopeKey) as { revision_id: string } | undefined
      const previous = this.store.database.prepare('SELECT content_hash FROM evidence_graph_revisions WHERE scope_key = ? AND revision_id = ?').get(parsed.scopeKey, parsed.revisionId) as { content_hash: string } | undefined
      if (previous) {
        if (previous.content_hash !== hash) throw new WorkstackError('VALIDATION_ERROR', 'A graph revision is immutable; supply a new revision ID for changed relationships.')
        if (current!.revision_id !== parsed.revisionId) throw new WorkstackError('INVALID_STATE_TRANSITION', 'Historical graph revisions cannot replace current evidence. Restore using a new revision ID.')
        return
      }
      this.store.database.prepare(`INSERT INTO evidence_graph_scopes VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET revision_id = excluded.revision_id`).run(parsed.scopeKey, parsed.revisionId)
      this.store.database.prepare('INSERT INTO evidence_graph_revisions VALUES (?, ?, ?, ?, ?)').run(parsed.scopeKey, parsed.revisionId, hash, Number(parsed.truncated), this.clock.now().toISOString())
      this.store.database.prepare('DELETE FROM evidence_graph_edges WHERE scope_key = ?').run(parsed.scopeKey)
      this.store.database.prepare('DELETE FROM evidence_graph_members WHERE scope_key = ?').run(parsed.scopeKey)
      for (const node of parsed.nodes) {
        const id = graphNodeId(node.type, node.reference)
        this.store.database.prepare(`INSERT INTO evidence_graph_nodes VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label`).run(id, node.type, node.reference, node.label)
        this.store.database.prepare('INSERT OR REPLACE INTO evidence_graph_members VALUES (?, ?, ?, ?)').run(parsed.scopeKey, id, Number(node.resolved), node.label)
      }
      for (const edge of parsed.edges) {
        for (const id of [edge.from, edge.to]) {
          const separator = id.indexOf(':')
          const reference = id.slice(separator + 1)
          this.store.database.prepare('INSERT OR IGNORE INTO evidence_graph_nodes VALUES (?, ?, ?, ?)').run(id, id.slice(0, separator), reference, reference.slice(0, 1000))
        }
        this.store.database.prepare('INSERT OR IGNORE INTO evidence_graph_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(digest(JSON.stringify([parsed.scopeKey, edge])), parsed.scopeKey, edge.from, edge.to, edge.type, edge.basis, JSON.stringify(edge.provenance), parsed.revisionId)
      }
      this.pruneNodes()
    }).immediate()
  }

  removeScope(scopeKey: string): void {
    this.store.database.transaction(() => {
      this.store.database.prepare('DELETE FROM evidence_graph_scopes WHERE scope_key = ?').run(scopeKey)
      this.pruneNodes()
    }).immediate()
  }

  projectArtifact(artifact: WikiAutomationArtifact, sourcePaths: string[]): boolean {
    if (artifact.kind !== 'dependency_graph') return false
    const decoded = decodeDependencyGraphArtifact(artifact.contentMarkdown, artifact.metadata)
    if (!decoded) return false
    const snapshot = decoded.snapshot
    const allowed = (reference: string): boolean => !excludedEvidencePath(reference)
    const provenance: GraphProvenance = { sourceId: artifact.id, revisionId: artifact.id, contentHash: digest(artifact.contentMarkdown), locator: `workstack://wiki-artifact/${artifact.id}` }
    this.replaceScope({ scopeKey: 'repository-imports', revisionId: artifact.id, truncated: decoded.truncated || sourcePaths.length > 0,
      nodes: snapshot.nodes.filter((node) => allowed(node.path)).map((node) => ({ type: fileType(node.path), reference: node.path, label: node.path.slice(0, 1000) })),
      edges: snapshot.edges.filter((edge) => allowed(edge.from) && allowed(edge.to)).map((edge) => ({ from: graphFileNodeId(edge.from), to: graphFileNodeId(edge.to), type: 'imports', basis: 'observed', provenance })) })
    return true
  }

  query(input: GraphQuery): GraphNeighborhood {
    const parsed = graphQuerySchema.parse(input)
    return this.store.database.transaction(() => {
      const origin = this.node(parsed.nodeId)
      if (!origin) throw new WorkstackError('VALIDATION_ERROR', `Unknown evidence graph node: ${parsed.nodeId}`)
      const nodes = new Map<string, GraphNeighborhood['nodes'][number]>([[origin.id, { ...origin, distance: 0, path: [] }]])
      const edges = new Map<string, GraphNeighborhood['edges'][number]>()
      const revisions = new Map<string, GraphNeighborhood['revisions'][number]>()
      const reasons = new Set<string>()
      const queue = [nodes.get(origin.id)!]
      const filters: string[] = []
      const bindings: string[] = []
      if (parsed.edgeTypes) { filters.push(`e.type IN (${parsed.edgeTypes.map(() => '?').join(',')})`); bindings.push(...parsed.edgeTypes) }
      if (parsed.bases) { filters.push(`e.basis IN (${parsed.bases.map(() => '?').join(',')})`); bindings.push(...parsed.bases) }
      const extra = filters.length ? ` AND ${filters.join(' AND ')}` : ''
      const adjacency = parsed.direction === 'outgoing' ? 'e.from_id = ?' : parsed.direction === 'incoming' ? 'e.to_id = ?' : '(e.from_id = ? OR e.to_id = ?)'
      const statement = this.store.database.prepare(`SELECT e.* FROM evidence_graph_edges e WHERE ${adjacency}${extra} ORDER BY e.id LIMIT ?`)
      const includeRevision = (scopeKey: string): void => {
        if (revisions.has(scopeKey)) return
        if (revisions.size >= parsed.maxEdges) { reasons.add('revision limit'); return }
        const row = this.store.database.prepare(`SELECT r.scope_key AS scopeKey, r.revision_id AS revisionId, r.content_hash AS contentHash, r.truncated
          FROM evidence_graph_revisions r JOIN evidence_graph_scopes s ON s.scope_key = r.scope_key AND s.revision_id = r.revision_id WHERE r.scope_key = ?`).get(scopeKey) as GraphNeighborhood['revisions'][number]
        revisions.set(scopeKey, { ...row, truncated: Boolean(row.truncated) })
        if (row.truncated) reasons.add('source snapshot is partial')
      }
      for (const membership of this.store.database.prepare('SELECT scope_key FROM evidence_graph_members WHERE node_id = ? ORDER BY scope_key LIMIT ?').all(origin.id, parsed.maxEdges + 1) as Array<{ scope_key: string }>) includeRevision(membership.scope_key)
      while (queue.length) {
        const current = queue.shift()!
        const args = parsed.direction === 'both' ? [current.id, current.id] : [current.id]
        const rows = statement.all(...args, ...bindings, parsed.maxEdges + 1) as EdgeRow[]
        if (rows.length > parsed.maxEdges) reasons.add('edge limit')
        for (const row of rows) {
          if (edges.has(row.id)) continue
          if (current.distance >= parsed.depth) { reasons.add('depth limit'); continue }
          if (edges.size >= parsed.maxEdges) { reasons.add('edge limit'); break }
          const outgoing = row.from_id === current.id
          const targetId = outgoing ? row.to_id : row.from_id
          if (!nodes.has(targetId) && nodes.size >= parsed.maxNodes) { reasons.add('node limit'); continue }
          const target = this.node(targetId)!
          const direction = outgoing ? 'outgoing' : 'incoming'
          const steps = [...current.path, { edgeId: row.id, from: current.id, to: target.id, direction } as const]
          if (!nodes.has(targetId)) {
            const discovered = { ...target, distance: current.distance + 1, path: steps }
            nodes.set(targetId, discovered)
            queue.push(discovered)
          }
          const provenance = JSON.parse(row.provenance_json) as GraphProvenance
          edges.set(row.id, { id: row.id, from: row.from_id, to: row.to_id, type: row.type, basis: row.basis,
            scopeKey: row.scope_key, graphRevisionId: row.revision_id, provenance, provenanceState: this.provenanceState(provenance),
            unresolved: !current.resolved || !target.resolved, direction, path: steps })
          includeRevision(row.scope_key)
        }
      }
      return { nodes: [...nodes.values()], edges: [...edges.values()], revisions: [...revisions.values()], truncated: reasons.size > 0,
        truncationReasons: [...reasons], limits: { depth: parsed.depth, maxNodes: parsed.maxNodes, maxEdges: parsed.maxEdges } }
    })()
  }

  private node(id: string): GraphNode | undefined {
    const row = this.store.database.prepare(`SELECT n.id,n.type,n.reference,COALESCE((SELECT label FROM evidence_graph_members WHERE node_id = n.id ORDER BY resolved DESC,scope_key LIMIT 1),n.reference) AS label,
      EXISTS(SELECT 1 FROM evidence_graph_members m WHERE m.node_id = n.id AND m.resolved = 1) AS resolved FROM evidence_graph_nodes n WHERE id = ?`).get(id) as { id: string; type: GraphNodeType; reference: string; label: string; resolved: number } | undefined
    return row ? { ...row, resolved: Boolean(row.resolved) } : undefined
  }

  private provenanceState(provenance: GraphProvenance): GraphEdge['provenanceState'] {
    const source = this.store.database.prepare(`SELECT r.content_hash, s.current_revision_id, s.state, s.deleted_at, s.policy, s.next_refresh_at FROM source_revisions r JOIN source_catalog s ON s.id = r.source_id WHERE r.id = ? AND r.source_id = ?`).get(provenance.revisionId, provenance.sourceId) as { content_hash: string; current_revision_id: string | null; state: string; deleted_at: string | null; policy: string; next_refresh_at: string | null } | undefined
    if (source) {
      if (source.content_hash !== provenance.contentHash) return 'unverified'
      if (provenance.passageId && !this.store.database.prepare('SELECT 1 FROM source_passages WHERE id = ? AND source_id = ? AND revision_id = ?').get(provenance.passageId, provenance.sourceId, provenance.revisionId)) return 'unverified'
      if (source.deleted_at || source.state === 'unavailable' || source.policy === 'metadata_only') return 'unavailable'
      if (source.policy !== 'import_once' && source.next_refresh_at && source.next_refresh_at <= this.clock.now().toISOString()) return 'stale'
      return source.current_revision_id === provenance.revisionId && source.state === 'ready' && source.policy !== 'paused' ? 'current' : 'stale'
    }
    const record = this.store.database.prepare(`SELECT h.snapshot_json,r.version,r.status FROM knowledge_record_history h JOIN knowledge_records r ON r.id = h.record_id
      WHERE h.record_id = ? AND h.record_id || '@' || h.version = ?`).get(provenance.sourceId, provenance.revisionId) as { snapshot_json: string; version: number; status: string } | undefined
    if (record) return this.historyState(provenance, record)
    const entity = this.store.database.prepare(`SELECT h.snapshot_json,e.version,e.status FROM project_entity_history h JOIN project_entities e ON e.id = h.entity_id
      WHERE h.entity_id = ? AND h.entity_id || '@' || json_extract(h.snapshot_json,'$.version') = ? ORDER BY h.id DESC LIMIT 1`).get(provenance.sourceId, provenance.revisionId) as { snapshot_json: string; version: number; status: string } | undefined
    if (entity) return this.historyState(provenance, entity)
    const artifact = this.store.database.prepare('SELECT content_markdown FROM wiki_automation_artifacts WHERE id = ?').get(provenance.sourceId) as { content_markdown: string } | undefined
    return artifact && provenance.revisionId === provenance.sourceId && digest(artifact.content_markdown) === provenance.contentHash ? 'current' : 'unverified'
  }

  private historyState(provenance: GraphProvenance, row: { snapshot_json: string; version: number; status: string }): GraphEdge['provenanceState'] {
    if (digest(row.snapshot_json) !== provenance.contentHash) return 'unverified'
    return provenance.revisionId === `${provenance.sourceId}@${row.version}` && !['superseded', 'retired', 'merged', 'rejected', 'withdrawn', 'fulfilled', 'closed'].includes(row.status) ? 'current' : 'stale'
  }

  private pruneNodes(): void {
    this.store.database.prepare(`DELETE FROM evidence_graph_nodes WHERE NOT EXISTS(SELECT 1 FROM evidence_graph_members WHERE node_id = evidence_graph_nodes.id)
      AND NOT EXISTS(SELECT 1 FROM evidence_graph_edges WHERE from_id = evidence_graph_nodes.id OR to_id = evidence_graph_nodes.id)`).run()
  }
}

import { createHash } from 'node:crypto'
import type { ProjectStore } from './project-store'
import { EvidenceGraphRepository, graphFileNodeId } from './evidence-graph'
import { graphNodeId, type GraphNodeType, type GraphProvenance, type GraphScopeInput } from './evidence-graph-contracts'
import { inspectKnowledgeReference } from './knowledge-references'
import type { KnowledgeRecord, KnowledgeReference } from './knowledge-record-contracts'
import type { ProjectEntity } from './project-directory-contracts'

type ScopeNode = GraphScopeInput['nodes'][number]

/** Project only owner-declared references; reference presence does not imply ownership, causality or agreement. */
export function projectStructuredKnowledgeGraph(store: ProjectStore, value: KnowledgeRecord | ProjectEntity): void {
  const record = 'title' in value
  const type: GraphNodeType = record ? value.kind : value.kind
  const label = record ? value.title : value.displayName
  const sourceNode = graphNodeId(type, value.id)
  const history = store.database.prepare(record
    ? 'SELECT snapshot_json FROM knowledge_record_history WHERE record_id=? AND version=?'
    : "SELECT snapshot_json FROM project_entity_history WHERE entity_id=? AND json_extract(snapshot_json,'$.version')=? ORDER BY id DESC LIMIT 1").get(value.id, value.version) as { snapshot_json: string }
  const revisionId = `${value.id}@${value.version}`
  const provenance: GraphProvenance = { sourceId: value.id, revisionId, contentHash: createHash('sha256').update(history.snapshot_json).digest('hex'), locator: value.locator }
  const nodes: ScopeNode[] = [{ type, reference: value.id, label, resolved: record ? value.readiness !== 'historical' : value.status === 'active' }]
  const edges: GraphScopeInput['edges'] = []
  for (const reference of value.references) {
    const inspected = inspectKnowledgeReference(store, reference)
    const target = referenceNode(store, reference)
    target.resolved = target.resolved !== false && inspected?.code !== 'broken_reference'
    nodes.push(target)
    const citation = reference.kind === 'source' && inspected?.code !== 'broken_reference' ? reference.citation : undefined
    edges.push({ from: sourceNode, to: graphNodeId(target.type, target.reference), type: 'mentions', basis: 'declared', provenance: citation ? {
      sourceId: citation.sourceId, revisionId: citation.revisionId, contentHash: citation.contentHash, locator: citation.locator, passageId: citation.passageId
    } : provenance })
  }
  const replacementId = record ? value.supersededBy : value.mergedInto
  if (replacementId) {
    const replacement = referenceNode(store, { kind: record ? 'record' : 'entity', id: replacementId })
    nodes.push(replacement)
    edges.push({ from: graphNodeId(replacement.type, replacement.reference), to: sourceNode, type: 'supersedes', basis: 'declared', provenance })
  }
  new EvidenceGraphRepository(store).replaceScope({ scopeKey: `structured:${value.id}`, revisionId, nodes: [...new Map(nodes.map((node) => [graphNodeId(node.type, node.reference), node])).values()], edges })
}

function referenceNode(store: ProjectStore, reference: KnowledgeReference): ScopeNode {
  if (reference.kind === 'source') {
    const source = store.database.prepare('SELECT title FROM source_catalog WHERE id=?').get(reference.citation.sourceId) as { title: string } | undefined
    return { type: 'source', reference: reference.citation.sourceId, label: source?.title ?? reference.citation.sourceId, resolved: Boolean(source) }
  }
  if (reference.kind === 'file') return { type: graphFileNodeId(reference.path).startsWith('test:') ? 'test' : 'file', reference: reference.path, label: reference.path.slice(0, 1000) }
  if (reference.kind === 'wiki') return { type: 'wiki', reference: reference.slug, label: reference.slug }
  if (reference.kind === 'work_item') {
    const task = store.database.prepare('SELECT title FROM work_items WHERE id=?').get(reference.id) as { title: string } | undefined
    return { type: 'task', reference: reference.id, label: task?.title ?? reference.id, resolved: Boolean(task) }
  }
  if (reference.kind === 'record') {
    const record = store.database.prepare('SELECT kind,title,status FROM knowledge_records WHERE id=?').get(reference.id) as { kind: KnowledgeRecord['kind']; title: string; status: KnowledgeRecord['status'] } | undefined
    return { type: record?.kind ?? 'source', reference: reference.id, label: record?.title ?? reference.id, resolved: Boolean(record) && !['superseded', 'rejected', 'withdrawn', 'fulfilled', 'closed'].includes(record!.status) }
  }
  const entity = store.database.prepare('SELECT kind,display_name,status FROM project_entities WHERE id=?').get(reference.id) as { kind: ProjectEntity['kind']; display_name: string; status: ProjectEntity['status'] } | undefined
  return { type: entity?.kind ?? 'source', reference: reference.id, label: entity?.display_name ?? reference.id, resolved: entity?.status === 'active' }
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { EvidenceGraphRepository } from '../../src/core/evidence-graph'
import { graphNodeId } from '../../src/core/evidence-graph-contracts'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { WorkItemRepository } from '../../src/core/work-items'

const stores: ProjectStore[] = []
const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-structured-graph-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Structured graph' })
  stores.push(store)
  return { root, store, catalog: new SourceCatalogRepository(store), records: new KnowledgeRecordsRepository(store), directory: new ProjectDirectoryRepository(store), graph: new EvidenceGraphRepository(store) }
}

describe('structured knowledge graph projection', () => {
  it('projects declared component and source references with immutable native and passage provenance', async () => {
    const { root, store, catalog, records, directory, graph } = await fixture()
    await writeFile(path.join(root, 'queue.ts'), 'export class Queue {}')
    const entity = directory.create({ kind: 'component', displayName: 'Queue', definition: 'Durable jobs.', references: [{ kind: 'file', path: 'queue.ts' }] })
    const source = catalog.registerSource({ kind: 'manual', title: 'Design', canonicalUri: 'manual://design' })
    catalog.publishRevision({ sourceId: source.id, original: 'Queue work survives restarts.' })
    const citation = catalog.search('Queue')[0].citation
    const record = records.create({ kind: 'decision', status: 'accepted', title: 'Use durable jobs', markdown: 'Retain work in SQLite.', references: [{ kind: 'source', citation }, { kind: 'entity', id: entity.id }] })
    const result = graph.query({ nodeId: graphNodeId('decision', record.id), depth: 2 })
    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([graphNodeId('component', entity.id), 'file:queue.ts', graphNodeId('source', source.id)]))
    expect(result.edges.every((edge) => edge.type === 'mentions' && edge.basis === 'declared')).toBe(true)
    expect(result.edges.every((edge) => edge.provenanceState === 'current')).toBe(true)
    expect(result.edges.find((edge) => edge.to === graphNodeId('source', source.id))?.provenance).toMatchObject({ sourceId: source.id, revisionId: citation.revisionId, passageId: citation.passageId, locator: citation.locator })
    const native = result.edges.find((edge) => edge.to === graphNodeId('component', entity.id))!.provenance
    expect(native.revisionId).toBe(`${record.id}@1`)
    store.database.prepare("UPDATE knowledge_record_history SET snapshot_json=snapshot_json || ' ' WHERE record_id=? AND version=1").run(record.id)
    expect(graph.query({ nodeId: graphNodeId('decision', record.id) }).edges.find((edge) => edge.provenance.sourceId === record.id)?.provenanceState).toBe('unverified')
  })

  it('replaces relationships on edits and retains missing references as unresolved placeholders', async () => {
    const { records, directory, graph } = await fixture()
    const first = directory.create({ kind: 'component', displayName: 'Queue', definition: 'Jobs.' })
    const second = directory.create({ kind: 'term', displayName: 'Lease', definition: 'Ownership duration.' })
    const record = records.create({ kind: 'risk', title: 'Expired owners', markdown: 'Late owners can publish.', references: [{ kind: 'entity', id: first.id }, { kind: 'file', path: 'missing.ts' }] })
    let result = graph.query({ nodeId: graphNodeId('risk', record.id) })
    expect(result.nodes.find((node) => node.id === 'file:missing.ts')?.resolved).toBe(false)
    expect(result.edges.find((edge) => edge.to === 'file:missing.ts')?.unresolved).toBe(true)
    records.update(record.id, { expectedVersion: record.version, references: [{ kind: 'entity', id: second.id }] })
    result = graph.query({ nodeId: graphNodeId('risk', record.id) })
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].to).toBe(graphNodeId('term', second.id))
    expect(result.revisions[0].revisionId).toBe(`${record.id}@2`)
  })

  it('uses supersedes only for actual decision replacements and entity merges', async () => {
    const { records, directory, graph } = await fixture()
    const original = records.create({ kind: 'decision', status: 'accepted', title: 'Old choice', markdown: 'Previous design.' })
    const replacement = records.create({ kind: 'decision', status: 'accepted', title: 'New choice', markdown: 'New design.' })
    records.supersede(original.id, replacement.id, 'owner', 'Replace old guidance.')
    expect(graph.query({ nodeId: graphNodeId('decision', replacement.id) }).edges).toEqual([expect.objectContaining({ from: graphNodeId('decision', replacement.id), to: graphNodeId('decision', original.id), type: 'supersedes', basis: 'declared' })])
    const oldEntity = directory.create({ kind: 'component', displayName: 'Queue', definition: 'Queue.' })
    const newEntity = directory.create({ kind: 'component', displayName: 'Worker Queue', definition: 'Canonical queue.' })
    directory.merge(oldEntity.id, newEntity.id, { expectedSourceVersion: oldEntity.version, expectedTargetVersion: newEntity.version, actor: 'owner', reason: 'Duplicate names.' })
    expect(graph.query({ nodeId: graphNodeId('component', newEntity.id) }).edges).toEqual([expect.objectContaining({ from: graphNodeId('component', newEntity.id), to: graphNodeId('component', oldEntity.id), type: 'supersedes' })])
  })
  it('distinguishes live file, article and task evidence from unresolved reference placeholders', async () => {
    const { root, store, catalog, records, graph } = await fixture()
    await writeFile(path.join(root, 'queue.test.ts'), 'describe("queue", () => {})')
    const task = new WorkItemRepository(store).create({ title: 'Verify the queue' })
    new KnowledgeRepository(store).saveWikiArticle('queue', 'Queue implementation evidence.')
    const citation = catalog.search('Queue')[0].citation
    const record = records.create({ kind: 'requirement', status: 'active', title: 'Verified queue', markdown: 'Keep test evidence and unresolved links visible.', references: [
      { kind: 'file', path: 'queue.test.ts' },
      { kind: 'wiki', slug: 'queue' },
      { kind: 'work_item', id: task.id },
      { kind: 'work_item', id: 'missing-task' },
      { kind: 'source', citation: { ...citation, sourceId: 'missing-source' } },
      { kind: 'record', id: 'missing-record' },
      { kind: 'entity', id: 'missing-entity' }
    ] })
    const result = graph.query({ nodeId: graphNodeId('requirement', record.id) })
    expect(result.nodes.find((node) => node.id === 'test:queue.test.ts')).toMatchObject({ type: 'test', resolved: true })
    expect(result.nodes.find((node) => node.id === `task:${task.id}`)).toMatchObject({ label: task.title, resolved: true })
    expect(result.nodes.find((node) => node.id === 'wiki:queue')).toMatchObject({ resolved: true })
    expect(result.nodes.find((node) => node.id === 'task:missing-task')).toMatchObject({ label: 'missing-task', resolved: false })
    for (const id of ['missing-record', 'missing-entity', 'missing-source']) {
      expect(result.nodes.find((node) => node.id === graphNodeId('source', id))).toMatchObject({ label: id, resolved: false })
      expect(result.edges.find((edge) => edge.to === graphNodeId('source', id))).toMatchObject({ unresolved: true, basis: 'declared' })
    }
  })
})

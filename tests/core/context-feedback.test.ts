import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { ContextFeedbackRepository } from '../../src/core/context-feedback'
import { WorkItemRepository } from '../../src/core/work-items'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { FrozenClock } from '../../src/core/clock'

const stores: ProjectStore[] = []
const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-feedback-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Feedback' })
  stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00.000Z'))
  const task = new WorkItemRepository(store).create({ title: 'Implement queue recovery' })
  const catalog = new SourceCatalogRepository(store)
  const source = catalog.registerSource({ kind: 'manual', title: 'Queue', canonicalUri: 'manual://queue' })
  const revision = catalog.publishRevision({ sourceId: source.id, original: 'Queue preserves unfinished jobs.' })
  const packetId = `packet:${task.id}`
  store.database.prepare('INSERT INTO context_packets (id,work_item_id,version,created_at,fingerprint,packet_json) VALUES (?,?,1,?,?,?)')
    .run(packetId, task.id, clock.now().toISOString(), 'fixture-fingerprint', JSON.stringify({ id: packetId, projectId: store.project.id, workItemId: task.id, manifest: [{ sourceId: source.id, revisionId: revision.id }] }))
  return { store, task, catalog, source, revision, packetId, feedback: new ContextFeedbackRepository(store, clock) }
}

describe('context quality feedback', () => {
  it('captures task, packet and exact old/current source references without accepting an agent assertion', async () => {
    const { store, task, catalog, source, revision, packetId, feedback } = await fixture()
    const newer = catalog.publishRevision({ sourceId: source.id, original: 'Queue now checkpoints fenced ownership.' })
    const report = feedback.create({ workItemId: task.id, packetId, category: 'missing_context', note: 'The packet omitted checkpoint recovery.', sourceIds: [source.id, source.id], actor: 'agent-42', authorKind: 'agent' })
    expect(report).toMatchObject({ status: 'proposed', authorKind: 'agent', trust: 'untrusted_reference', sourceReferences: [{ sourceId: source.id, revisionId: newer.id, packetRevisionId: revision.id }] })
    expect(new KnowledgeRecordsRepository(store).list({ includeHistorical: true })).toEqual([])
    expect(feedback.list({ packetId })).toEqual([report])
    expect(feedback.history(report.id)[0].snapshot).toEqual(report)
  })
  it('triages into an independently reviewed correction or fixture with an immutable audit trail', async () => {
    const { store, task, packetId, feedback } = await fixture()
    const report = feedback.create({ workItemId: task.id, packetId, category: 'incorrect_context', note: 'Ownership wording is ambiguous.', actor: 'owner', authorKind: 'human' })
    const triaged = feedback.triage(report.id, { expectedVersion: report.version, status: 'triaged', action: 'fixture', actor: 'reviewer', note: 'Add an acronym and ownership ambiguity fixture.' })
    expect(() => feedback.triage(report.id, { expectedVersion: 1, status: 'dismissed', action: 'no_change', actor: 'other-reviewer', note: 'Stale edit.' })).toThrow('changed')
    expect(() => feedback.triage(report.id, { expectedVersion: triaged.version, status: 'resolved', action: 'knowledge_correction', actor: 'reviewer', note: 'Claiming an undocumented repair.' })).toThrow('link the fixture')
    const resolved = feedback.triage(report.id, { expectedVersion: triaged.version, status: 'resolved', action: 'fixture', target: 'context-evaluation/corpus.v2.json#acronym-ownership', actor: 'reviewer', note: 'Fixture added and reviewed in the linked revision.' })
    expect(resolved).toMatchObject({ status: 'resolved', action: 'fixture', version: 3 })
    expect(feedback.history(report.id).map((event) => event.snapshot.status)).toEqual(['resolved', 'triaged', 'proposed'])
    expect(new KnowledgeRecordsRepository(store).list({ includeHistorical: true })).toEqual([])
  })
  it('rejects mismatched task, packet and foreign source identities', async () => {
    const first = await fixture()
    const second = await fixture()
    const input = { workItemId: first.task.id, packetId: first.packetId, category: 'missing_context' as const, note: 'Missing project source.', actor: 'agent', authorKind: 'agent' as const }
    expect(() => second.feedback.create(input)).toThrow('work item in this project')
    expect(() => first.feedback.create({ ...input, packetId: second.packetId })).toThrow('packet must belong')
    expect(() => first.feedback.create({ ...input, sourceIds: [second.source.id] })).toThrow('source IDs must belong')
    const otherTask = new WorkItemRepository(first.store).create({ title: 'Unrelated task' })
    expect(() => first.feedback.create({ ...input, workItemId: otherTask.id })).toThrow('packet must belong')
    expect(first.feedback.list()).toEqual([])
  })
  it('keeps historical feedback after task deletion and redacts report/triage credentials', async () => {
    const { store, task, packetId, feedback } = await fixture()
    const report = feedback.create({ workItemId: task.id, packetId, category: 'other', note: 'api_key=supersecret', actor: 'agent', authorKind: 'agent' })
    expect(report.note).not.toContain('supersecret')
    const dismissed = feedback.triage(report.id, { expectedVersion: report.version, status: 'dismissed', action: 'no_change', actor: 'owner', note: 'token=notacredential but api_key=secretvalue is private.' })
    expect(dismissed.triageNote).not.toContain('secretvalue')
    new WorkItemRepository(store).delete(task.id)
    expect(feedback.get(report.id).packetId).toBe(packetId)
    expect(feedback.list({ workItemId: task.id })).toHaveLength(1)
  })
  it('filters reports and preserves missing packet-source context as explicit nulls', async () => {
    const { task, catalog, packetId, feedback } = await fixture()
    const unindexed = catalog.registerSource({ kind: 'manual', title: 'Not imported yet', canonicalUri: 'manual://unindexed' })
    const report = feedback.create({ workItemId: task.id, packetId, category: 'stale_context', sourceIds: [unindexed.id], note: 'This source is not in the captured packet.', actor: 'owner', authorKind: 'human' })
    expect(report.sourceReferences).toEqual([{ sourceId: unindexed.id, revisionId: null, packetRevisionId: null }])
    expect(feedback.list({ status: 'proposed', workItemId: task.id, packetId, limit: 1 })).toEqual([report])
    expect(feedback.list({ status: 'resolved' })).toEqual([])
    expect(() => feedback.triage(report.id, { expectedVersion: 1, status: 'dismissed', action: 'fixture', actor: 'owner', note: 'Contradictory disposition.' })).toThrow('Dismissed feedback')
    expect(feedback.history(report.id)).toHaveLength(1)
    expect(() => feedback.get('missing-report')).toThrow('does not exist')
  })
  it('rejects a persisted packet whose project identity disagrees with its task row', async () => {
    const { store, task, packetId, feedback } = await fixture()
    store.database.prepare("UPDATE context_packets SET packet_json=json_set(packet_json,'$.projectId',?) WHERE id=?").run('another-project', packetId)
    expect(() => feedback.create({ workItemId: task.id, packetId, category: 'other', note: 'Investigate packet identity.', actor: 'owner', authorKind: 'human' })).toThrow('different project')
    expect(feedback.list()).toEqual([])
  })
})

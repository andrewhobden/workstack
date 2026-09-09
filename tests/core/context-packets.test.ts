import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
import { ContextPacketRepository, renderContextPacket } from '../../src/core/context-packets'
import { ArtifactStore } from '../../src/core/artifact-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { KnowledgeRecordsRepository } from '../../src/core/knowledge-records'
import { KnowledgeRetrievalService } from '../../src/core/knowledge-retrieval'
import { TaskDependenciesRepository } from '../../src/core/task-dependencies'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { EvidenceGraphRepository } from '../../src/core/evidence-graph'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { FrozenClock } from '../../src/core/clock'
import type { ContextPolicyInput } from '../../src/core/context-packet-contracts'
import type { KnowledgeReference } from '../../src/core/knowledge-record-contracts'

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => { vi.restoreAllMocks(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-packet-')); roots.push(root)
  const clock = new FrozenClock(new Date('2026-09-09T08:00:00Z'))
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Packet project', description: 'A local task coordinator.' }); stores.push(store)
  const work = new WorkItemRepository(store, { clock })
  const item = work.create({ title: 'Add durable indexing', descriptionMarkdown: 'Store every revision.', acceptanceCriteriaMarkdown: 'The exact source revision opens.' })
  const packets = new ContextPacketRepository(store, { clock })
  const catalog = new SourceCatalogRepository(store, { clock })
  const claims = new ClaimsRepository(store, { clock })
  return { root, store, work, item, packets, catalog, clock, claims }
}
const policy = (patch: Partial<ContextPolicyInput> = {}): ContextPolicyInput => ({ expectedVersion: 0, requirements: [{ category: 'task', severity: 'hard' }], sourcePins: [], requiredRecordIds: [], allowSoftOverride: false, tokenBudget: 12000, operatorInstructions: '', ...patch })

describe('immutable task context and readiness', () => {
  it('keeps long requirements complete, budgets multilingual excerpts, and saves exact claim receipts', async () => {
    const { store, work, item, packets, claims } = await fixture()
    const description = '完整需求 🚀\n'.repeat(9000) + 'FINAL NONNEGOTIABLE REQUIREMENT'
    work.update(item.id, { descriptionMarkdown: description })
    packets.updatePolicy(policy({ tokenBudget: 4000, operatorInstructions: '操作说明'.repeat(500) }))
    const packet = await packets.preview(item.id)
    expect(packet.canExecute).toBe(true)
    expect(packet.sections.find((section) => section.category === 'task')?.markdown).toContain(description)
    expect(packet.budget.used).toBeLessThanOrEqual(packet.budget.limit)
    expect(packet.budget.omissions).toContainEqual(expect.objectContaining({ category: 'task' }))
    expect(packet.launchMarkdown).toContain('Read ALL required sections')
    let restored = ''; let offset: number | null = 0
    while (offset !== null) { const read = packets.readSection(packet.id, 'task', offset, 7777); restored += read.text; offset = read.nextOffset }
    expect(restored).toContain(description)
    const receipt = claims.claim(item.id, { agentId: 'worker', contextPacketId: packet.id })
    expect(receipt.contextPacketId).toBe(packet.id)
    expect(packets.listUsage(packet.id)).toMatchObject([{ state: 'started', kind: 'claim', claimId: receipt.claim.id, actor: 'worker' }])
    expect(store.database.prepare('SELECT count(*) AS n FROM context_packets').get()).toEqual({ n: 1 })
  })

  it('retains exact source passages and historical artifacts after their live counterparts change', async () => {
    const { store, item, packets, catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Setup', canonicalUri: 'manual://setup' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: '# Setup\nRun npm test.\n\n## Validation\nCheck durability.' })
    const attached = new ArtifactStore(store).attachBytes(item.id, { originalFilename: 'requirements.txt', data: Buffer.from('Original task artifact') })
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [{ sourceId: source.id, category: 'conventions' }], excludedSourceIds: [] })
    const packet = await packets.preview(item.id)
    expect(packet.manifest).toContainEqual(expect.objectContaining({ sourceId: source.id, revisionId: revision.id }))
    const citation = packet.sections.find((section) => section.category === 'conventions')!.citations[0]
    expect(catalog.readCitation(citation).passage.text).toContain('Run npm test.')
    catalog.publishRevision({ sourceId: source.id, original: '# Setup\nRun a different command.' })
    new ArtifactStore(store).remove(item.id, attached.id)
    expect(packets.get(packet.id)).toEqual(packet)
    expect(Buffer.from(packets.readArtifact(packet.id, attached.id).dataBase64, 'base64').toString()).toBe('Original task artifact')
    expect(packets.readArtifact(packet.id, attached.id, 4, 3)).toMatchObject({ nextOffset: 7, totalBytes: 22 })
    expect(catalog.listInvalidations()).toContainEqual(expect.objectContaining({ artifactKind: 'context_packet', artifactId: packet.id }))
    expect(() => packets.revalidate(packet.id)).toThrow('changed after this preview')
  })

  it('makes missing or modified mandatory artifacts block before task ownership changes', async () => {
    const { store, item, packets, claims } = await fixture()
    const artifacts = new ArtifactStore(store)
    const attachment = artifacts.attachBytes(item.id, { originalFilename: 'brief.md', data: Buffer.from('Original') })
    await writeFile(artifacts.resolvePath(item.id, attachment.id), 'Tampered')
    const changed = packets.prepareLexical(item.id)
    expect(changed.canExecute).toBe(false)
    expect(changed.gaps).toContainEqual(expect.objectContaining({ category: 'artifacts', severity: 'hard' }))
    expect(() => claims.claim(item.id, { agentId: 'worker' })).toThrow('Attachment brief.md')
    expect(new WorkItemRepository(store).get(item.id).status).toBe('backlog')
    expect(claims.getActive(item.id)).toBeUndefined()
    await rm(artifacts.resolvePath(item.id, attachment.id))
    const missing = packets.prepareLexical(item.id)
    expect(missing.artifacts[0].available).toBe(false)
    expect(() => packets.readArtifact(missing.id, attachment.id)).toThrow('unavailable')
  })

  it('rejects stale previews for task, source, policy and preference changes while preserving history', async () => {
    const { packets, work, item, catalog } = await fixture()
    const first = packets.prepareLexical(item.id)
    work.update(item.id, { title: 'A revised task' })
    expect(() => packets.prepareLexical(item.id, { packetId: first.id })).toThrow('changed after this preview')
    const second = packets.prepareLexical(item.id)
    const source = catalog.registerSource({ kind: 'manual', title: 'Guide', canonicalUri: 'manual://guide' })
    catalog.publishRevision({ sourceId: source.id, original: 'A revised task guide.' })
    expect(() => packets.revalidate(second.id)).toThrow('changed after this preview')
    const third = packets.prepareLexical(item.id)
    packets.updatePolicy(policy())
    expect(() => packets.revalidate(third.id)).toThrow('changed after this preview')
    const fourth = packets.prepareLexical(item.id)
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: [source.id] })
    expect(() => packets.revalidate(fourth.id)).toThrow('changed after this preview')
    expect(packets.list(item.id).map((packet) => packet.version)).toEqual([4, 3, 2, 1])
    expect(packets.get(first.id).previousPacketId).toBeNull()
    expect(packets.get(second.id).previousPacketId).toBe(first.id)
  })

  it('requires configured soft override reasons and never overrides hard source failures', async () => {
    const { item, packets, catalog, clock } = await fixture()
    packets.updatePolicy(policy({ requirements: [{ category: 'conventions', severity: 'soft' }], allowSoftOverride: true }))
    const preview = packets.prepareLexical(item.id)
    expect(preview.readiness).toBe('needs_attention')
    expect(() => packets.assertReady(preview)).toThrow('explicit reason')
    const approved = packets.prepareLexical(item.id, { packetId: preview.id, softOverrideReason: 'The operator will provide setup instructions during the session.' })
    expect(approved.canExecute).toBe(true)
    expect(approved.previousPacketId).toBe(preview.id)
    expect(packets.get(preview.id).canExecute).toBe(false)
    expect(packets.prepareLexical(item.id, { packetId: approved.id, softOverrideReason: approved.softOverrideReason! })).toEqual(approved)
    const source = catalog.registerSource({ kind: 'manual', title: 'Mandatory architecture', canonicalUri: 'manual://architecture', policy: 'tracked_content', refreshSeconds: 60 })
    catalog.publishRevision({ sourceId: source.id, original: 'Index durable revisions.' })
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [{ sourceId: source.id, category: 'architecture' }], excludedSourceIds: [] })
    clock.advance(61_000)
    const stale = packets.prepareLexical(item.id, { softOverrideReason: 'Still go ahead' })
    expect(stale.canExecute).toBe(false)
    expect(stale.gaps).toContainEqual(expect.objectContaining({ sourceId: source.id, severity: 'hard' }))
  })

  it('shows pinned-source exclusion, partial sources, empty revisions and missing records as actionable blockers', async () => {
    const { packets, item, catalog, store } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Required guidance', canonicalUri: 'manual://required' })
    catalog.publishRevision({ sourceId: source.id, original: 'Partial guidance', outcome: 'partial' })
    packets.updatePolicy(policy({ sourcePins: [{ sourceId: source.id, category: 'architecture' }, { sourceId: 'missing', category: 'conventions' }], requiredRecordIds: ['record:missing'] }))
    let packet = packets.prepareLexical(item.id)
    expect(packet.canExecute).toBe(false)
    expect(packet.gaps).toContainEqual(expect.objectContaining({ sourceId: source.id, severity: 'hard' }))
    catalog.publishRevision({ sourceId: source.id, original: 'Complete guidance' })
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [{ sourceId: source.id, category: 'architecture' }], excludedSourceIds: [source.id] })
    packet = packets.prepareLexical(item.id)
    expect(packet.gaps.some((gap) => gap.reason.includes('excluded'))).toBe(true)
    expect(packet.manifest).toEqual([])
    packets.updatePreferences(item.id, { expectedVersion: 1, sourcePins: [], excludedSourceIds: [] })
    store.database.prepare('DELETE FROM source_passages WHERE source_id=?').run(source.id)
    expect(packets.prepareLexical(item.id).gaps.some((gap) => gap.reason.includes('no readable passage'))).toBe(true)
  })

  it('respects record lifecycle and evidence exclusions, and retains the latest same-time checkpoint', async () => {
    const { packets, item, store, catalog, claims, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Durable indexing guide', canonicalUri: 'manual://indexing' })
    catalog.publishRevision({ sourceId: source.id, original: 'Durable indexing must preserve exact revisions.' })
    const citation = catalog.search('indexing')[0].citation
    const record = new KnowledgeRecordsRepository(store, { clock }).create({ kind: 'decision', title: 'Durable indexing choice', markdown: 'Keep append-only evidence.', status: 'accepted', references: [{ kind: 'source', citation }] })
    packets.updatePolicy(policy({ requiredRecordIds: [record.id] }))
    const claim = claims.claim(item.id, { agentId: 'agent' })
    claims.saveCheckpoint(item.id, claim.claimToken, { progressMarkdown: 'First checkpoint.' })
    const latest = claims.saveCheckpoint(item.id, claim.claimToken, { progressMarkdown: 'Latest checkpoint.', questionsMarkdown: 'A remaining decision.' })
    claims.release(item.id, claim.claimToken)
    const packet = packets.prepareLexical(item.id)
    expect(packet.sections.find((section) => section.category === 'checkpoint')?.markdown).toContain(latest.id)
    expect(packet.sections.find((section) => section.category === 'decisions')?.markdown).toContain('append-only')
    expect(packet.manifest).toContainEqual(expect.objectContaining({ sourceId: source.id }))
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: [source.id] })
    expect(packets.prepareLexical(item.id).gaps).toContainEqual(expect.objectContaining({ recordId: record.id, severity: 'hard' }))
  })

  it('checks prerequisites and configured empty categories using the same claim rules', async () => {
    const { packets, item, work, store, claims } = await fixture()
    const dependency = work.create({ title: 'Prerequisite' })
    new TaskDependenciesRepository(store).update(item.id, { dependsOn: [dependency.id] })
    packets.updatePolicy(policy({ requirements: [{ category: 'repository', severity: 'hard' }, { category: 'artifacts', severity: 'soft' }] }))
    const packet = packets.prepareLexical(item.id)
    expect(packet.gaps).toContainEqual(expect.objectContaining({ category: 'related_work', severity: 'hard' }))
    expect(packet.gaps).toContainEqual(expect.objectContaining({ category: 'repository', severity: 'hard' }))
    expect(() => claims.claim(item.id, { agentId: 'worker', contextPacketId: packet.id })).toThrow('Unresolved prerequisites')
    expect(claims.getActive(item.id)).toBeUndefined()
  })

  it('rejects asynchronous changes during retrieval and malformed workspace mappings', async () => {
    const { packets, work, item, store } = await fixture()
    const original = KnowledgeRetrievalService.prototype.retrieve
    vi.spyOn(KnowledgeRetrievalService.prototype, 'retrieve').mockImplementation(async function (this: KnowledgeRetrievalService, query, options) {
      work.update(item.id, { acceptanceCriteriaMarkdown: 'Changed while retrieval ran.' })
      return original.call(this, query, options)
    })
    await expect(packets.preview(item.id)).rejects.toThrow('changed after this preview')
    expect(packets.list(item.id)).toEqual([])
    await mkdir(path.join(store.paths.workstackPath, 'workspaces'))
    await writeFile(path.join(store.paths.workstackPath, 'workspaces', `${item.id}.json`), '{}')
    expect(() => packets.prepareLexical(item.id)).toThrow('workspace mapping')
  })

  it('fences settings revisions, packet IDs, reads, and finalized launch receipts', async () => {
    const { packets, item } = await fixture()
    expect(() => packets.updatePolicy(policy({ requirements: [{ category: 'task', severity: 'hard' }, { category: 'task', severity: 'soft' }] }))).toThrow('once')
    packets.updatePolicy(policy())
    expect(() => packets.updatePolicy(policy())).toThrow('settings changed')
    const packet = packets.prepareLexical(item.id)
    expect(() => packets.prepareLexical(item.id, { packetId: packet.id, softOverrideReason: 'Override' })).toThrow('does not allow')
    expect(() => packets.get('missing')).toThrow('does not exist')
    expect(() => packets.readSection(packet.id, 'invalid' as never)).toThrow('section does not exist')
    expect(() => packets.readSection(packet.id, 'task', -1)).toThrow()
    expect(() => packets.readArtifact(packet.id, 'missing')).toThrow('unavailable')
    expect(() => packets.assertReady({ ...packet, projectId: 'foreign' })).toThrow('changed after this preview')
    expect(() => packets.recordUsage(packet.id, 'launch', ' ')).toThrow('actor is required')
    const usage = packets.recordUsage(packet.id, 'launch', 'operator', 'Exact launch prompt')
    packets.finishUsage(usage.id, 'failed', 'Terminal failed')
    expect(packets.listUsage(packet.id)[0]).toMatchObject({ state: 'failed', reason: 'Terminal failed', promptMarkdown: 'Exact launch prompt' })
    expect(() => packets.finishUsage(usage.id, 'started')).toThrow('already finalized')
    const started = packets.recordUsage(packet.id, 'restart', 'operator')
    packets.finishUsage(started.id, 'started')
    expect(packets.listUsage(packet.id)).toHaveLength(2)
    const rendered = renderContextPacket({ ...packet, sections: packet.sections.map((section) => ({ ...section, required: false })), gaps: [], preferences: { ...packet.preferences, excludedSourceIds: [] } })
    expect(rendered).toContain('None under configured policy')
  })

  it('derives independent override receipts with copied artifact bytes and source invalidation links', async () => {
    const { packets, item, store, catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Architecture', canonicalUri: 'manual://override' })
    catalog.publishRevision({ sourceId: source.id, original: 'Store immutable indexing revisions.' })
    const attachment = new ArtifactStore(store).attachBytes(item.id, { originalFilename: 'brief.txt', data: Buffer.from('Approved attachment') })
    packets.updatePolicy(policy({ allowSoftOverride: true, sourcePins: [{ sourceId: source.id, category: 'architecture' }], requirements: [{ category: 'conventions', severity: 'soft' }] }))
    const original = packets.prepareLexical(item.id)
    const derived = await packets.preview(item.id, { packetId: original.id, softOverrideReason: 'The maintainer will explain the test command.' })
    expect(derived.canExecute).toBe(true)
    expect(derived.sections.find((section) => section.category === 'artifacts')!.markdown).toContain(`context://${derived.id}/artifacts/${attachment.id}`)
    expect(derived.sections.map((section) => section.markdown).join('\n')).not.toContain(`context://${original.id}/`)
    expect(Buffer.from(packets.readArtifact(derived.id, attachment.id).dataBase64, 'base64').toString()).toBe('Approved attachment')
    catalog.publishRevision({ sourceId: source.id, original: 'A newer revision changes the design.' })
    expect(catalog.listInvalidations().filter((entry) => entry.artifactKind === 'context_packet').map((entry) => entry.artifactId)).toEqual(expect.arrayContaining([original.id, derived.id]))
    expect(packets.get(original.id)).toEqual(original)
    const { packets: strict, item: strictItem } = await fixture()
    await expect(strict.preview(strictItem.id, { softOverrideReason: 'Unconfigured approval' })).rejects.toThrow('does not allow')
    expect(strict.list(strictItem.id)).toEqual([])
  })

  it('omits proposed or excluded records and normalizes wiki exclusions across records and directory entries', async () => {
    const { packets, item, catalog, store, clock } = await fixture()
    const records = new KnowledgeRecordsRepository(store, { clock })
    const directory = new ProjectDirectoryRepository(store, { clock })
    new KnowledgeRepository(store).saveWikiArticle('indexing', 'Durable indexing guidance.')
    const sourceId = 'wiki:indexing'
    const citation = catalog.search('indexing')[0].citation
    const required = records.create({ kind: 'decision', title: 'Durable indexing required decision', markdown: 'Required proposal must not govern.', status: 'proposed' })
    const proposed = records.create({ kind: 'decision', title: 'Durable indexing proposal', markdown: 'Optional proposal must not govern.' })
    const wikiRecord = records.create({ kind: 'decision', title: 'Durable indexing wiki decision', markdown: 'Private excluded wiki rule.', status: 'accepted', references: [{ kind: 'wiki', slug: 'indexing' }] })
    const sourceRecord = records.create({ kind: 'decision', title: 'Durable indexing direct decision', markdown: 'Private excluded direct rule.', status: 'accepted', references: [{ kind: 'source', citation }] })
    directory.create({ kind: 'component', displayName: 'Wiki component', definition: 'Private excluded wiki definition.', references: [{ kind: 'wiki', slug: 'indexing' }] })
    directory.create({ kind: 'term', displayName: 'Source term', definition: 'Private excluded direct definition.', references: [{ kind: 'source', citation }] })
    directory.create({ kind: 'component', displayName: 'Task coordinator', definition: 'Included task definition.', references: [{ kind: 'work_item', id: item.id }] })
    packets.updatePolicy(policy({ requiredRecordIds: [required.id, wikiRecord.id] }))
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: [sourceId] })
    const packet = packets.prepareLexical(item.id)
    expect(packet.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: required.id, severity: 'hard', reason: expect.stringContaining('proposed') }),
      expect.objectContaining({ recordId: proposed.id, severity: 'soft' }),
      expect.objectContaining({ recordId: wikiRecord.id, severity: 'hard', reason: expect.stringContaining('excluded') }),
      expect.objectContaining({ recordId: sourceRecord.id, severity: 'info', reason: expect.stringContaining('excluded') })
    ]))
    const sections = packet.sections.map((section) => section.markdown).join('\n')
    expect(sections).not.toContain('Private excluded')
    expect(sections).not.toContain('proposal must not govern')
    expect(sections).toContain('Included task definition')
    expect(packet.manifest).toEqual([])
  })

  it('retains current record warnings without adding broken citations to the source manifest', async () => {
    const { packets, item, catalog, store, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Indexing evidence', canonicalUri: 'manual://records' })
    catalog.publishRevision({ sourceId: source.id, original: 'Durable indexing preserves revisions.' })
    const citation = catalog.search('indexing')[0].citation
    const records = new KnowledgeRecordsRepository(store, { clock })
    const broken = records.create({ kind: 'decision', title: 'Durable indexing broken citation', markdown: 'A visible decision needing repair.', status: 'accepted', references: [{ kind: 'source', citation: { ...citation, passageId: 'missing-passage' } }] })
    const required = records.create({ kind: 'requirement', title: 'Durable indexing required file', markdown: 'Restore the implementation specification.', status: 'active', references: [{ kind: 'file', path: 'missing-spec.md' }] })
    packets.updatePolicy(policy({ requiredRecordIds: [required.id] }))
    const packet = packets.prepareLexical(item.id)
    expect(packet.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: broken.id, sourceId: source.id, severity: 'soft' }),
      expect.objectContaining({ recordId: required.id, severity: 'hard' })
    ]))
    expect(packet.sections.find((section) => section.category === 'decisions')!.citations).toEqual([])
    expect(packet.canExecute).toBe(false)
  })

  it('applies lifecycle, exact citations and review findings to graph-selected records without lexical matches', async () => {
    const { root, packets, item, catalog, store, clock } = await fixture()
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src/quasar.ts'), 'export const quasar = true\n')
    const source = catalog.registerSource({ kind: 'manual', title: 'Zephyr', canonicalUri: 'manual://zephyr' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'Quasar dialect favors zephyr adapters.' })
    const citation = catalog.search('zephyr')[0].citation
    const records = new KnowledgeRecordsRepository(store, { clock })
    const record = records.create({ kind: 'decision', title: 'Quasar dialect', markdown: 'Prefer zephyr adapters.', status: 'proposed', references: [
      { kind: 'work_item', id: item.id }, { kind: 'file', path: 'src/quasar.ts' }, { kind: 'source', citation }
    ] })
    expect(records.search(`${item.title} ${item.descriptionMarkdown} ${item.acceptanceCriteriaMarkdown}`)).toEqual([])
    packets.updatePolicy(policy({ requirements: [{ category: 'code', severity: 'hard' }] }))
    const proposed = packets.prepareLexical(item.id)
    expect(proposed.canExecute).toBe(false)
    expect(proposed.sections.find((section) => section.category === 'code')!.state).toBe('missing')
    expect(proposed.sections.map((section) => section.markdown).join('\n')).not.toContain(record.markdown)
    expect(proposed.gaps).toContainEqual(expect.objectContaining({ recordId: record.id, severity: 'soft', reason: expect.stringContaining('proposed') }))
    expect(proposed.recordVersions).toContainEqual({ id: record.id, version: 1, status: 'proposed' })
    // Packet eligibility must not remove proposed relationships from historical navigation.
    expect(new EvidenceGraphRepository(store).query({ nodeId: `task:${item.id}`, depth: 2 }).edges).toHaveLength(3)
    records.update(record.id, { expectedVersion: 1, status: 'accepted' })
    const accepted = packets.prepareLexical(item.id)
    expect(accepted.canExecute).toBe(true)
    expect(accepted.sections.find((section) => section.category === 'code')!.markdown).toContain('src/quasar.ts')
    const decisions = accepted.sections.find((section) => section.category === 'decisions')!
    expect(decisions.markdown).toContain('(accepted, version 2)')
    expect(decisions.markdown).toContain(record.markdown)
    expect(decisions.citations).toEqual([citation])
    expect(accepted.recordVersions).toContainEqual({ id: record.id, version: 2, status: 'accepted' })
    expect(accepted.manifest).toContainEqual(expect.objectContaining({ sourceId: source.id, revisionId: revision.id }))
    expect(catalog.readCitation(decisions.citations[0]).passage.text).toContain('zephyr adapters')
    records.review(record.id, { actor: 'maintainer', note: 'Reconsider the adapter.', outcome: 'needs_changes' })
    const review = packets.prepareLexical(item.id)
    expect(review.canExecute).toBe(false)
    expect(review.gaps).toContainEqual(expect.objectContaining({ recordId: record.id, severity: 'soft', reason: 'The latest review requested changes.' }))
    expect(() => packets.revalidate(accepted.id)).toThrow('changed after this preview')
    expect(packets.get(proposed.id)).toEqual(proposed)
  })

  it.each([
    ['record', 'source'], ['record', 'wiki'], ['entity', 'source'], ['entity', 'wiki']
  ] as const)('omits %s graph relationships whose %s evidence is excluded', async (ownerKind, referenceKind) => {
    const { root, packets, item, catalog, store, clock } = await fixture()
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src/quasar.ts'), 'export const quasar = true\n')
    new KnowledgeRepository(store).saveWikiArticle('zephyr', 'Quasar dialect favors zephyr adapters.')
    const citation = catalog.search('zephyr')[0].citation
    const references: KnowledgeReference[] = [
      { kind: 'work_item', id: item.id }, { kind: 'file', path: 'src/quasar.ts' },
      referenceKind === 'wiki' ? { kind: 'wiki', slug: 'zephyr' } : { kind: 'source', citation }
    ]
    const owner = ownerKind === 'record'
      ? new KnowledgeRecordsRepository(store, { clock }).create({ kind: 'decision', title: 'Quasar dialect', markdown: 'Prefer zephyr adapters.', status: 'accepted', references: [...references] })
      : new ProjectDirectoryRepository(store, { clock }).create({ kind: 'component', displayName: 'Quasar dialect', definition: 'Prefer zephyr adapters.', references: [...references] })
    packets.updatePolicy(policy({ requirements: [{ category: 'code', severity: 'hard' }] }))
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: ['wiki:zephyr'] })
    const excluded = packets.prepareLexical(item.id)
    expect(excluded.canExecute).toBe(false)
    expect(excluded.sections.find((section) => section.category === 'code')!.state).toBe('missing')
    const sections = excluded.sections.map((section) => section.markdown).join('\n')
    expect(sections).not.toContain('Quasar dialect')
    expect(sections).not.toContain('Prefer zephyr adapters.')
    expect(sections).not.toContain(owner.id)
    expect(excluded.manifest).toEqual([])
    expect(excluded.gaps).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('explanation paths') }))
    expect(new EvidenceGraphRepository(store).query({ nodeId: `task:${item.id}`, depth: 2 }).edges).toHaveLength(3)
    packets.updatePreferences(item.id, { expectedVersion: 1, sourcePins: [], excludedSourceIds: [] })
    const included = packets.prepareLexical(item.id)
    expect(included.canExecute).toBe(true)
    expect(included.sections.find((section) => section.category === 'code')!.markdown).toContain(owner.id)
  })

  it('requires file or test evidence for the code category and reports stale and bounded graph paths', async () => {
    const { packets, item, catalog, store } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Topology', canonicalUri: 'manual://topology' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'Graph architecture declaration.' })
    const provenance = { sourceId: source.id, revisionId: revision.id, locator: revision.manifest.normalizedLocator, contentHash: revision.contentHash }
    const graph = new EvidenceGraphRepository(store)
    graph.replaceScope({ scopeKey: 'task-graph', revisionId: 'v1', nodes: [{ type: 'task', reference: item.id, label: item.title }, { type: 'component', reference: 'queue', label: 'Queue' }], edges: [{ from: `task:${item.id}`, to: 'component:queue', type: 'affects', basis: 'declared', provenance }] })
    packets.updatePolicy(policy({ requirements: [{ category: 'code', severity: 'hard' }] }))
    const metadata = packets.prepareLexical(item.id)
    expect(metadata.canExecute).toBe(false)
    expect(metadata.manifest).toContainEqual(expect.objectContaining({ sourceId: source.id, revisionId: revision.id }))
    expect(metadata.sections.find((section) => section.category === 'code')!.state).toBe('missing')
    expect(metadata.sections.find((section) => section.category === 'architecture')!.markdown).toContain('Queue')
    graph.replaceScope({ scopeKey: 'task-graph', revisionId: 'v2', truncated: true, nodes: [{ type: 'task', reference: item.id, label: item.title }, { type: 'file', reference: 'src/queue.ts', label: 'Queue implementation' }, { type: 'test', reference: 'tests/queue.test.ts', label: 'Queue contract' }], edges: [
      { from: `task:${item.id}`, to: 'file:src/queue.ts', type: 'affects', basis: 'declared', provenance },
      { from: 'test:tests/queue.test.ts', to: 'file:src/queue.ts', type: 'tests', basis: 'declared', provenance },
      { from: `task:${item.id}`, to: 'file:unknown.ts', type: 'affects', basis: 'inferred', provenance },
      { from: `task:${item.id}`, to: 'file:src/queue.ts', type: 'supports', basis: 'inferred', provenance: { ...provenance, sourceId: 'unverified' } }
    ] })
    const current = packets.prepareLexical(item.id)
    expect(current.canExecute).toBe(true)
    expect(current.sections.find((section) => section.category === 'code')!.markdown).toContain('Queue contract')
    expect(current.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('omitted') }), expect.objectContaining({ reason: expect.stringContaining('expansion limit') })]))
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: [source.id] })
    expect(packets.prepareLexical(item.id).canExecute).toBe(false)
    packets.updatePreferences(item.id, { expectedVersion: 1, sourcePins: [], excludedSourceIds: [] })
    catalog.publishRevision({ sourceId: source.id, original: 'Topology changed; old paths need review.' })
    expect(packets.prepareLexical(item.id).canExecute).toBe(false)
  })

  it('omits disconnected graph evidence and retains a valid declared-file route after excluding its task bridge', async () => {
    const { packets, item, catalog, store } = await fixture()
    const bridge = catalog.registerSource({ kind: 'manual', title: 'Task association', canonicalUri: 'manual://association' })
    const bridgeRevision = catalog.publishRevision({ sourceId: bridge.id, original: 'This association is optional evidence.' })
    const current = catalog.registerSource({ kind: 'manual', title: 'Topology', canonicalUri: 'manual://route' })
    const currentRevision = catalog.publishRevision({ sourceId: current.id, original: 'Module relationships.' })
    const provenance = (sourceId: string, revision: typeof currentRevision) => ({ sourceId, revisionId: revision.id, locator: revision.manifest.normalizedLocator, contentHash: revision.contentHash })
    new EvidenceGraphRepository(store).replaceScope({ scopeKey: 'route-regression', revisionId: 'v1', nodes: [
      { type: 'task', reference: item.id, label: item.title },
      { type: 'component', reference: 'queue', label: 'Queue component' },
      { type: 'file', reference: 'src/queue.ts', label: 'Queue module' }
    ], edges: [
      { from: `task:${item.id}`, to: 'component:queue', type: 'affects', basis: 'declared', provenance: provenance(bridge.id, bridgeRevision) },
      { from: 'component:queue', to: 'file:src/queue.ts', type: 'implements', basis: 'observed', provenance: provenance(current.id, currentRevision) }
    ] })
    packets.updatePolicy(policy({ requirements: [{ category: 'code', severity: 'hard' }] }))
    packets.updatePreferences(item.id, { expectedVersion: 0, sourcePins: [], excludedSourceIds: [bridge.id] })
    const disconnected = packets.prepareLexical(item.id)
    expect(disconnected.canExecute).toBe(false)
    expect(disconnected.sections.find((section) => section.category === 'code')!.state).toBe('missing')
    expect(disconnected.gaps).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('explanation paths') }))
    new TaskDependenciesRepository(store).update(item.id, { declaredPaths: ['src/queue.ts'] })
    const connected = packets.prepareLexical(item.id)
    const code = connected.sections.find((section) => section.category === 'code')!.markdown
    const graph = JSON.parse(code.slice(code.indexOf('{')))
    expect(connected.canExecute).toBe(true)
    expect(graph.seeds).toEqual([{ nodeId: 'file:src/queue.ts', reason: 'declared_path', reference: 'src/queue.ts' }])
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ direction: 'incoming', provenance: { sourceId: current.id }, origins: [{ seedId: 'file:src/queue.ts' }] })
    expect(graph.edges[0].path).toHaveLength(1)
    expect(graph.nodes.map((node: { id: string }) => node.id)).not.toContain(`task:${item.id}`)
    expect(connected.manifest).toContainEqual(expect.objectContaining({ sourceId: current.id, revisionId: currentRevision.id }))
    expect(connected.manifest.some((entry) => entry.sourceId === bridge.id)).toBe(false)
  })

  it('records retrieval limits, redactions, and category-specific legacy evidence with bounded launch output', async () => {
    const { packets, item, store, work } = await fixture()
    work.update(item.id, { descriptionMarkdown: 'Durable indexing needs api_key=fixture-secret-value' })
    const retrieval = new KnowledgeRetrievalService(store).retrieveLexical('indexing')
    const rows = ['Build commands', 'Risk assessment', 'README overview', 'src/index.ts', 'Architecture map'].map((title, index) => ({ sourceId: `legacy:${index}`, sourceType: 'raw_source' as const, title, excerpt: `Durable indexing evidence ${index}`, location: title, relevance: 1 }))
    vi.spyOn(KnowledgeRetrievalService.prototype, 'retrieveLexical').mockReturnValue({ ...retrieval, results: rows, truncated: true, fallbackReason: 'The selected model is incompatible.' })
    const packet = packets.prepareLexical(item.id)
    expect(packet.retrieval).toMatchObject({ truncated: true, queryTruncated: false, fallbackReason: 'The selected model is incompatible.' })
    expect(packet.retrieval.query).toContain('[REDACTED]')
    expect(JSON.stringify(packet)).not.toContain('fixture-secret-value')
    expect(packet.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'task', reason: expect.stringContaining('redacted') }), expect.objectContaining({ reason: expect.stringContaining('evidence limit') })]))
    for (const category of ['conventions', 'decisions', 'purpose', 'code', 'architecture']) expect(packet.sections.find((section) => section.category === category)!.markdown).toContain('Legacy evidence snapshot')
    const minimal = { ...packet, gaps: [], preferences: { ...packet.preferences, excludedSourceIds: [] } }
    expect(renderContextPacket(minimal)).toContain('None under configured policy')
    expect(minimal.budget.used).toBeLessThanOrEqual(minimal.budget.limit)
  })

  it('shows pending source repair actions and rejects inconsistent partial revision pointers', async () => {
    const { packets, item, catalog, store } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Required source', canonicalUri: 'manual://pending' })
    const partial = catalog.publishRevision({ sourceId: source.id, original: 'Partial mandatory guidance.', outcome: 'partial' })
    packets.updatePolicy(policy({ sourcePins: [{ sourceId: source.id, category: 'architecture' }] }))
    expect(packets.prepareLexical(item.id).gaps).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('Source conversion is partial.') }))
    // A recovered legacy catalog may have a ready pointer to an incomplete revision.
    store.database.prepare("UPDATE source_catalog SET state='ready',current_revision_id=? WHERE id=?").run(partial.id, source.id)
    expect(packets.prepareLexical(item.id).gaps).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('only partially available') }))
    catalog.queueImport(source.id, 'refresh-guidance')
    const pending = packets.prepareLexical(item.id)
    expect(pending.readiness).toBe('building')
    expect(pending.canExecute).toBe(false)
  })

  it('saves completion handoffs and incomplete repository diagnostics in packet history', async () => {
    const { packets, item, claims, store } = await fixture()
    const claim = claims.claim(item.id, { agentId: 'first-worker' })
    claims.saveCheckpoint(item.id, claim.claimToken, { progressMarkdown: 'Earlier work was interrupted.' })
    store.database.prepare('UPDATE work_checkpoints SET agent_id=NULL WHERE work_item_id=?').run(item.id)
    claims.complete(item.id, claim.claimToken, { summaryMarkdown: 'Implemented the storage adapter.', sessionSummaryMarkdown: 'The next task should inspect persistence.', knownLimitationsMarkdown: 'No remote model was tested.' })
    const complete = packets.prepareLexical(item.id)
    expect(complete.sections.find((section) => section.category === 'checkpoint')!.markdown).toContain('The next task should inspect persistence.')
    expect(complete.sections.find((section) => section.category === 'checkpoint')!.markdown).toContain('agent unknown')
    const invalid = packets.prepareLexical(item.id, {}, { kind: 'git', rootPath: store.project.rootPath, head: null, branch: null, workingTreeHash: '', complete: false, limitations: [] })
    expect(invalid.gaps).toContainEqual(expect.objectContaining({ category: 'repository', action: expect.stringContaining('Initialize') }))
  })

  it('expands declared file scope without a task graph node and preserves standalone component declarations', async () => {
    const { packets, item, store, catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Module graph', canonicalUri: 'manual://file-graph' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'The queue contract checks the queue module.' })
    const provenance = { sourceId: source.id, revisionId: revision.id, locator: revision.manifest.normalizedLocator, contentHash: revision.contentHash }
    new EvidenceGraphRepository(store).replaceScope({ scopeKey: 'file-imports', revisionId: 'v1', nodes: [{ type: 'file', reference: 'src/queue.ts', label: 'Queue module' }, { type: 'test', reference: 'tests/queue.test.ts', label: 'Queue contract' }], edges: [{ from: 'test:tests/queue.test.ts', to: 'file:src/queue.ts', type: 'tests', basis: 'observed', provenance }] })
    const scope = new TaskDependenciesRepository(store)
    scope.update(item.id, { declaredPaths: ['src/queue.ts'] })
    packets.updatePolicy(policy({ requirements: [{ category: 'code', severity: 'hard' }] }))
    const packet = packets.prepareLexical(item.id)
    expect(packet.canExecute).toBe(true)
    expect(packet.sections.find((section) => section.category === 'code')!.markdown).toContain('declared_path')
    expect(packet.sections.find((section) => section.category === 'code')!.markdown).toContain('Queue contract')
    expect(packet.sections.find((section) => section.category === 'related_work')!.markdown).toContain('src/queue.ts')
    expect(packet.manifest).toContainEqual(expect.objectContaining({ sourceId: source.id, revisionId: revision.id }))
    scope.update(item.id, { declaredPaths: [], declaredComponents: ['Queue coordinator'] })
    const components = packets.prepareLexical(item.id)
    expect(components.canExecute).toBe(false)
    expect(components.sections.find((section) => section.category === 'related_work')!.markdown).toContain('queue coordinator')
  })
})

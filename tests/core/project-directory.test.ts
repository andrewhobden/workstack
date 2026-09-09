import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { ProjectDirectoryRepository } from '../../src/core/project-directory'
import { FrozenClock } from '../../src/core/clock'
import { WorkItemRepository } from '../../src/core/work-items'

const stores: ProjectStore[] = []
const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-directory-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Directory' })
  stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00.000Z'))
  return { store, clock, catalog: new SourceCatalogRepository(store, { clock }), directory: new ProjectDirectoryRepository(store, { clock }) }
}

describe('project component and glossary directory', () => {
  it('resolves approved names, abbreviations and code identifiers without merging punctuation suggestions', async () => {
    const { directory } = await fixture()
    const queue = directory.create({ kind: 'component', displayName: 'QueueService', aliases: ['QS', 'queue_service', 'queue.service'], definition: 'The durable worker queue.' })
    for (const query of ['QueueService', 'qs', 'QUEUE_SERVICE', 'queue.service']) expect(directory.lookup(query)).toMatchObject({ match: 'exact', candidates: [{ id: queue.id }] })
    expect(directory.lookup('queue-service')).toMatchObject({ match: 'suggestion', candidates: [{ id: queue.id }] })
    const second = directory.create({ kind: 'component', displayName: 'Query Scheduler', aliases: ['QS'], definition: 'Schedules search queries.' })
    expect(directory.lookup('QS')).toMatchObject({ match: 'ambiguous' })
    expect(directory.lookup('QS').candidates.map((candidate) => candidate.id).sort()).toEqual([queue.id, second.id].sort())
    expect(directory.list()).toHaveLength(2)
  })

  it('keeps exact surface spellings, source revisions, offsets and task links on mentions', async () => {
    const { store, directory, catalog } = await fixture()
    const entry = directory.create({ kind: 'component', displayName: 'QueueService', aliases: ['QS', 'queue_service', 'queue.service'], definition: 'Durable queue.' })
    const task = new WorkItemRepository(store).create({ type: 'feature', title: 'Queue retry' })
    const source = catalog.registerSource({ kind: 'work_completion', title: 'Queue notes', canonicalUri: 'task://queue', workItemId: task.id })
    const text = '# Queue\nQS delegates to queue_service and QueueService. queue.service is an approved spelling.\nnotqueue_serviceSuffix is unrelated.'
    const revision = catalog.publishRevision({ sourceId: source.id, original: text })
    const detail = directory.detail(entry.id)
    expect(detail.mentions.map((mention) => mention.surface)).toEqual(['QS', 'queue_service', 'QueueService', 'queue.service'])
    for (const mention of detail.mentions) {
      expect(text.slice(mention.startOffset, mention.endOffset)).toBe(mention.surface)
      expect(mention).toMatchObject({ entityId: entry.id, resolution: 'resolved', historical: false, workItemId: task.id, citation: { sourceId: source.id, revisionId: revision.id } })
      expect(catalog.readCitation(mention.citation).passage.text).toContain(mention.surface)
    }
  })

  it('returns ambiguous source mentions as candidates until explicit owner resolution', async () => {
    const { directory, catalog } = await fixture()
    const first = directory.create({ kind: 'component', displayName: 'Queue Service', aliases: ['QS'], definition: 'Queue.' })
    const second = directory.create({ kind: 'component', displayName: 'Query Scheduler', aliases: ['QS'], definition: 'Scheduler.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Notes', canonicalUri: 'manual://notes' })
    catalog.publishRevision({ sourceId: source.id, original: 'QS handles background work.' })
    const mention = directory.mentions()[0]
    expect(mention).toMatchObject({ resolution: 'candidate', entityId: undefined })
    expect(mention.candidateIds.sort()).toEqual([first.id, second.id].sort())
    directory.resolveMention(mention.id, first.id, 'owner', 'The surrounding section describes the queue.')
    expect(directory.detail(first.id).mentions[0]).toMatchObject({ resolution: 'resolved', entityId: first.id })
    expect(directory.detail(second.id).mentions).toEqual([])
    directory.update(second.id, { expectedVersion: second.version, definition: 'Schedules user queries.' })
    expect(directory.mentions()[0]).toMatchObject({ resolution: 'resolved', entityId: first.id })
    directory.resolveMention(mention.id, null, 'owner', 'This usage is not a component reference.')
    expect(directory.mentions()[0].resolution).toBe('dismissed')
  })

  it('reconciles edited and deleted sources without stale current mentions or unrelated changes', async () => {
    const { directory, catalog } = await fixture()
    const queue = directory.create({ kind: 'component', displayName: 'Queue', definition: 'Durable queue.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Notes', canonicalUri: 'manual://notes' })
    const unrelated = catalog.registerSource({ kind: 'manual', title: 'Other notes', canonicalUri: 'manual://other' })
    catalog.publishRevision({ sourceId: source.id, original: 'Queue owns jobs.' })
    catalog.publishRevision({ sourceId: unrelated.id, original: 'Queue is durable.' })
    const before = directory.mentions(queue.id)
    const otherId = before.find((mention) => mention.citation.sourceId === unrelated.id)!.id
    catalog.publishRevision({ sourceId: source.id, original: 'This source no longer names any component.' })
    expect(directory.mentions(queue.id).map((mention) => mention.id)).toEqual([otherId])
    expect(directory.mentions(queue.id, { includeHistorical: true })).toEqual(expect.arrayContaining([expect.objectContaining({ citation: expect.objectContaining({ sourceId: source.id }), historical: true })]))
    catalog.recordFreshness(unrelated.id, { unavailable: true, deleted: true, reason: 'Source deleted upstream.' })
    expect(directory.mentions(queue.id)).toEqual([])
    expect(directory.detail(queue.id, { includeHistoricalMentions: true }).mentions).toHaveLength(2)
  })

  it('merges duplicates through a surviving identity and preserves alias and correction history', async () => {
    const { directory, catalog } = await fixture()
    const original = directory.create({ kind: 'component', displayName: 'Queue Worker', aliases: ['QW'], definition: 'Original queue worker.' })
    const target = directory.create({ kind: 'component', displayName: 'Job Worker', aliases: ['JW'], definition: 'Canonical job worker.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Workers', canonicalUri: 'manual://workers' })
    catalog.publishRevision({ sourceId: source.id, original: 'QW and Job Worker are the same service.' })
    const originalMention = directory.mentions(original.id)[0]
    const merged = directory.merge(original.id, target.id, { expectedSourceVersion: original.version, expectedTargetVersion: target.version, actor: 'owner', reason: 'These names refer to one worker.' })
    expect(merged.entity.aliases).toEqual(expect.arrayContaining(['JW', 'Queue Worker', 'QW']))
    expect(directory.get(original.id)).toMatchObject({ status: 'merged', mergedInto: target.id })
    expect(directory.canonicalId(original.id)).toBe(target.id)
    expect(directory.lookup('QW')).toMatchObject({ match: 'exact', candidates: [{ id: target.id }] })
    expect(directory.detail(original.id).canonicalEntity.id).toBe(target.id)
    expect(merged.mentions.find((mention) => mention.id === originalMention.id)?.entityId).toBe(target.id)
    expect(directory.history(original.id).map((entry) => entry.action)).toEqual(['merged', 'created'])
    expect(() => directory.merge(target.id, original.id, { expectedSourceVersion: merged.entity.version, expectedTargetVersion: 2, actor: 'owner', reason: 'Reverse merge.' })).toThrow('historical')
  })

  it('splits mistaken identities with selected aliases and mentions, preserving previous references', async () => {
    const { directory, catalog } = await fixture()
    const original = directory.create({ kind: 'component', displayName: 'Worker', aliases: ['QueueWorker', 'SearchWorker'], definition: 'Originally grouped workers.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Workers', canonicalUri: 'manual://workers' })
    catalog.publishRevision({ sourceId: source.id, original: 'QueueWorker owns jobs. SearchWorker owns indexing.' })
    const mentions = directory.mentions(original.id)
    const split = directory.split(original.id, { expectedVersion: original.version, entry: { kind: 'component', displayName: 'Search Worker', definition: 'Owns indexing.' }, aliases: ['SearchWorker'], mentionIds: [mentions.find((mention) => mention.surface === 'SearchWorker')!.id], actor: 'owner', reason: 'Indexing is an independent worker.' })
    expect(directory.lookup('SearchWorker').candidates[0].id).toBe(split.entity.id)
    expect(directory.lookup('QueueWorker').candidates[0].id).toBe(original.id)
    expect(split.mentions[0]).toMatchObject({ surface: 'SearchWorker', entityId: split.entity.id, historical: false })
    expect(directory.history(original.id)[0]).toMatchObject({ action: 'split', reason: expect.stringContaining(split.entity.id) })
    expect(directory.history(split.entity.id)[0].action).toBe('split_from')
  })

  it('corrects aliases, refuses stale edits and isolates project identities', async () => {
    const first = await fixture()
    const second = await fixture()
    const entry = first.directory.create({ kind: 'term', displayName: 'Lease', aliases: ['TTL'], definition: 'An expiring owner claim.' })
    const source = first.catalog.registerSource({ kind: 'manual', title: 'Notes', canonicalUri: 'manual://notes' })
    first.catalog.publishRevision({ sourceId: source.id, original: 'TTL is the Lease timeout.' })
    expect(first.directory.mentions(entry.id)).toHaveLength(2)
    const edited = first.directory.update(entry.id, { expectedVersion: entry.version, aliases: ['Owner TTL'] }, 'owner', 'TTL alone is too ambiguous.')
    expect(first.directory.lookup('TTL', { suggestions: false }).match).toBe('none')
    expect(first.directory.mentions(entry.id).map((mention) => mention.surface)).toEqual(['Lease'])
    expect(() => first.directory.update(entry.id, { expectedVersion: entry.version, definition: 'Outdated edit.' })).toThrow('changed')
    expect(() => second.directory.get(entry.id)).toThrow('does not exist in this project')
    expect(second.directory.lookup('Lease').match).toBe('none')
    first.directory.retire(entry.id, edited.version, 'owner', 'Term no longer used.')
    expect(first.directory.lookup('Lease').match).toBe('none')
    expect(first.directory.mentions(entry.id)).toEqual([])
    expect(first.directory.list({ includeHistorical: true })[0].status).toBe('retired')
  })
  it('rejects invalid merge and split selections without changing existing identities', async () => {
    const { directory, catalog } = await fixture()
    const first = directory.create({ kind: 'component', displayName: 'Queue Worker', aliases: ['QW'], definition: 'Owns jobs.' })
    const second = directory.create({ kind: 'component', displayName: 'Query Worker', aliases: ['QW'], definition: 'Owns search.' })
    const term = directory.create({ kind: 'term', displayName: 'Queue', definition: 'The work queue concept.' })
    const merge = { expectedSourceVersion: 1, expectedTargetVersion: 1, actor: 'owner', reason: 'Curate identities.' }
    expect(() => directory.merge(first.id, first.id, merge)).toThrow('different active entries')
    expect(() => directory.merge(first.id, term.id, merge)).toThrow('same kind')
    const split = { expectedVersion: 1, entry: { kind: 'component' as const, displayName: 'Index Worker', definition: 'Owns indexing.' }, aliases: ['QW'], mentionIds: [], actor: 'owner', reason: 'Separate concepts.' }
    expect(() => directory.split(first.id, { ...split, aliases: ['Unknown'] })).toThrow('Split aliases')
    expect(() => directory.split(first.id, { ...split, entry: { ...split.entry, kind: 'term' } })).toThrow('same kind')
    expect(() => directory.split(first.id, { ...split, mentionIds: ['missing-mention'] })).toThrow('mention does not exist')
    const source = catalog.registerSource({ kind: 'manual', title: 'Worker notes', canonicalUri: 'manual://worker-ambiguity' })
    catalog.publishRevision({ sourceId: source.id, original: 'QW handles requests.' })
    const mention = directory.mentions()[0]
    directory.resolveMention(mention.id, second.id, 'owner', 'This passage describes search.')
    expect(() => directory.split(first.id, { ...split, mentionIds: [mention.id] })).toThrow('original entry')
    directory.resolveMention(mention.id, null, 'owner', 'This is a general abbreviation.')
    expect(() => directory.split(first.id, { ...split, mentionIds: [mention.id] })).toThrow('original entry')
    directory.retire(second.id, second.version, 'owner', 'Obsolete concept.')
    expect(() => directory.resolveMention(mention.id, second.id, 'owner', 'Cannot restore retired guidance.')).toThrow('active project identity')
    expect(() => directory.update(first.id, { expectedVersion: 1, definition: 'Updated.' }, '', 'Anonymous change.')).toThrow('actor')
    expect(directory.get(first.id)).toEqual(first)
    expect(directory.list({ kind: 'term' }).map((entry) => entry.id)).toEqual([term.id])
    expect(directory.lookup('')).toMatchObject({ match: 'none', candidates: [] })
    expect(directory.lookup('Q'.repeat(501))).toMatchObject({ match: 'none', candidates: [] })
  })
  it('deduplicates evidence when merging and rejects alias or reference overflow atomically', async () => {
    const { directory, catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Ownership', canonicalUri: 'manual://ownership' })
    catalog.publishRevision({ sourceId: source.id, original: 'Queue ownership is durable.' })
    const citation = catalog.search('ownership')[0].citation
    const first = directory.create({ kind: 'component', displayName: 'Queue One', definition: 'One.', references: [{ kind: 'source', citation }] })
    const second = directory.create({ kind: 'component', displayName: 'Queue Two', definition: 'Two.', references: [{ kind: 'source', citation }, { kind: 'file', path: 'queue.ts' }] })
    const options = { expectedSourceVersion: 1, expectedTargetVersion: 1, actor: 'owner', reason: 'Curate duplicate identities.' }
    expect(directory.merge(first.id, second.id, options).entity.references).toHaveLength(2)
    const aliasesA = directory.create({ kind: 'term', displayName: 'Aliases A', definition: 'A.', aliases: Array.from({ length: 60 }, (_, i) => `A${i}`) })
    const aliasesB = directory.create({ kind: 'term', displayName: 'Aliases B', definition: 'B.', aliases: Array.from({ length: 60 }, (_, i) => `B${i}`) })
    expect(() => directory.merge(aliasesA.id, aliasesB.id, options)).toThrow('100 approved aliases')
    const refsA = directory.create({ kind: 'term', displayName: 'References A', definition: 'A.', references: Array.from({ length: 101 }, (_, i) => ({ kind: 'file' as const, path: `a${i}.ts` })) })
    const refsB = directory.create({ kind: 'term', displayName: 'References B', definition: 'B.', references: Array.from({ length: 101 }, (_, i) => ({ kind: 'file' as const, path: `b${i}.ts` })) })
    expect(() => directory.merge(refsA.id, refsB.id, options)).toThrow('200 evidence references')
    expect(directory.get(aliasesA.id)).toEqual(aliasesA)
    expect(directory.get(refsB.id)).toEqual(refsB)
  })
  it('exposes mention truncation and enforces the active directory capacity', async () => {
    const { directory, catalog, store } = await fixture()
    const entry = directory.create({ kind: 'component', displayName: 'QS', definition: 'Queue service.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Large notes', canonicalUri: 'manual://large' })
    catalog.publishRevision({ sourceId: source.id, original: 'QS '.repeat(5_010) })
    const detail = directory.detail(entry.id)
    expect(detail).toMatchObject({ mentionsTruncated: true, mentionLimits: { returned: 500, perSource: 5000 } })
    expect(detail.mentions).toHaveLength(500)
    expect(directory.mentions(entry.id, { limit: 2 })).toHaveLength(2)
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM project_mentions WHERE active=1').get()).toEqual({ count: 5000 })
    store.database.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<999)
      INSERT INTO project_entities (id,kind,display_name,aliases_json,definition,references_json,created_at,updated_at)
      SELECT 'entity:capacity-'||n,'term','Capacity '||n,'[]','A catalog term.','[]','2026-09-09','2026-09-09' FROM numbers`).run()
    expect(() => directory.create({ kind: 'term', displayName: 'Over capacity', definition: 'Must be rejected.' })).toThrow('1,000 active entries')
    expect(directory.list()).toHaveLength(1000)
  })
  it('handles unresolved mentions during an explicit split and detects malformed merge history', async () => {
    const { directory, catalog, store } = await fixture()
    const first = directory.create({ kind: 'component', displayName: 'Queue Worker', aliases: ['Worker'], definition: 'Queue jobs.' })
    const second = directory.create({ kind: 'component', displayName: 'Query Worker', aliases: ['Worker'], definition: 'Search requests.' })
    expect(directory.lookup('W')).toMatchObject({ match: 'none' })
    expect(directory.lookup('Queue')).toMatchObject({ match: 'suggestion' })
    catalog.registerSource({ kind: 'manual', title: 'Pending source', canonicalUri: 'manual://pending' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Workers', canonicalUri: 'manual://split-candidate' })
    catalog.publishRevision({ sourceId: source.id, original: 'Worker processes requests.' })
    const mention = directory.detail(first.id).mentions[0]
    expect(mention.resolution).toBe('candidate')
    expect(directory.detail(second.id).mentions).toHaveLength(1)
    const split = directory.split(first.id, { expectedVersion: first.version, entry: { kind: 'component', displayName: 'Background Worker', definition: 'Owns this request.' }, aliases: ['Worker'], mentionIds: [mention.id], actor: 'owner', reason: 'The passage names a distinct worker.' })
    expect(split.mentions[0]).toMatchObject({ entityId: split.entity.id, resolution: 'resolved' })
    expect(directory.detail(second.id).mentions).toEqual([])
    store.database.prepare("UPDATE project_entities SET status='merged',merged_into=? WHERE id=?").run(second.id, first.id)
    store.database.prepare("UPDATE project_entities SET status='merged',merged_into=? WHERE id=?").run(first.id, second.id)
    expect(() => directory.canonicalId(first.id)).toThrow('merge cycle')
  })
  it('does not treat broader Unicode regex case folding as an approved alias', async () => {
    const { directory, catalog } = await fixture()
    const entry = directory.create({ kind: 'term', displayName: 'Σ', definition: 'The named sigma parameter.' })
    const source = catalog.registerSource({ kind: 'manual', title: 'Greek identifiers', canonicalUri: 'manual://greek-identifiers' })
    catalog.publishRevision({ sourceId: source.id, original: 'ς and Σ are recorded as separate spellings.' })
    expect(directory.lookup('ς', { suggestions: false })).toMatchObject({ match: 'none' })
    expect(directory.mentions(entry.id).map((mention) => mention.surface)).toEqual(['Σ'])
  })
})

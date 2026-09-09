import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository, type SourceCitation } from '../../src/core/source-catalog'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { KnowledgeRetrievalService } from '../../src/core/knowledge-retrieval'
import { ContextPacketRepository } from '../../src/core/context-packets'
import { WorkItemRepository } from '../../src/core/work-items'
import { SemanticIndexRepository } from '../../src/core/semantic-index'

const stores: ProjectStore[] = []; const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-freshness-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Fresh guidance' }); stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T08:00:00Z'))
  const catalog = new SourceCatalogRepository(store, { clock })
  const revisions = new WikiRevisionRepository(store, clock)
  const source = catalog.registerSource({ kind: 'repo_file', title: 'Persistence source', canonicalUri: 'repo://persistence', policy: 'tracked_content', refreshSeconds: 60 })
  const original = catalog.publishRevision({ sourceId: source.id, original: '# Persistence\nKeep append-only revisions.', upstreamRevision: 'one' })
  const citation = catalog.getPassage(`${original.id}:0`).citation
  const publish = (key: string, slug: string, content: string, citations?: SourceCitation[]) => {
    const draft = revisions.stage({ requestKey: key, title: key, pages: [{ slug, content }], evidence: citations ? { sourceCitations: citations } : undefined })
    return revisions.publish(draft.revision.id, 'Reviewer', `Reviewed ${key}`)
  }
  return { root, store, clock, catalog, revisions, source, original, citation, publish }
}

describe('derived wiki evidence freshness', () => {
  it('blocks expired wiki chains in retrieval and pinned task packets, then recovers unchanged evidence without new wiki work', async () => {
    const { store, clock, catalog, revisions, source, original, citation, publish } = await fixture()
    publish('architecture', 'generated-architecture', '# Walrus architecture\nPreserve every snapshot.', [citation])
    const articleCitation = catalog.search('Walrus')[0].citation
    publish('guide', 'generated-guide', '# Walrus guide\nFollow the architecture.', [articleCitation])
    publish('independent', 'generated-independent', '# Independent article\nNo source dependency.')
    const current = revisions.currentId()
    const item = new WorkItemRepository(store, { clock }).create({ title: 'Apply Walrus guidance' })
    const packets = new ContextPacketRepository(store, { clock })
    packets.updatePreferences(item.id, { expectedVersion: 0, excludedSourceIds: [], sourcePins: [{ sourceId: 'wiki:generated-guide', category: 'architecture' }] })
    const accepted = packets.prepareLexical(item.id)
    expect(accepted.canExecute).toBe(true)
    catalog.queueImport(source.id, 'manual-revalidation')
    expect(catalog.listInvalidations().find((row) => row.artifactId === 'wiki:generated-architecture')?.reason).toBe('Source is not current and ready.')
    await catalog.processNext(async () => ({ original: '# Persistence\nKeep append-only revisions.', upstreamRevision: 'one' }))
    expect(catalog.listInvalidations()).toEqual([])
    expect(new KnowledgeRetrievalService(store, clock).retrieveLexical('Walrus').results.filter((result) => result.sourceType === 'wiki_article')).toHaveLength(2)
    clock.advance(61_000)
    expect(catalog.getSource('wiki:generated-guide').state).toBe('stale')
    expect(catalog.getSource('wiki:generated-independent').state).toBe('ready')
    expect(catalog.search('Walrus')).toEqual([])
    expect(new KnowledgeRetrievalService(store, clock).retrieveLexical('Walrus').results.filter((result) => result.sourceType === 'wiki_article')).toEqual([])
    const blocked = packets.prepareLexical(item.id)
    expect(blocked.canExecute).toBe(false)
    expect(blocked.gaps).toContainEqual(expect.objectContaining({ sourceId: 'wiki:generated-guide', severity: 'hard' }))
    expect(catalog.listInvalidations()).toContainEqual(expect.objectContaining({ artifactKind: 'context_packet', artifactId: accepted.id }))
    const queuedAt = catalog.listInvalidations().find((row) => row.artifactId === 'wiki:generated-architecture')!.queuedAt
    clock.advance(1000)
    catalog.scheduleDue()
    expect(catalog.listInvalidations().find((row) => row.artifactId === 'wiki:generated-architecture')?.queuedAt).toBe(queuedAt)
    await catalog.processNext(async () => ({ original: '# Persistence\nKeep append-only revisions.', upstreamRevision: 'one' }))
    expect(catalog.getSource(source.id).currentRevisionId).toBe(original.id)
    expect(catalog.getSource('wiki:generated-guide').state).toBe('ready')
    expect(catalog.listInvalidations()).toEqual([])
    expect(revisions.currentId()).toBe(current)
    expect(revisions.list()).toHaveLength(3)
    expect(packets.get(accepted.id)).toEqual(accepted)
    expect(packets.prepareLexical(item.id).canExecute).toBe(true)
  })

  it('keeps changed evidence stale until review, inherits other pages precisely, and restores original provenance', async () => {
    const { catalog, revisions, source, citation, publish } = await fixture()
    const first = publish('first', 'generated-architecture', '# First architecture', [citation])
    const oldWikiCitation = catalog.search('First')[0].citation
    const other = catalog.registerSource({ kind: 'manual', title: 'Unrelated source', canonicalUri: 'manual://other' })
    const otherRevision = catalog.publishRevision({ sourceId: other.id, original: 'Independent conventions.' })
    const otherCitation = catalog.getPassage(`${otherRevision.id}:0`).citation
    publish('conventions', 'generated-conventions', '# Conventions', [otherCitation])
    expect(revisions.currentPageCitations()).toEqual({ 'generated-architecture': [citation], 'generated-conventions': [otherCitation] })
    const changed = catalog.publishRevision({ sourceId: source.id, original: '# Persistence\nKeep compacted revisions.', upstreamRevision: 'two' })
    expect(catalog.listInvalidations().filter((row) => row.artifactKind === 'wiki_source')).toMatchObject([{ artifactId: 'wiki:generated-architecture', revisionId: citation.revisionId }])
    expect(catalog.getSource('wiki:generated-conventions').state).toBe('ready')
    const freshCitation = catalog.getPassage(`${changed.id}:0`).citation
    const proposed = revisions.stage({ requestKey: 'refresh', title: 'Refresh architecture', pages: [{ slug: 'generated-architecture', content: '# Updated architecture' }], evidence: { pageSourceCitations: { 'generated-architecture': [freshCitation] } } })
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('stale')
    expect(catalog.listInvalidations()).toHaveLength(1)
    revisions.publish(proposed.revision.id, 'Second reviewer', 'Checked changed source')
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('ready')
    expect(catalog.listInvalidations()).toEqual([])
    expect(catalog.readCitation(oldWikiCitation).passage).toMatchObject({ historical: true, text: '# First architecture' })
    expect(catalog.readCitation(citation).passage.text).toContain('append-only')
    const restored = revisions.restore(first.revision.id, 'Restorer', 'Inspect original behavior')
    expect(restored.revision.evidence).toMatchObject({ restoredFrom: first.revision.id, sourceCitations: [citation], pageSourceCitations: { 'generated-architecture': [citation] } })
    expect(revisions.review(first.revision.id).revision).toMatchObject({ actor: 'Reviewer', reviewNote: 'Reviewed first' })
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('stale')
    expect(catalog.getSource('wiki:generated-conventions')).toMatchObject({ state: 'unavailable', deletedAt: expect.any(String) })
    expect(catalog.listInvalidations().filter((row) => row.artifactKind === 'wiki_source')).toMatchObject([{ sourceId: source.id, artifactId: 'wiki:generated-architecture' }])
    const detached = revisions.stage({ requestKey: 'detach', title: 'Replace with independent guidance', pages: [{ slug: 'generated-architecture', content: '# Independent replacement' }], evidence: { pageSourceCitations: { 'generated-architecture': [] } } })
    revisions.publish(detached.revision.id, 'Reviewer')
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('ready')
    expect(catalog.listInvalidations()).toEqual([])
  })

  it('propagates unavailable, deleted and paused evidence across reopen, preserving explicit article failures', async () => {
    const { root, store, clock, catalog, source, citation, publish } = await fixture()
    publish('derived', 'generated-architecture', '# Trusted article', [citation])
    catalog.recordFreshness(source.id, { unavailable: true, deleted: true, reason: 'The upstream file was removed.' })
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('stale')
    expect(catalog.readCitation(citation).passage.historical).toBe(true)
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = await ProjectStore.open(root); stores.push(reopened)
    const current = new SourceCatalogRepository(reopened, { clock })
    expect(current.listInvalidations()).toMatchObject([{ artifactId: 'wiki:generated-architecture', reason: 'The upstream file was removed.' }])
    current.recordFreshness(source.id, { metadataOnly: true, upstreamRevision: 'one' })
    expect(current.getSource('wiki:generated-architecture').state).toBe('ready')
    current.updatePolicy(source.id, 'paused')
    expect(current.getSource('wiki:generated-architecture').state).toBe('stale')
    current.updatePolicy('wiki:generated-architecture', 'paused')
    expect(current.getSource('wiki:generated-architecture').state).toBe('stale')
    current.updatePolicy(source.id, 'import_once')
    current.updatePolicy('wiki:generated-architecture', 'import_once')
    expect(current.getSource('wiki:generated-architecture').state).toBe('ready')
    current.recordFreshness('wiki:generated-architecture', { unavailable: true, reason: 'Article explicitly withdrawn.' })
    current.recordFreshness(source.id, { upstreamRevision: 'one' })
    expect(current.getSource('wiki:generated-architecture')).toMatchObject({ state: 'unavailable', staleReason: 'Article explicitly withdrawn.' })
    expect(new WikiRevisionRepository(reopened, clock).currentPages()[0].content).toBe('# Trusted article')
  })

  it('backfills older per-proposal evidence and restores without changing accepted review history', async () => {
    const { store, catalog, revisions, source, citation, publish } = await fixture()
    const first = publish('legacy-first', 'generated-architecture', '# Original guidance', [citation])
    const rewrite = (id: string, evidence: Record<string, unknown>) => store.database.prepare('UPDATE wiki_revisions SET evidence_json = ? WHERE id = ?').run(JSON.stringify(evidence), id)
    rewrite(first.revision.id, { sourceCitations: [citation] })
    const second = publish('legacy-second', 'generated-guide', '# Separate guide')
    rewrite(second.revision.id, { pageSourceCitations: { 'generated-architecture': [citation] } })
    expect(revisions.currentPageCitations()['generated-guide']).toEqual([])
    rewrite(second.revision.id, {})
    const restored = revisions.restore(first.revision.id, 'Reviewer', 'Restore legacy baseline')
    rewrite(restored.revision.id, { restoredFrom: first.revision.id })
    store.database.prepare("DELETE FROM source_dependents WHERE artifact_kind = 'wiki_source'").run()
    const history = new WikiRevisionRepository(store).review(restored.revision.id).revision
    catalog.publishRevision({ sourceId: source.id, original: 'Replacement source', upstreamRevision: 'two' })
    expect(revisions.currentPageCitations()).toEqual({ 'generated-architecture': [citation] })
    expect(catalog.getSource('wiki:generated-architecture').state).toBe('stale')
    expect(catalog.listInvalidations()).toMatchObject([{ artifactId: 'wiki:generated-architecture' }])
    expect(revisions.review(restored.revision.id).revision).toEqual(history)
    expect(revisions.review(second.revision.id).revision.evidence).toEqual({})
  })

  it('excludes overdue derived guidance from read-only inspection and already indexed semantic results', async () => {
    const { root, store, clock, catalog, source, citation, publish } = await fixture()
    publish('semantic', 'generated-architecture', '# Walrus architecture', [citation])
    const modelPath = path.join(root, 'fixture-model.json')
    await writeFile(modelPath, JSON.stringify({ formatVersion: 1, modelId: 'freshness-fixture', version: '1', dimensions: 2, vocabulary: { walrus: [1, 0], architecture: [1, 0] } }))
    const semantic = new SemanticIndexRepository(store, clock)
    await semantic.configure(modelPath)
    while (await semantic.processNext()) { /* Drain the fixture source and article indexing jobs. */ }
    expect((await semantic.search('Walrus')).hits).toHaveLength(1)
    const inFlight = semantic.search('Walrus')
    catalog.updatePolicy(source.id, 'paused')
    expect((await inFlight).hits).toEqual([])
    catalog.updatePolicy(source.id, 'tracked_content')
    catalog.recordFreshness(source.id, { upstreamRevision: 'one' })
    store.database.prepare("DELETE FROM source_dependents WHERE artifact_kind = 'wiki_source'").run()
    clock.advance(61_000)
    const readonly = await ProjectStore.openReadOnly(root); stores.push(readonly)
    const inspection = new SourceCatalogRepository(readonly, { clock })
    expect(inspection.getSource('wiki:generated-architecture').state).toBe('stale')
    expect(inspection.search('Walrus')).toEqual([])
    expect(new KnowledgeRetrievalService(readonly, clock).retrieveLexical('Walrus').results.filter((result) => result.sourceType === 'wiki_article')).toEqual([])
    expect((await new SemanticIndexRepository(readonly, clock).search('Walrus')).hits).toEqual([])
    expect(store.database.prepare("SELECT state FROM source_catalog WHERE id = 'wiki:generated-architecture'").get()).toEqual({ state: 'ready' })
    expect((await semantic.search('Walrus')).hits).toEqual([])
    expect(semantic.schedule()).toBe(0)
    expect(store.database.prepare("SELECT state FROM source_catalog WHERE id = 'wiki:generated-architecture'").get()).toEqual({ state: 'stale' })
  })

  it('validates page citations and bounds the complete inherited review evidence', async () => {
    const { revisions, citation, publish } = await fixture()
    expect(revisions.currentPageCitations()).toEqual({})
    const input = { requestKey: 'invalid', title: 'Invalid', pages: [{ slug: 'generated-invalid', content: '# Invalid' }] }
    for (const pageSourceCitations of [null, [], 'invalid', { 'generated-invalid': 'invalid' }, { 'generated-invalid': [citation, { ...citation, startLine: 99 }] }, { 'generated-invalid': [{ ...citation, passageId: 'missing' }] }]) {
      expect(() => revisions.stage({ ...input, evidence: { pageSourceCitations } })).toThrow()
    }
    publish('first', 'generated-architecture', '# Architecture', [citation])
    publish('retain', 'generated-architecture', '# Edited but same supporting evidence')
    expect(revisions.currentPageCitations()).toEqual({ 'generated-architecture': [citation] })
    expect(() => revisions.stage({ ...input, evidence: { padding: 'x'.repeat(1_999_500) } })).toThrow('review limit')
  })

  it('invalidates cached readiness on rollback, external commits and backwards clock changes', async () => {
    const { root, store, clock, catalog, source, citation, publish } = await fixture()
    publish('cached', 'generated-architecture', '# Cached architecture', [citation])
    const snapshot = catalog.getSource('wiki:generated-architecture')
    snapshot.state = 'unavailable'
    expect(catalog.getSource(snapshot.id).state).toBe('ready')
    expect(() => store.database.transaction(() => {
      catalog.recordFreshness(source.id, { unavailable: true, reason: 'Rolled back outage' })
      expect(catalog.getSource(snapshot.id).state).toBe('stale')
      throw new Error('Abort update')
    })()).toThrow('Abort update')
    expect(catalog.getSource(snapshot.id).state).toBe('ready')
    const readonly = await ProjectStore.openReadOnly(root); stores.push(readonly)
    const observer = new SourceCatalogRepository(readonly, { clock })
    expect(observer.getSource(snapshot.id).state).toBe('ready')
    catalog.updatePolicy(source.id, 'paused')
    expect(observer.getSource(snapshot.id).state).toBe('stale')
    catalog.updatePolicy(source.id, 'tracked_content')
    catalog.recordFreshness(source.id, { upstreamRevision: 'one' })
    expect(observer.getSource(snapshot.id).state).toBe('ready')
    clock.advance(61_000)
    expect(catalog.getSource(snapshot.id).state).toBe('stale')
    clock.advance(-61_000)
    expect(catalog.getSource(snapshot.id).state).toBe('ready')
  })
})

import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { WorkItemRepository } from '../../src/core/work-items'
import { buildCopilotSessionContext } from '../../src/main/copilot-launcher'

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-revision-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Reviewed knowledge' }); stores.push(store)
  return { root, store, revisions: new WikiRevisionRepository(store), knowledge: new KnowledgeRepository(store) }
}
const update = (requestKey: string, content: string, slug = 'generated-architecture') => ({ requestKey, title: requestKey, pages: [{ slug, content }] })

describe('reviewed coherent wiki publication', () => {
  it('keeps drafts and rejections out of search, source passages and launch context across restart', async () => {
    const { root, store, revisions, knowledge } = await fixture()
    await rm(store.paths.wikiPath, { recursive: true, force: true })
    expect(revisions.currentPages()).toEqual([])
    knowledge.saveWikiArticle('team-notes', '# Manual authority')
    const first = revisions.stage({ ...update('change-one', '# Architecture\nDurable Walrus architecture'), author: 'Agent A', rationale: 'Observed persistence contract', evidence: { sourcePaths: ['src/database.ts'] } })
    expect(revisions.currentId()).toBeNull()
    expect(revisions.currentPages()).toEqual([])
    expect(revisions.list()).toMatchObject([{ status: 'proposed', author: 'Agent A', rationale: 'Observed persistence contract' }])
    expect(knowledge.search('Walrus')).toEqual([])
    expect(new SourceCatalogRepository(store).search('Walrus')).toEqual([])
    const item = new WorkItemRepository(store).create({ title: 'Review architecture' })
    expect(await buildCopilotSessionContext(store.project, item)).not.toContain('Walrus')
    const accepted = revisions.publish(first.revision.id, 'Reviewer', 'Checked source code')
    expect(revisions.publish(first.revision.id, 'Other reviewer', 'Repeated approval')).toEqual(accepted)
    expect(revisions.list()).toHaveLength(1)
    expect(knowledge.search('Walrus')).toHaveLength(1)
    expect(new SourceCatalogRepository(store).search('Walrus')).toHaveLength(1)
    expect(await buildCopilotSessionContext(store.project, item)).toContain('Walrus')
    const rejected = revisions.stage(update('change-two', '# Bad advice\nRejected aardvark'))
    revisions.reject(rejected.revision.id, 'Reviewer', 'Unsupported assertion')
    const reopened = await ProjectStore.open(root); stores.push(reopened)
    const history = new WikiRevisionRepository(reopened)
    expect(history.review(first.revision.id).revision).toMatchObject({ actor: 'Reviewer', reviewNote: 'Checked source code', status: 'published' })
    expect(history.review(rejected.revision.id).revision).toMatchObject({ status: 'rejected', reviewNote: 'Unsupported assertion' })
    expect(new KnowledgeRepository(reopened).listWikiArticles()).toContainEqual({ slug: 'team-notes', content: '# Manual authority' })
    expect(knowledge.search('aardvark')).toEqual([])
    expect(() => revisions.publish(rejected.revision.id, 'Reviewer')).toThrow('Only a proposed')
  })

  it('compares a legacy baseline accurately and never revives removed files after a restore', async () => {
    const { store, revisions, knowledge } = await fixture()
    await mkdir(store.paths.wikiPath, { recursive: true })
    await writeFile(path.join(store.paths.wikiPath, 'generated-architecture.md'), '# Existing design')
    await writeFile(path.join(store.paths.wikiPath, 'ignored.txt'), 'ignore')
    await symlink(path.join(store.paths.wikiPath, 'generated-architecture.md'), path.join(store.paths.wikiPath, 'generated-symlink.md'))
    const snapshot = revisions.snapshot()
    expect(snapshot.revisionId).toBeTruthy()
    const first = revisions.stage(update('independent-one', '# Existing design\nFeature One'))
    expect(first.changes).toEqual([{ slug: 'generated-architecture', before: '# Existing design', after: '# Existing design\nFeature One' }])
    revisions.publish(first.revision.id, 'Reviewer')
    const second = revisions.stage({ requestKey: 'independent-two', title: 'Feature Two', pages: [{ slug: 'generated-architecture', content: '# Existing design\nFeature One\nFeature Two' }, { slug: 'generated-new', content: '# New page' }] })
    revisions.publish(second.revision.id, 'Reviewer')
    await writeFile(path.join(store.paths.wikiPath, 'generated-new.md'), '# Stale mirror')
    const restored = revisions.restore(first.revision.id, 'Reviewer', 'Revert unsupported second feature')
    expect(restored.revision).toMatchObject({ status: 'published', evidence: { restoredFrom: first.revision.id } })
    expect(restored.revision.id).not.toBe(first.revision.id)
    expect(restored.changes).toContainEqual({ slug: 'generated-new', before: '# New page', after: '' })
    expect(knowledge.listWikiArticles()).toEqual([{ slug: 'generated-architecture', content: '# Existing design\nFeature One' }])
    expect(revisions.list()).toHaveLength(4)
    expect(new SourceCatalogRepository(store).getSource('wiki:generated-new').state).toBe('unavailable')
    expect(new SourceCatalogRepository(store).search('New page')).toEqual([])
  })

  it('rejects stale approvals and stages an idempotent request against the captured base', async () => {
    const { revisions } = await fixture()
    const first = revisions.stage(update('first', '# First'))
    const stale = revisions.stage(update('second', '# Second'))
    revisions.publish(first.revision.id, 'Reviewer')
    expect(() => revisions.publish(stale.revision.id, 'Reviewer')).toThrow('changed after this proposal')
    expect(revisions.currentPages()[0].content).toBe('# First')
    expect(revisions.stage(update('first', '# Unexpected retry content'))).toEqual(revisions.review(first.revision.id))
    expect(revisions.findByRequestKey('missing')).toBeUndefined()
    expect(() => revisions.stage({ ...update('third', '# Third'), baseRevisionId: 'missing' })).toThrow('not found')
    expect(() => revisions.publish(first.revision.id, ' ')).toThrow('reviewer')
    expect(() => revisions.reject(first.revision.id, 'Reviewer', 'Reason')).toThrow('Only proposed')
    expect(() => revisions.reject(stale.revision.id, '', 'Reason')).toThrow('reviewer')
    expect(() => revisions.restore(stale.revision.id, 'Reviewer', 'Reason')).toThrow('previously published')
    expect(() => revisions.restore(first.revision.id, 'Reviewer', '')).toThrow('Explain')
    expect(() => revisions.restore(first.revision.id, '', 'Reason')).toThrow('reviewer')
    expect(revisions.list()).toHaveLength(2)
  })

  it('rolls back the publication pointer, history and indices when a source projection fails', async () => {
    const { store, revisions, knowledge } = await fixture()
    const accepted = revisions.stage(update('accepted', '# Existing canonical fact'))
    revisions.publish(accepted.revision.id, 'Reviewer')
    const proposal = revisions.stage(update('failing', '# New Zebra fact'))
    store.database.exec("CREATE TRIGGER simulated_full_disk BEFORE INSERT ON source_revisions BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;")
    expect(() => revisions.publish(proposal.revision.id, 'Reviewer')).toThrow('simulated disk full')
    expect(revisions.currentId()).toBe(accepted.revision.id)
    expect(revisions.review(proposal.revision.id).revision.status).toBe('proposed')
    expect(knowledge.search('Zebra')).toEqual([])
    store.database.exec('DROP TRIGGER simulated_full_disk')
    revisions.publish(proposal.revision.id, 'Reviewer')
    expect(knowledge.search('Zebra')).toHaveLength(1)
  })

  it('validates revision citations and coherent local links without accepting stale generated file mirrors', async () => {
    const { store, revisions, knowledge } = await fixture()
    const catalog = new SourceCatalogRepository(store)
    const source = catalog.registerSource({ kind: 'manual', title: 'Contract', canonicalUri: 'manual://contract' })
    catalog.publishRevision({ sourceId: source.id, original: '# Contract\nEchidna interface contract' })
    const citation = catalog.search('Echidna')[0].citation
    expect(() => revisions.stage({ ...update('valid', '# Echidna\n[Human notes](team-notes.md)'), evidence: { sourceCitations: [citation] } })).toThrow('missing local article')
    knowledge.saveWikiArticle('team-notes', '# Notes')
    const proposal = revisions.stage({ ...update('valid', '# Echidna\n[Human notes](team-notes.md)'), evidence: { sourceCitations: [citation] } })
    await rm(path.join(store.paths.wikiPath, 'team-notes.md'))
    expect(() => revisions.publish(proposal.revision.id, 'Reviewer')).toThrow('missing local article')
  })

  it('rejects invalid input, missing links and mismatched citation hashes before a proposal is persisted', async () => {
    const { store, revisions, knowledge } = await fixture()
    const catalog = new SourceCatalogRepository(store)
    const source = catalog.registerSource({ kind: 'manual', title: 'Contract', canonicalUri: 'manual://contract' })
    catalog.publishRevision({ sourceId: source.id, original: '# Contract\nEchidna interface contract' })
    const citation = catalog.search('Echidna')[0].citation
    knowledge.saveWikiArticle('team-notes', '# Human notes')
    const valid = revisions.stage({ ...update('valid', '# Echidna\n[Human notes](team-notes.md)'), evidence: { sourceCitations: [citation] } })
    revisions.publish(valid.revision.id, 'Reviewer')
    expect(() => revisions.stage({ ...update('invalid-citation', '# Contract'), evidence: { sourceCitations: [{ ...citation, passageHash: 'wrong' }] } })).toThrow()
    expect(() => revisions.stage({ ...update('invalid-array', '# Contract'), evidence: { sourceCitations: 'wrong' } })).toThrow('citations')
    for (const input of [update('', '# content'), { ...update('empty', '# content'), pages: [] }, update('bad-slug', '# content', '../escape'), update('manual', '# content', 'human-notes'), update('empty-content', ' '), update('huge', 'x'.repeat(200001)), { ...update('duplicate', '# Content'), pages: [{ slug: 'generated-one', content: 'one' }, { slug: 'generated-one', content: 'two' }] }]) expect(() => revisions.stage(input)).toThrow()
    expect(() => revisions.stage({ ...update('large-evidence', '# Content'), evidence: { text: 'x'.repeat(2_000_001) } })).toThrow('evidence exceeds')
    await writeFile(path.join(store.paths.wikiPath, 'generated-stale.md'), '# Old file mirror')
    expect(() => revisions.stage(update('bad-link', '[Missing](generated-stale.md)'))).toThrow('missing local article')
    expect(() => revisions.stage(update('missing-manual', '[Missing](missing-manual.md)'))).toThrow('missing local article')
    const coherent = revisions.stage({ requestKey: 'coherent', title: 'Two linked pages', pages: [{ slug: 'generated-a', content: '[B](./generated-b.md#heading)' }, { slug: 'generated-b', content: '# Heading' }] })
    expect(coherent.pages).toHaveLength(3)
    expect(() => revisions.review('missing')).toThrow('not found')
  })
  it('reconciles independent proposals as a new review without overwriting concurrently accepted facts', async () => {
    const { revisions } = await fixture()
    const first = revisions.stage(update('first-component', '# First component', 'generated-first'))
    const second = revisions.stage(update('second-component', '# Second component', 'generated-second'))
    expect(revisions.reconcile(second.revision.id, 'Owner', 'Check current base')).toEqual(second)
    revisions.publish(first.revision.id, 'Owner')
    const reconciled = revisions.reconcile(second.revision.id, 'Owner', 'Keep both independent components')
    expect(reconciled.revision).toMatchObject({ status: 'proposed', baseRevisionId: first.revision.id, evidence: { reconciledFrom: second.revision.id } })
    expect(reconciled.pages).toHaveLength(2)
    expect(revisions.reconcile(second.revision.id, 'Owner', 'Repeated click')).toEqual(reconciled)
    expect(revisions.review(second.revision.id).revision.status).toBe('rejected')
    revisions.publish(reconciled.revision.id, 'Owner')
    expect(() => revisions.reconcile(first.revision.id, 'Owner', 'Reason')).toThrow('Only a proposed')
    expect(() => revisions.reconcile(reconciled.revision.id, '', 'Reason')).toThrow('reviewer')

    const before = '# First component'
    const section = (key: string) => `<!-- workstack-update:${key}:start -->\n${key} observed behavior\n<!-- workstack-update:${key}:end -->`
    const a = revisions.stage({ ...update('section-a', `${before}\n\n${section('a')}`, 'generated-first'), evidence: { sectionKey: 'a' } })
    const b = revisions.stage({ ...update('section-b', `${before}\n\n${section('b')}`, 'generated-first'), evidence: { sectionKey: 'b' } })
    revisions.publish(a.revision.id, 'Owner')
    const merged = revisions.reconcile(b.revision.id, 'Owner', 'Independent attributed sections')
    expect(merged.pages.find((page) => page.slug === 'generated-first')?.content).toBe(`${before}\n\n${section('a')}\n\n${section('b')}`)
    revisions.publish(merged.revision.id, 'Owner')
  })

  it('refuses ambiguous whole-page rewrites or malformed attributed sections during reconciliation', async () => {
    const { revisions } = await fixture()
    const baseline = revisions.stage(update('baseline', '# Prior fact'))
    revisions.publish(baseline.revision.id, 'Owner')
    const proposals = [
      revisions.stage(update('whole-page', '# Rewrite')),
      revisions.stage({ ...update('missing-marker', '# Rewrite'), evidence: { sectionKey: 'x' } }),
      revisions.stage({ ...update('missing-end', '# Prior fact\n\n<!-- workstack-update:x:start -->partial'), evidence: { sectionKey: 'x' } }),
      revisions.stage({ ...update('changed-before', '# Different fact\n\n<!-- workstack-update:x:start -->change<!-- workstack-update:x:end -->'), evidence: { sectionKey: 'x' } }),
      revisions.stage({ ...update('duplicate-section', '# Prior fact\n\n<!-- workstack-update:x:start -->change<!-- workstack-update:x:end -->'), evidence: { sectionKey: 'x' } })
    ]
    const current = revisions.stage(update('current', '# Prior fact\n\n<!-- workstack-update:x:start -->accepted<!-- workstack-update:x:end -->'))
    revisions.publish(current.revision.id, 'Owner')
    for (const proposal of proposals) expect(() => revisions.reconcile(proposal.revision.id, 'Owner', 'Try to reconcile')).toThrow('Both revisions changed')
    expect(revisions.currentId()).toBe(current.revision.id)
  })

})

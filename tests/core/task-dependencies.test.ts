import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ClaimsRepository } from '../../src/core/claims'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { TaskDependenciesRepository, normalizeDeclaredPath } from '../../src/core/task-dependencies'
import { WorkItemRepository } from '../../src/core/work-items'

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.database.open) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-task-dependencies-'))
  roots.push(root)
  const clock = new FrozenClock(new Date('2026-09-09T02:00:00.000Z'))
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Dependencies', workItemPrefix: 'DEP' }, { clock })
  stores.push(store)
  const items = new WorkItemRepository(store, { clock })
  const claims = new ClaimsRepository(store, { clock })
  const dependencies = new TaskDependenciesRepository(store, clock)
  const first = items.create({ title: 'API consumer' })
  const second = items.create({ title: 'API implementation' })
  const third = items.create({ title: 'Schema prerequisite' })
  return { root, store, clock, items, claims, dependencies, first, second, third }
}

describe('task prerequisites and advisory coordination', () => {
  it('validates identities and paths, detects transitive cycles, and preserves prior links on rejection', async () => {
    const { dependencies, items, first, second, third } = await fixture()
    expect(dependencies.get(first.id)).toMatchObject({ readiness: { ready: true, blockers: [] }, prerequisites: [], related: [], activeOverlaps: [] })
    expect(() => dependencies.get('missing')).toThrow('does not exist in this project')
    expect(() => dependencies.update(first.id, { dependsOn: [first.displayId] })).toThrow('cannot link to itself')
    expect(() => dependencies.update(first.id, { relatedTo: ['missing'] })).toThrow('does not exist')
    expect(() => dependencies.update(first.id, { unknown: true } as never)).toThrow()
    expect(() => dependencies.update(first.id, { declaredPaths: ['../outside'] })).toThrow('repository-relative')
    expect(dependencies.update(first.id, { dependsOn: [third.id, second.id] }).prerequisites).toHaveLength(2)
    dependencies.update(first.id, { dependsOn: [second.id, second.displayId], relatedTo: [third.id, third.displayId] })
    dependencies.update(second.id, { dependsOn: [third.id] })
    expect(() => dependencies.update(third.id, { dependsOn: [first.displayId] })).toThrow(/DEP-3.*DEP-1.*cycle/)
    expect(dependencies.get(third.id).prerequisites).toEqual([])
    expect(dependencies.get(first.id).prerequisites.map((item) => item.workItemId)).toEqual([second.id])
    expect(dependencies.get(third.id).related.map((item) => item.workItemId)).toEqual([first.id])
    expect(() => items.delete(second.id)).toThrow(`Remove the prerequisite link from ${first.displayId}`)
    dependencies.update(first.id, { dependsOn: [], relatedTo: [] })
    expect(dependencies.get(first.id).readiness.ready).toBe(true)
    expect(dependencies.get(third.id).related).toEqual([])
    items.delete(second.id)
    expect(dependencies.get(third.id).readiness.ready).toBe(true)
  })

  it('enforces unresolved prerequisites at claim and follows submitted, closed, replacement and finalized delivery', async () => {
    const { store, dependencies, items, claims, first, second } = await fixture()
    dependencies.update(first.id, { dependsOn: [second.id] })
    expect(() => claims.claim(first.id, { agentId: 'consumer' })).toThrow(/DEP-2: Task is backlog/)
    expect(items.get(first.id).status).toBe('backlog')
    expect(claims.getActive(first.id)).toBeUndefined()
    const worker = claims.claim(second.id, { agentId: 'implementer' })
    expect(dependencies.get(first.id).readiness.blockers[0].reason).toBe('Task is in progress.')
    expect(() => dependencies.update(second.id, { dependsOn: [] })).toThrow('only be edited while a task is in the backlog')
    dependencies.update(second.id, { declaredPaths: ['src/api.ts'] })
    claims.complete(second.id, worker.claimToken, { summaryMarkdown: 'API proposed', prUrl: 'https://github.com/example/project/pull/1', commitSha: 'a'.repeat(40) })
    expect(dependencies.get(first.id).readiness.blockers[0].reason).toMatch(/awaiting review/)
    claims.reconcilePullRequest(second.id, 'https://github.com/example/project/pull/1', 'CLOSED')
    expect(dependencies.get(first.id).readiness.blockers[0].reason).toMatch(/closed without merge/)
    claims.reconcilePullRequest(second.id, 'https://github.com/example/project/pull/1', 'OPEN')
    expect(dependencies.readiness(first.id).ready).toBe(false)
    claims.reconcilePullRequest(second.id, 'https://github.com/example/project/pull/1', 'CLOSED')
    const replacement = claims.claim(second.id, { agentId: 'replacement', sessionId: 'attempt-2' })
    const completed = claims.complete(second.id, replacement.claimToken, { summaryMarkdown: 'API available', validationMarkdown: 'Contract tests passed', commitSha: 'b'.repeat(40), filesChanged: ['src/api.ts'], componentsChanged: ['api'] })
    const catalog = new SourceCatalogRepository(store)
    const source = catalog.registerSource({ kind: 'work_completion', title: 'API outcome', canonicalUri: `workstack:completion:${second.id}`, workItemId: second.id })
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'API available and validated' })
    const packet = dependencies.get(first.id)
    expect(packet.readiness).toEqual({ ready: true, blockers: [] })
    expect(packet.prerequisites[0].outcome).toMatchObject({ completion: completed, recordHash: expect.stringMatching(/^[a-f0-9]{64}$/), sourceRevisions: [{ sourceId: source.id, revisionId: revision.id, contentHash: revision.contentHash }] })
    expect(claims.claim(first.id, { agentId: 'consumer' }).claim.agentId).toBe('consumer')
  })

  it('requires merged PR evidence and treats historical completed-but-reopened deliveries as unresolved', async () => {
    const { store, dependencies, claims, first, second } = await fixture()
    dependencies.update(first.id, { dependsOn: [second.id] })
    const claim = claims.claim(second.id, { agentId: 'author' })
    claims.complete(second.id, claim.claimToken, { summaryMarkdown: 'Reviewed API', prUrl: 'https://github.com/example/project/pull/2' })
    claims.finalizeMergedPullRequest(second.id)
    expect(dependencies.readiness(first.id).ready).toBe(true)
    // A legacy delivery record can have completed status despite an unmerged/reopened PR.
    store.database.prepare("UPDATE completion_records SET pr_state = 'OPEN' WHERE work_item_id = ?").run(second.id)
    expect(dependencies.get(first.id).prerequisites[0]).toMatchObject({ status: 'completed', satisfied: false, reason: expect.stringContaining('reopened') })
    expect(() => claims.claim(first.id, { agentId: 'consumer' })).toThrow(/Unresolved prerequisites/)
    store.database.prepare("UPDATE completion_records SET pr_state = 'CLOSED' WHERE work_item_id = ?").run(second.id)
    expect(dependencies.readiness(first.id).blockers[0].reason).toMatch(/replacement attempt/)
    store.database.prepare('UPDATE completion_records SET pr_state = NULL, files_changed_json = NULL, components_changed_json = NULL WHERE work_item_id = ?').run(second.id)
    expect(dependencies.get(first.id).prerequisites[0].outcome?.completion).toMatchObject({ filesChanged: [], componentsChanged: [] })
    expect(dependencies.readiness(first.id).blockers[0].reason).toMatch(/Finalized completion evidence/)
    store.database.prepare('DELETE FROM completion_records WHERE work_item_id = ?').run(second.id)
    expect(dependencies.get(first.id).prerequisites[0].outcome).toBeNull()
    expect(dependencies.readiness(first.id).ready).toBe(false)
    store.database.prepare("UPDATE work_items SET status = 'backlog', completed_at = NULL WHERE id = ?").run(second.id)
    expect(dependencies.readiness(first.id).blockers[0].reason).toBe('Task is backlog.')
  })

  it('persists normalized scopes and reports exact, parent, component and checkpoint overlaps as advisory', async () => {
    const { root, store, clock, dependencies, claims, first, second, third } = await fixture()
    const initial = dependencies.update(first.id, {
      declaredPaths: ['./src/api/', 'src/api', 'lib/client.ts', 'exact.ts'], declaredComponents: ['API', 'api']
    })
    expect(initial.declaredPaths).toEqual(['exact.ts', 'lib/client.ts', 'src/api'])
    expect(initial.declaredComponents).toEqual(['api'])
    dependencies.update(second.id, { declaredPaths: ['src/api/server.ts', 'lib', 'exact.ts', 'src/apiculture.ts'], declaredComponents: ['api'] })
    const worker = claims.claim(second.id, { agentId: 'copilot', agentDisplayName: 'API worker', sessionId: 'session-api' })
    claims.claim(third.id, { agentId: 'unrelated' })
    claims.saveCheckpoint(second.id, worker.claimToken, { progressMarkdown: 'Old checkpoint', filesChanged: ['src/api/old.ts'] })
    const checkpoint = claims.saveCheckpoint(second.id, worker.claimToken, { progressMarkdown: 'Latest checkpoint', filesChanged: ['src/api/new.ts', '../outside'] })
    const overlaps = dependencies.get(first.id).activeOverlaps
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]).toMatchObject({ workItemId: second.id, agentId: 'copilot', agentDisplayName: 'API worker', sessionId: 'session-api', claimId: worker.claim.id, advisory: true })
    expect(overlaps[0].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'path', selectedValue: 'src/api', activeValue: 'src/api/server.ts', basis: 'declared' }),
      expect.objectContaining({ kind: 'path', selectedValue: 'lib/client.ts', activeValue: 'lib' }),
      expect.objectContaining({ kind: 'path', selectedValue: 'exact.ts', activeValue: 'exact.ts' }),
      expect.objectContaining({ kind: 'component', selectedValue: 'api', activeValue: 'api' }),
      expect.objectContaining({ basis: 'checkpoint', checkpointId: checkpoint.id, activeValue: 'src/api/new.ts' })
    ]))
    expect(overlaps[0].evidence.some((evidence) => evidence.activeValue === 'src/apiculture.ts' || evidence.activeValue === 'src/api/old.ts')).toBe(false)
    expect(dependencies.get(second.id).activeOverlaps).toEqual([])
    const ownClaim = claims.claim(first.id, { agentId: 'consumer' })
    expect(ownClaim.claim.workItemId).toBe(first.id)
    claims.release(second.id, worker.claimToken)
    expect(dependencies.get(first.id).activeOverlaps).toEqual([])
    const restarted = claims.claim(second.id, { agentId: 'new-worker' })
    expect(dependencies.get(first.id).activeOverlaps[0].evidence.every((evidence) => evidence.basis === 'declared')).toBe(true)
    clock.advance(1800_001)
    expect(dependencies.get(first.id).activeOverlaps).toEqual([])
    expect(restarted.claim.agentDisplayName).toBeNull()
    store.close()
    const reopened = await ProjectStore.open(root)
    stores.push(reopened)
    expect(new TaskDependenciesRepository(reopened).get(first.displayId).declaredPaths).toEqual(initial.declaredPaths)
  })

  it('rejects non-project scope patterns and normalizes separators without prefix false positives', () => {
    for (const value of ['', '/', '/etc/file', 'C:\\file', 'src//file', 'src/./file', 'src/../file', '**/*.ts', 'a\0b']) {
      expect(() => normalizeDeclaredPath(value)).toThrow(/repository-relative/)
    }
    expect(normalizeDeclaredPath(' src\\api.ts ')).toBe('src/api.ts')
  })
})

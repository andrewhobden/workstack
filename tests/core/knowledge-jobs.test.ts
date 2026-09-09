import { mkdtemp, rm, readFile, mkdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { KnowledgeJobsRepository } from '../../src/core/knowledge-jobs'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-intake-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Intake' })
  const source = new KnowledgeRepository(store).addManualSource({ displayName: 'Evidence', filename: 'notes.txt', content: 'Evidence content' })
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00Z'))
  return { store, source, clock, jobs: new KnowledgeJobsRepository(store, { clock, leaseSeconds: 60 }) }
}
describe('shared durable knowledge intake', () => {
  it('deduplicates intake and fences concurrent, expired and cancelled workers', async () => {
    const { store, source, jobs, clock } = await fixture()
    const enqueued = jobs.enqueue(source.id, 'stable-key', { processor: 'catalog', payload: { locator: 'notes.txt' } })
    expect(jobs.enqueue(source.id, 'stable-key', { processor: 'catalog' }).id).toBe(enqueued.id)
    expect(() => jobs.enqueue(source.id, 'stable-key', { processor: 'legacy' })).toThrow('another source')
    expect(() => jobs.enqueue(source.id, ' ', { processor: 'catalog' })).toThrow('required')
    const first = jobs.claimNext('catalog')!
    const otherStore = await ProjectStore.open(store.paths.rootPath)
    const other = new KnowledgeJobsRepository(otherStore, { clock, leaseSeconds: 60 })
    expect(other.claimNext('catalog')).toBeUndefined()
    expect(() => jobs.heartbeat(enqueued.id, 'not-owner')).toThrow('another worker')
    jobs.advance(enqueued.id, first.owner, 'extract', { contentHash: 'abc' })
    jobs.heartbeat(enqueued.id, first.owner)
    clock.advance(61_000)
    const second = other.claimNext('catalog')!
    expect(second.job.id).toBe(enqueued.id)
    expect(second.owner).not.toBe(first.owner)
    expect(() => jobs.complete(enqueued.id, first.owner)).toThrow('expired')
    other.cancel(enqueued.id)
    expect(() => other.complete(enqueued.id, second.owner)).toThrow('expired')
    expect(jobs.list()[0]).toMatchObject({ stage: 'cancelled', status: 'failed', payload: { contentHash: 'abc' } })
    jobs.retry(enqueued.id)
    const final = jobs.claimNext('catalog')!
    jobs.advance(final.job.id, final.owner, 'publish')
    jobs.complete(final.job.id, final.owner)
    expect(jobs.list('catalog')[0]).toMatchObject({ status: 'completed', stage: 'complete' })
    expect(() => jobs.retry(final.job.id)).toThrow('Only failed')
    expect(() => jobs.cancel(final.job.id)).toThrow('completed')
    expect(() => jobs.cancel('missing')).toThrow('does not exist')
    otherStore.close(); store.close()
  })
  it('caps transient retries, retains errors and requires explicit retry for permanent failure', async () => {
    const { store, source, jobs, clock } = await fixture()
    const queued = jobs.enqueue(source.id, 'retry-key', { processor: 'legacy', stage: 'index' })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = jobs.claimNext('legacy')!
      expect(claim.job.attempts).toBe(attempt)
      jobs.fail(claim.job.id, claim.owner, 'Unavailable', { retryable: true })
      expect(jobs.claimNext('legacy')).toBeUndefined()
      clock.advance(4_000_000)
    }
    expect(jobs.claimNext('legacy')).toBeUndefined()
    expect(jobs.list()[0]).toMatchObject({ status: 'failed', attempts: 5, nextAttemptAt: null })
    jobs.retry(queued.id)
    const claim = jobs.claimNext('legacy')!
    jobs.fail(claim.job.id, claim.owner, new Error('api_key=privateValue'))
    expect(jobs.list()[0].errorMessage).toContain('[REDACTED]')
    expect(jobs.claimNext('legacy')).toBeUndefined()
    store.close()
  })
  it('turns five interrupted leases and legacy stranded rows into recoverable failures without affecting other processors', async () => {
    const { store, source, jobs, clock } = await fixture()
    const queued = jobs.enqueue(source.id, 'interrupted', { processor: 'legacy' })
    const independent = jobs.enqueue(source.id, 'other-processor', { processor: 'catalog' })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = jobs.claimNext('legacy')!
      expect(claim.job.attempts).toBe(attempt)
      expect(jobs.claimNext('legacy')).toBeUndefined()
      clock.advance(60_000)
      expect(() => jobs.complete(queued.id, claim.owner)).toThrow('expired')
    }
    expect(jobs.claimNext('legacy')).toBeUndefined()
    expect(jobs.list('legacy')[0]).toMatchObject({ status: 'failed', attempts: 5, nextAttemptAt: null, errorMessage: expect.stringContaining('interrupted attempts') })
    expect(jobs.list('catalog')[0]).toMatchObject({ id: independent.id, status: 'pending', attempts: 0 })
    store.database.prepare("UPDATE knowledge_jobs SET status='pending' WHERE id=?").run(queued.id)
    expect(jobs.claimNext('legacy')).toBeUndefined()
    expect(jobs.retry(queued.id)).toMatchObject({ status: 'pending', attempts: 0 })
    const replacement = jobs.claimNext('legacy')!
    jobs.complete(queued.id, replacement.owner)
    expect(jobs.list('legacy')[0].status).toBe('completed')
    store.close()
  })
  it('repairs an interrupted completion projection without duplicating entries or requiring the file mirror', async () => {
    const { store } = await fixture()
    await store.updateMetadata({ settings: { autoUpdateKnowledgeOnCompletion: false } })
    const item = new WorkItemRepository(store).create({ title: 'Durable completion' })
    const claims = new ClaimsRepository(store)
    const claim = claims.claim(item.id, { agentId: 'test-agent' })
    claims.complete(item.id, claim.claimToken, { summaryMarkdown: 'Unique canonical evidence', validationMarkdown: 'Validated database restart' })
    await unlink(path.join(store.paths.workItemsPath, item.id, 'completion.md'))
    const log = path.join(store.paths.knowledgePath, 'log.md')
    await rm(log, { force: true }); await mkdir(log)
    const knowledge = new KnowledgeRepository(store)
    expect(knowledge.processNextJob()?.status).toBe('failed')
    await rm(log, { recursive: true })
    expect(knowledge.retryFailedJobs()).toBe(1)
    expect(knowledge.processNextJob()?.status).toBe('indexed')
    expect(knowledge.processNextJob()).toBeUndefined()
    const wiki = await readFile(path.join(store.paths.wikiPath, 'completed-work.md'), 'utf8')
    expect(wiki.match(/Unique canonical evidence/g)).toHaveLength(1)
    expect(knowledge.search('canonical')).toHaveLength(1)
    store.close()
  })
})

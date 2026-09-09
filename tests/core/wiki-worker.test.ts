import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { FrozenClock } from '../../src/core/clock'
import { WikiWorkerRepository } from '../../src/core/wiki-worker'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-worker-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Wiki worker' }); stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00Z'))
  return { root, store, clock, worker: new WikiWorkerRepository(store, clock), jobs: new WikiAutomationRepository(store, { clock }) }
}
describe('durable wiki worker', () => {
  it('owns jobs across processes and fences an expired generator before it can commit a proposal', async () => {
    const { root, store, clock, worker, jobs } = await fixture()
    expect(worker.claim()).toBeUndefined()
    const job = jobs.createJob({ title: 'Durable generation', promptMarkdown: 'Evidence' })
    const claimed = worker.claim()!
    const anotherStore = await ProjectStore.open(root); stores.push(anotherStore)
    const anotherWorker = new WikiWorkerRepository(anotherStore, clock)
    expect(anotherWorker.claim()).toBeUndefined()
    expect(() => jobs.retryJob(job.id)).toThrow('cannot be retried')
    expect(jobs.retryInterruptedJobs()).toEqual([])
    clock.advance(90_000)
    worker.heartbeat(job.id, claimed.owner)
    clock.advance(60_000)
    expect(anotherWorker.claim()).toBeUndefined()
    clock.advance(61_000)
    const replacement = anotherWorker.claim()!
    expect(replacement.job).toMatchObject({ id: job.id, attemptCount: 2, status: 'running' })
    expect(() => worker.run(job.id, claimed.owner, () => { store.database.exec('DROP TABLE wiki_automation_artifacts') })).toThrow('expired')
    expect(() => worker.heartbeat(job.id, 'wrong')).toThrow('expired')
    anotherWorker.complete(job.id, replacement.owner)
    expect(jobs.getJob(job.id).status).toBe('completed')
    expect(() => worker.fail(job.id, claimed.owner, 'Old error')).toThrow('expired')
    expect(() => worker.heartbeat('missing', 'missing')).toThrow('expired')
  })
  it('backs off transient failures, stops at five attempts and supports explicit operator retry', async () => {
    const { store, clock, worker, jobs } = await fixture()
    const job = jobs.createJob({ title: 'Retry', promptMarkdown: 'Evidence' })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = worker.claim()!
      expect(claim.job.attemptCount).toBe(attempt)
      worker.fail(job.id, claim.owner, new Error('api_key=private-token'))
      expect(worker.claim()).toBeUndefined()
      clock.advance(4_000_000)
    }
    expect(worker.claim()).toBeUndefined()
    expect(jobs.getJob(job.id)).toMatchObject({ status: 'failed', attemptCount: 5, errorMessage: 'api_key=[REDACTED]' })
    jobs.retryJob(job.id)
    const explicit = worker.claim()!
    expect(explicit.job.attemptCount).toBe(1)
    worker.fail(job.id, explicit.owner, 'Permanent failure', false)
    clock.advance(4_000_000)
    expect(worker.claim()).toBeUndefined()
    expect(store.database.prepare('SELECT next_attempt_at FROM wiki_automation_jobs WHERE id = ?').get(job.id)).toEqual({ next_attempt_at: null })
  })
  it('recovers legacy interrupted jobs and stops automatically recovering a repeatedly expired lease', async () => {
    const { store, worker, jobs, clock } = await fixture()
    const job = jobs.createJob({ title: 'Old worker', promptMarkdown: 'Evidence' })
    jobs.startNextJob()
    expect(worker.claim()?.job.attemptCount).toBe(2)
    store.database.prepare('UPDATE wiki_automation_jobs SET attempt_count = 5 WHERE id = ?').run(job.id)
    clock.advance(121_000)
    expect(worker.claim()).toBeUndefined()
    expect(jobs.getJob(job.id).status).toBe('failed')
  })
})

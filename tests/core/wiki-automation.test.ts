import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { WikiWorkerRepository } from '../../src/core/wiki-worker'

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }))

const cleanupPaths: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRepository(): Promise<{
  rootPath: string
  store: ProjectStore
  automation: WikiAutomationRepository
  clock: FrozenClock
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-automation-'))
  cleanupPaths.push(rootPath)
  const clock = new FrozenClock(new Date('2026-08-14T00:00:00.000Z'))
  const store = await ProjectStore.initialize({ rootPath, name: 'Wiki automation' }, { clock })
  let sequence = 0
  return {
    rootPath,
    store,
    clock,
    automation: new WikiAutomationRepository(store, { clock, id: () => `wiki-id-${++sequence}` })
  }
}

function expectErrorCode(action: () => unknown, code: string): void {
  let received: unknown
  try {
    action()
  } catch (error) {
    received = error
  }
  expect(received).toMatchObject({ code })
}

describe('WikiAutomationRepository', () => {
  it('durably records generation jobs, artifacts, and handoffs through their lifecycle', async () => {
    const { automation, clock, store } = await createRepository()
    const job = automation.createJob({
      title: 'Document architecture',
      promptMarkdown: 'Generate architecture wiki content.',
      sourcePaths: ['src/core'],
      requestedBy: 'andrew'
    })

    expect(automation.listJobs()).toEqual([job])
    expect(automation.startNextJob()).toMatchObject({ id: job.id, status: 'running', startedAt: job.createdAt })
    expect(automation.startNextJob()).toBeUndefined()
    const artifact = automation.addArtifact(job.id, {
      kind: 'wiki_draft',
      title: 'Architecture draft',
      contentMarkdown: '# Architecture',
      relativePath: 'architecture.md',
      metadata: { model: 'local' }
    })
    const handoff = automation.createHandoff(job.id, {
      target: 'human-review',
      summaryMarkdown: 'Review the generated architecture draft.',
      payload: { artifactId: artifact.id }
    })

    expect(automation.listArtifacts(job.id)).toEqual([artifact])
    expect(automation.listHandoffs(job.id)).toEqual([handoff])
    expect(automation.getJobReport(job.id)).toEqual({
      job: expect.objectContaining({ id: job.id, status: 'running' }),
      artifacts: [artifact],
      handoffs: [handoff]
    })
    clock.advance(1_000)
    expect(automation.resolveHandoff(handoff.id, true)).toMatchObject({
      status: 'accepted',
      resolvedAt: '2026-08-14T00:00:01.000Z'
    })
    expect(automation.completeJob(job.id)).toMatchObject({
      status: 'completed',
      completedAt: '2026-08-14T00:00:01.000Z'
    })
    expectErrorCode(() => automation.completeJob(job.id), 'INVALID_STATE_TRANSITION')
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM wiki_automation_artifacts').get()).toEqual({ count: 1 })
    store.close()
  })

  it('records failed jobs and rejects invalid lifecycle transitions', async () => {
    const { automation, store } = await createRepository()
    const job = automation.createJob({ title: 'Broken generation', promptMarkdown: 'Generate.' })

    expectErrorCode(() => automation.completeJob(job.id), 'INVALID_STATE_TRANSITION')
    automation.startNextJob()
    expect(automation.failJob(job.id, 'Provider unavailable')).toMatchObject({
      status: 'failed',
      errorMessage: 'Provider unavailable'
    })
    expectErrorCode(() => automation.createHandoff('missing', { target: 'human', summaryMarkdown: 'Review.' }), 'VALIDATION_ERROR')
    store.close()
  })

  it('atomically creates one durable merged-PR job and can retry failed or interrupted work', async () => {
    const { automation, store } = await createRepository()
    const input = {
      title: 'PR #42: Document durable merge evidence',
      promptMarkdown: 'Generate documentation from this merge.',
      sourcePaths: ['src/core/wiki-automation.ts'],
      mergeEvidence: {
        pullRequestUrl: 'https://github.com/acme/workstack/pull/42',
        pullRequestNumber: 42,
        pullRequestTitle: 'Document durable merge evidence',
        headRefName: 'feature/wiki-evidence',
        mergedAt: '2026-08-14T00:00:00.000Z',
        mergeCommitSha: 'abc123',
        workItemId: 'work-item-42',
        sessionSummaryMarkdown: 'Added durable merge evidence.',
        diffMarkdown: 'diff --git a/src/core/wiki-automation.ts b/src/core/wiki-automation.ts'
      }
    }
    const job = automation.createMergedPullRequestJob(input)
    expect(automation.createMergedPullRequestJob(input)).toEqual(job)
    expect(automation.listJobs()).toEqual([job])
    expect(automation.getMergeEvidence(job.id)).toMatchObject({
      jobId: job.id,
      pullRequestNumber: 42,
      mergeCommitSha: 'abc123',
      diffMarkdown: input.mergeEvidence.diffMarkdown
    })

    expect(automation.startNextJob()).toMatchObject({ id: job.id, status: 'running', attemptCount: 1 })
    expect(automation.retryInterruptedJobs()).toMatchObject([{ id: job.id, status: 'pending', attemptCount: 1 }])
    expect(automation.startNextJob()).toMatchObject({ id: job.id, attemptCount: 2 })
    automation.failJob(job.id, 'Provider unavailable')
    expect(automation.retryFailedJobs()).toMatchObject([{ id: job.id, status: 'pending', errorMessage: null, attemptCount: 0 }])
    expectErrorCode(() => automation.retryJob(job.id), 'INVALID_STATE_TRANSITION')
    store.close()
  })

  it('builds a bounded graph of resolvable local imports without escaping the project', async () => {
    const { automation, rootPath, store } = await createRepository()
    await mkdir(path.join(rootPath, 'src', 'feature'), { recursive: true })
    await writeFile(path.join(rootPath, 'src', 'index.ts'), "import { feature } from './feature'\nexport { feature }\n")
    await writeFile(path.join(rootPath, 'src', 'feature', 'index.ts'), "export { value as feature } from './value'\n")
    await writeFile(path.join(rootPath, 'src', 'feature', 'value.ts'), "import path from 'node:path'\nexport const value = path.sep\n")
    await writeFile(path.join(rootPath, 'src', 'ignored.ts'), "import '../outside'\n")
    await writeFile(path.join(rootPath, 'outside.ts'), 'export const outside = true\n')

    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/index.ts'] })).toEqual({
      nodes: [{ path: 'src/feature/index.ts' }, { path: 'src/feature/value.ts' }, { path: 'src/index.ts' }],
      edges: [
        { from: 'src/feature/index.ts', to: 'src/feature/value.ts' },
        { from: 'src/index.ts', to: 'src/feature/index.ts' }
      ],
      truncated: false
    })
    expect(automation.buildLocalDependencyGraph({ maxFiles: 1, maxEdges: 1 }).truncated).toBe(true)
    expectErrorCode(() => automation.buildLocalDependencyGraph({ entryPaths: ['../outside.ts'] }), 'VALIDATION_ERROR')
    store.close()
  })

  it('selects the most relevant prior graph snapshot and computes a bounded delta', async () => {
    const { automation, store } = await createRepository()
    const matchingJob = automation.createJob({
      title: 'Matching graph',
      promptMarkdown: 'Generate.',
      sourcePaths: ['src/shared.ts']
    })
    const matchingArtifact = automation.addArtifact(matchingJob.id, {
      kind: 'dependency_graph',
      title: 'Matching graph snapshot',
      contentMarkdown: 'legacy snapshot',
      metadata: {
        graph: {
          nodes: [{ path: 'src/old.ts' }, { path: 'src/shared.ts' }],
          edges: [{ from: 'src/shared.ts', to: 'src/old.ts' }],
          truncated: false
        }
      }
    })
    const unrelatedJob = automation.createJob({
      title: 'Unrelated graph',
      promptMarkdown: 'Generate.',
      sourcePaths: ['src/other.ts']
    })
    automation.addArtifact(unrelatedJob.id, {
      kind: 'dependency_graph',
      title: 'Unrelated graph snapshot',
      contentMarkdown: 'legacy snapshot',
      metadata: {
        graph: { nodes: [{ path: 'src/other.ts' }], edges: [], truncated: false }
      }
    })
    const currentJob = automation.createJob({
      title: 'Current graph',
      promptMarkdown: 'Generate.',
      sourcePaths: ['src/shared.ts']
    })

    const prior = automation.findMostRelevantDependencyGraphArtifact(currentJob.id)
    const delta = automation.buildLocalDependencyGraphDelta({
      nodes: [{ path: 'src/new.ts' }, { path: 'src/shared.ts' }],
      edges: [{ from: 'src/shared.ts', to: 'src/new.ts' }],
      truncated: false
    }, prior && automation.getDependencyGraphSnapshot(prior), 1)

    expect(prior?.id).toBe(matchingArtifact.id)
    expect(delta).toEqual({
      addedNodes: [{ path: 'src/new.ts' }],
      removedNodes: [{ path: 'src/old.ts' }],
      addedEdges: [{ from: 'src/shared.ts', to: 'src/new.ts' }],
      removedEdges: [{ from: 'src/shared.ts', to: 'src/old.ts' }],
      truncated: true
    })
    store.close()
  })

  it('preserves atomic lifecycle transitions and gives exhausted failed jobs a fresh explicit retry', async () => {
    const { automation, store, clock } = await createRepository()
    const job = automation.createJob({ title: 'Recovery', promptMarkdown: 'Preserve evidence.' })
    expect(() => automation.getMergeEvidence(job.id)).toThrow('evidence was not found')
    expect(() => automation.failJob(job.id, ' ')).toThrow('failure reason')
    expect(() => automation.resolveHandoff('missing', true)).toThrow('handoff was not found')
    const handoff = automation.createHandoff(job.id, { target: 'owner', summaryMarkdown: 'Review rejected evidence.' })
    expect(automation.resolveHandoff(handoff.id, false).status).toBe('rejected')
    expect(() => automation.resolveHandoff(handoff.id, true)).toThrow('already resolved')
    store.database.exec("CREATE TRIGGER reject_start BEFORE UPDATE ON wiki_automation_jobs WHEN NEW.status='running' BEGIN SELECT RAISE(IGNORE); END")
    expect(automation.startNextJob()).toBeUndefined()
    expect(automation.getJob(job.id).status).toBe('pending')
    store.database.exec('DROP TRIGGER reject_start')
    automation.startNextJob()
    automation.failJob(job.id, 'Failed final attempt')
    store.database.prepare('UPDATE wiki_automation_jobs SET attempt_count=5 WHERE id=?').run(job.id)
    store.database.exec("CREATE TRIGGER reject_retry BEFORE UPDATE ON wiki_automation_jobs WHEN NEW.status='pending' BEGIN SELECT RAISE(IGNORE); END")
    expect(() => automation.retryFailedJobs()).toThrow('retry was interrupted')
    expect(automation.getJob(job.id).status).toBe('failed')
    store.database.exec('DROP TRIGGER reject_retry')
    expect(automation.retryFailedJobs()).toMatchObject([{ id: job.id, attemptCount: 0 }])
    expect(new WikiWorkerRepository(store, clock).claim()?.job).toMatchObject({ id: job.id, attemptCount: 1 })
    store.close()
  })

  it('rejects an unrelated job identity conflict without inventing merge evidence', async () => {
    const { automation, store } = await createRepository()
    const job = automation.createJob({ title: 'Existing job', promptMarkdown: 'Evidence' })
    const collision = new WikiAutomationRepository(store, { id: () => job.id })
    expect(() => collision.createMergedPullRequestJob({ title: 'Merge', promptMarkdown: 'Merged evidence', mergeEvidence: {
      pullRequestUrl: 'https://github.com/example/repo/pull/1', pullRequestNumber: 1, pullRequestTitle: 'Merged change', headRefName: 'feature/change', mergeCommitSha: 'a'.repeat(40), workItemId: 'task', diffMarkdown: ''
    } })).toThrow('could not be read after conflict')
    expect(automation.listJobs()).toEqual([job])
    expect(automation.getJobReport(job.id).mergeEvidence).toBeUndefined()
    const merged = automation.createMergedPullRequestJob({ title: 'Merge without upstream time', promptMarkdown: 'Merged evidence', mergeEvidence: {
      pullRequestUrl: 'https://github.com/example/repo/pull/1', pullRequestNumber: 1, pullRequestTitle: 'Merged change', headRefName: 'feature/change', mergeCommitSha: 'a'.repeat(40), workItemId: 'task', diffMarkdown: ''
    } })
    expect(automation.getMergeEvidence(merged.id).mergedAt).toBeNull()
    const draft = automation.addArtifact(merged.id, { kind: 'wiki_draft', title: 'Draft', contentMarkdown: 'Reviewed draft.' })
    expect(automation.getDependencyGraphSnapshot(draft)).toBeUndefined()
    store.close()
  })

  it('uses stable recency and identity tie breaks for equally relevant graph artifacts', async () => {
    const { automation, store, clock } = await createRepository()
    const first = automation.createJob({ title: 'First', promptMarkdown: 'Graph', sourcePaths: ['src'] })
    const second = automation.createJob({ title: 'Second', promptMarkdown: 'Graph', sourcePaths: ['src'] })
    const current = automation.createJob({ title: 'Current', promptMarkdown: 'Graph', sourcePaths: ['src'] })
    const makeGraph = (jobId: string) => automation.addArtifact(jobId, { kind: 'dependency_graph', title: 'Graph', contentMarkdown: JSON.stringify({ nodes: [{ path: 'src/a.ts' }], edges: [], truncated: false }) })
    makeGraph(first.id)
    clock.advance(1000)
    makeGraph(second.id)
    const latest = makeGraph(first.id)
    expect(automation.findMostRelevantDependencyGraphArtifact(current.id)?.id).toBe(latest.id)
    const delta = automation.buildLocalDependencyGraphDelta({ nodes: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], edges: [{ from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'a', to: 'b' }], truncated: false }, { nodes: [], edges: [{ from: 'x', to: 'z' }, { from: 'x', to: 'y' }], truncated: false })
    expect(delta.addedEdges).toEqual([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }])
    expect(delta.removedEdges).toEqual([{ from: 'x', to: 'y' }, { from: 'x', to: 'z' }])
    expect(delta.truncated).toBe(false)
    store.close()
  })

  it('bounds graph discovery and expansion and handles unreadable or missing source files', async () => {
    const { automation, rootPath, store } = await createRepository()
    await mkdir(path.join(rootPath, 'src', 'nested'), { recursive: true })
    await writeFile(path.join(rootPath, 'src', 'a.ts'), "import './b'\nimport './c'\nimport '../../outside'\nimport './missing'\n")
    await writeFile(path.join(rootPath, 'src', 'b.ts'), "import './a'\n")
    await writeFile(path.join(rootPath, 'src', 'c.ts'), 'export const c=1\n')
    await writeFile(path.join(rootPath, 'src', 'nested', 'd.ts'), 'export const d=1\n')
    const full = automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts', 'src/a.ts'] })
    expect(full.truncated).toBe(false)
    expect(full.edges).toHaveLength(3)
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts'], maxFiles: 1 })).toMatchObject({ nodes: [{ path: 'src/a.ts' }], edges: [], truncated: true })
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts'], maxFiles: 2 }).truncated).toBe(true)
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts'], maxEdges: 1 })).toMatchObject({ edges: [{ from: 'src/a.ts', to: 'src/b.ts' }], truncated: true })
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts'], maxFileBytes: 1 }).edges).toEqual([])
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['missing.ts', 'src'] }).nodes).toEqual([])
    expect(automation.buildLocalDependencyGraph({ maxFiles: 1 }).truncated).toBe(true)
    const read = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === path.join(rootPath, 'src', 'a.ts')) throw new Error('Source file became unreadable')
      return Reflect.apply(read, fs, [file, ...args])
    }) as typeof fs.readFileSync)
    expect(automation.buildLocalDependencyGraph({ entryPaths: ['src/a.ts'] })).toMatchObject({ nodes: [{ path: 'src/a.ts' }], edges: [] })
    store.close()
  })
})

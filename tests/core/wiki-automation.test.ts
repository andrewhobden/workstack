import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'

const cleanupPaths: string[] = []

afterEach(async () => {
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
    expect(automation.retryFailedJobs()).toMatchObject([{ id: job.id, status: 'pending', errorMessage: null, attemptCount: 2 }])
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
})

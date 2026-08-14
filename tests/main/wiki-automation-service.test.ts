import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { ProjectStore } from '../../src/core/project-store'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WikiAutomationService', () => {
  it('atomically deduplicates merged PRs and durably records their generation evidence', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-service-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Automation test' })
    store.close()
    const baselineStore = await ProjectStore.open(rootPath)
    const baselineRepository = new WikiAutomationRepository(baselineStore)
    const baselineJob = baselineRepository.createJob({
      title: 'Prior graph',
      promptMarkdown: 'Generate.',
      sourcePaths: []
    })
    baselineRepository.startNextJob()
    const baselineArtifact = baselineRepository.addArtifact(baselineJob.id, {
      kind: 'dependency_graph',
      title: 'Prior graph snapshot',
      contentMarkdown: 'legacy graph snapshot',
      metadata: {
        graph: {
          nodes: [{ path: 'src/removed.ts' }],
          edges: [],
          truncated: false
        }
      }
    })
    baselineRepository.completeJob(baselineJob.id)
    baselineStore.close()
    const articles = new Map<string, string>()
    const projects = {
      getProject: async () => ({ id: 'project-id', name: 'Automation test', rootPath }),
      getCompletion: async () => ({ sessionSummaryMarkdown: 'The worker added the durable project wiki.' }),
      listProjects: async () => [],
      saveGeneratedWikiArticle: async (_projectId: string, slug: string, content: string) => {
        articles.set(slug, content)
        return { slug, content }
      }
    }
    const provider = { propose: async (prompt: string) => `# Generated\n\n${prompt.includes('next coding agent') ? 'Agent brief.' : 'Evidence-based documentation.'}` }
    const service = new WikiAutomationService(projects as never, provider as never)
    const merged = {
      projectId: 'project-id',
      workItemId: 'work-item-id',
      pullRequest: {
        headRefName: 'feature/wiki',
        mergeCommit: { oid: 'missing-commit' },
        mergedAt: '2026-08-14T00:00:00Z',
        number: 12,
        title: 'Document wiki automation',
        url: 'https://github.com/example/repo/pull/12'
      }
    }

    await Promise.all([
      service.handleMergedPullRequest(merged),
      service.handleMergedPullRequest(merged),
      service.handleMergedPullRequest(merged)
    ])
    await (service as unknown as { processProject(projectId: string): Promise<void> }).processProject('project-id')

    const reopened = await ProjectStore.open(rootPath)
    const repository = new WikiAutomationRepository(reopened)
    const jobs = repository.listJobs()
    const currentJob = jobs.find((job) => job.requestedBy?.includes('missing-commit'))!
    const report = repository.getJobReport(currentJob.id)
    const evidence = repository.getMergeEvidence(currentJob.id)
    reopened.close()
    expect(jobs).toHaveLength(2)
    expect(currentJob).toMatchObject({ status: 'completed', requestedBy: expect.stringContaining('missing-commit') })
    expect(evidence).toMatchObject({
      pullRequestUrl: merged.pullRequest.url,
      pullRequestNumber: 12,
      mergeCommitSha: 'missing-commit',
      workItemId: 'work-item-id',
      sessionSummaryMarkdown: 'The worker added the durable project wiki.'
    })
    expect(report.artifacts).toHaveLength(5)
    expect(report.artifacts[0].kind).toBe('dependency_graph')
    expect(report.artifacts[0].metadata).toMatchObject({
      baselineArtifactId: baselineArtifact.id,
      graph: expect.any(Object),
      delta: expect.objectContaining({ addedNodes: expect.any(Array), removedNodes: [{ path: 'src/removed.ts' }] })
    })
    expect([...articles.keys()].sort()).toEqual([
      'generated-12-change-log',
      'generated-agent-brief',
      'generated-architecture',
      'generated-overview'
    ])
  })

  it('retries failed and interrupted jobs before processing them', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-service-retry-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Retry test' })
    const repository = new WikiAutomationRepository(store)
    const interrupted = repository.createJob({ title: 'Interrupted', promptMarkdown: 'Document the interrupted job.' })
    repository.startNextJob()
    const failed = repository.createJob({ title: 'Failed', promptMarkdown: 'Document the failed job.' })
    repository.startNextJob()
    repository.failJob(failed.id, 'Provider was unavailable')
    store.close()

    const projects = {
      getProject: async () => ({ id: 'project-id', name: 'Retry test', rootPath }),
      getCompletion: async () => undefined,
      listProjects: async () => [],
      saveGeneratedWikiArticle: async (_projectId: string, slug: string, content: string) => ({ slug, content })
    }
    const provider = { propose: async () => '# Recovered documentation' }
    const service = new WikiAutomationService(projects as never, provider as never)

    await (service as unknown as { processProject(projectId: string): Promise<void> }).processProject('project-id')

    const reopened = await ProjectStore.open(rootPath)
    const jobs = new WikiAutomationRepository(reopened).listJobs()
    reopened.close()
    expect(jobs).toHaveLength(2)
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: interrupted.id, status: 'completed', attemptCount: 2 }),
      expect.objectContaining({ id: failed.id, status: 'completed', attemptCount: 2 })
    ]))
  })

  it('queues a manual full-codebase rescan that graphifies and safely refreshes only generated articles', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-service-rescan-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Rescan test' })
    new KnowledgeRepository(store).saveWikiArticle('team-notes', '# Human-authored notes')
    store.close()
    await mkdir(path.join(rootPath, 'src'), { recursive: true })
    await writeFile(path.join(rootPath, 'src', 'index.ts'), "export { feature } from './feature'\n")
    await writeFile(path.join(rootPath, 'src', 'feature.ts'), 'export const feature = true\n')

    const projects = {
      getProject: async () => ({ id: 'project-id', name: 'Rescan test', rootPath }),
      getCompletion: async () => undefined,
      listProjects: async () => [],
      saveGeneratedWikiArticle: async (_projectId: string, slug: string, content: string) => {
        const projectStore = await ProjectStore.open(rootPath)
        try {
          return new KnowledgeRepository(projectStore).saveGeneratedWikiArticle(slug, content)
        } finally {
          projectStore.close()
        }
      }
    }
    const provider = { propose: async (prompt: string) => `# Generated\n\n${prompt}` }
    const service = new WikiAutomationService(projects as never, provider as never)
    const job = await service.requestFullCodebaseRescan('project-id')
    await (service as unknown as { processProject(projectId: string): Promise<void> }).processProject('project-id')

    const reopened = await ProjectStore.open(rootPath)
    const repository = new WikiAutomationRepository(reopened)
    const report = repository.getJobReport(job.id)
    const articles = new KnowledgeRepository(reopened).listWikiArticles()
    reopened.close()
    expect(articles).toContainEqual({ slug: 'team-notes', content: '# Human-authored notes' })
    expect(report.job).toMatchObject({
      status: 'completed',
      requestedBy: 'manual-full-codebase-rescan'
    })
    expect(report.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'dependency_graph',
        metadata: expect.objectContaining({
          graph: expect.objectContaining({
            nodes: expect.arrayContaining([{ path: 'src/index.ts' }, { path: 'src/feature.ts' }])
          })
        })
      }),
      expect.objectContaining({ kind: 'wiki_article', relativePath: 'wiki/generated-codebase-map.md' })
    ]))
  })
})

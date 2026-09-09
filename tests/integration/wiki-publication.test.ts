import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-publication-')); roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '--quiet'); git('config', 'user.name', 'Workstack Test'); git('config', 'user.email', 'test@example.invalid')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'contract.ts'), 'export const persistence = "SQLite transaction"\n')
  git('add', 'src/contract.ts'); git('commit', '--quiet', '-m', 'Initial persistence contract')
  const commit = git('rev-parse', 'HEAD')
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Project context' })
  new KnowledgeRepository(store).saveWikiArticle('human-policy', '# Reviewed human policy')
  store.close()
  const projects = { getProject: async () => ({ id: 'project-id', name: 'Project context', rootPath: root }), getCompletion: async () => ({ sessionSummaryMarkdown: 'Observed persistence behavior.' }), listProjects: async () => [] }
  const merged = (number: number) => ({ projectId: 'project-id', workItemId: `work-${number}`, pullRequest: { headRefName: `feature/${number}`, mergeCommit: { oid: commit }, mergedAt: '2026-09-09T00:00:00Z', number, title: `Independent feature ${number}`, url: `https://github.com/example/repo/pull/${number}` } })
  return { root, projects, merged }
}
const drain = (service: WikiAutomationService) => (service as unknown as { processProject(projectId: string): Promise<void> }).processProject('project-id')

describe('completion evidence to reviewed wiki', () => {
  it('preserves independent PR facts, human authority and complete generation provenance', async () => {
    const { root, projects, merged } = await fixture()
    const prompts: string[] = []
    const service = new WikiAutomationService(projects as never, { propose: async (prompt: string) => {
      prompts.push(prompt)
      return prompt.includes('Pull request: #2 ') ? 'Feature Two adds durable retries.' : 'Feature One establishes atomic claims.'
    } } as never)
    await service.handleMergedPullRequest(merged(1)); await drain(service)
    let store = await ProjectStore.open(root)
    let revisions = new WikiRevisionRepository(store)
    const first = revisions.list()[0]
    expect(first.status).toBe('proposed')
    expect(new KnowledgeRepository(store).search('atomic')).toEqual([])
    revisions.publish(first.id, 'Owner', 'Reviewed PR #1 and source contract')
    store.close()
    await service.handleMergedPullRequest(merged(2)); await drain(service)
    store = await ProjectStore.open(root); revisions = new WikiRevisionRepository(store)
    const second = revisions.list()[0]
    expect(second.baseRevisionId).toBe(first.id)
    expect(prompts.slice(4).filter((prompt) => prompt.includes('atomic claims'))).toHaveLength(3)
    expect(second.evidence).toMatchObject({ sourcePaths: ['src/contract.ts'], codeEvidence: { included: ['src/contract.ts'], excerpts: [{ path: 'src/contract.ts', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), workingTree: true }] } })
    revisions.publish(second.id, 'Owner', 'Reviewed PR #2')
    const architecture = new KnowledgeRepository(store).listWikiArticles().find((article) => article.slug === 'generated-architecture')!
    expect(architecture.content).toContain('atomic claims')
    expect(architecture.content).toContain('durable retries')
    expect(new KnowledgeRepository(store).listWikiArticles()).toContainEqual({ slug: 'human-policy', content: '# Reviewed human policy' })
    store.close()
    await service.handleMergedPullRequest(merged(2)); await drain(service)
    store = await ProjectStore.open(root)
    expect(new WikiRevisionRepository(store).list()).toHaveLength(2)
    expect(prompts).toHaveLength(8)
    store.close()
  })

  it('leaves the accepted snapshot untouched on partial provider failure, then stages one complete retry', async () => {
    const { root, projects, merged } = await fixture()
    let calls = 0
    let failing = true
    const service = new WikiAutomationService(projects as never, { propose: async () => {
      calls += 1
      if (failing && calls === 2) throw new Error('Temporary provider outage')
      return 'Evidence-backed update.'
    } } as never)
    let store = await ProjectStore.open(root)
    const revisions = new WikiRevisionRepository(store)
    const baseline = revisions.stage({ requestKey: 'baseline', title: 'Accepted baseline', pages: [{ slug: 'generated-overview', content: '# Durable prior facts' }] })
    revisions.publish(baseline.revision.id, 'Owner')
    store.close()
    await service.handleMergedPullRequest(merged(1)); await drain(service)
    store = await ProjectStore.open(root)
    let jobs = new WikiAutomationRepository(store)
    const job = jobs.listJobs()[0]
    expect(job).toMatchObject({ status: 'failed', attemptCount: 1, errorMessage: 'Temporary provider outage' })
    expect(jobs.listArtifacts(job.id)).toEqual([])
    expect(new WikiRevisionRepository(store).currentId()).toBe(baseline.revision.id)
    expect(new WikiRevisionRepository(store).list()).toHaveLength(1)
    jobs.retryJob(job.id)
    store.close()
    failing = false
    await drain(service)
    store = await ProjectStore.open(root); jobs = new WikiAutomationRepository(store)
    const proposed = new WikiRevisionRepository(store).list()[0]
    expect(proposed.status).toBe('proposed')
    expect(jobs.getJob(job.id).status).toBe('completed')
    expect(jobs.listArtifacts(job.id)).toHaveLength(5)
    expect(new WikiRevisionRepository(store).currentId()).toBe(baseline.revision.id)
    const accepted = new WikiRevisionRepository(store).publish(proposed.id, 'Owner')
    expect(accepted.pages.find((page) => page.slug === 'generated-overview')?.content.match(/Evidence-backed update/g)).toHaveLength(1)
    expect(accepted.pages.find((page) => page.slug === 'generated-overview')?.content).toContain('Durable prior facts')
    store.close()
  })

  it('treats missing canonical Git evidence as a recoverable delivery error rather than successful empty evidence', async () => {
    const { root, projects, merged } = await fixture()
    let calls = 0
    const service = new WikiAutomationService(projects as never, { propose: async () => { calls += 1; return '# Should not generate' } } as never)
    await expect(service.handleMergedPullRequest({ ...merged(1), pullRequest: { ...merged(1).pullRequest, mergeCommit: null } })).rejects.toThrow('Canonical merge commit evidence is missing')
    await expect(service.handleMergedPullRequest({ ...merged(1), pullRequest: { ...merged(1).pullRequest, mergeCommit: { oid: 'a'.repeat(40) } } })).rejects.toThrow()
    const store = await ProjectStore.open(root)
    expect(new WikiAutomationRepository(store).listJobs()).toEqual([])
    expect(calls).toBe(0)
    store.close()
  })

  it('prevents two app instances from running the same active generation', async () => {
    const { root, projects, merged } = await fixture()
    let notifyStarted!: () => void
    let continueGeneration!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const gate = new Promise<void>((resolve) => { continueGeneration = resolve })
    let calls = 0
    const provider = { propose: async () => { calls += 1; notifyStarted(); await gate; return 'Atomic generation ownership.' } }
    const first = new WikiAutomationService(projects as never, provider as never)
    const second = new WikiAutomationService(projects as never, provider as never)
    await first.handleMergedPullRequest(merged(1))
    await started
    await second.handleMergedPullRequest(merged(1)); await drain(second)
    expect(calls).toBe(1)
    continueGeneration(); await drain(first)
    const store = await ProjectStore.open(root)
    expect(new WikiRevisionRepository(store).list()).toHaveLength(1)
    expect(calls).toBe(4)
    store.close()
  })
})

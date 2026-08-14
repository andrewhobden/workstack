import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore } from '../../src/core/project-store'
import { ProjectsService } from '../../src/core/projects-service'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { buildCopilotSessionContext } from '../../src/main/copilot-launcher'
import { PullRequestService } from '../../src/main/pull-requests'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'
import { WorkstackMcpTools } from '../../src/mcp/server'

const run = promisify(execFile)
const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRepository(): Promise<string> {
  const rootPath = path.join(process.cwd(), `.workstack-wiki-integration-${randomUUID()}`)
  cleanupPaths.push(rootPath)
  await mkdir(path.join(rootPath, 'src'), { recursive: true })
  await writeFile(path.join(rootPath, 'src', 'merge-evidence.ts'), 'export const mergedEvidence = true\n')
  await run('git', ['init', '--quiet'], { cwd: rootPath })
  await run('git', ['config', 'user.email', 'workstack-tests@example.test'], { cwd: rootPath })
  await run('git', ['config', 'user.name', 'Workstack Tests'], { cwd: rootPath })
  await run('git', ['add', '.'], { cwd: rootPath })
  await run('git', ['commit', '--quiet', '-m', 'Add merge evidence'], { cwd: rootPath })
  return rootPath
}

describe('merged pull request wiki automation', () => {
  it('carries a merged PR through durable evidence, retry, generated documents, MCP, and launcher context exactly once', async () => {
    const rootPath = await createRepository()
    const projects = new ProjectsService(new ProjectRegistry(path.join(rootPath, 'registry.json')))
    const project = await projects.createProject({ rootPath, name: 'Merge evidence project', workItemPrefix: 'WIKI' })
    const workItem = await projects.createWorkItem(project.id, {
      title: 'Document merge evidence',
      descriptionMarkdown: 'Persist merge evidence and generate a useful wiki handoff.',
      acceptanceCriteriaMarkdown: 'Agents can retrieve generated merge context.'
    })
    const claim = await projects.claimWorkItem(project.id, workItem.id, { agentId: 'integration-agent' })
    const pullRequestUrl = 'https://github.com/example/workstack/pull/42'
    await projects.completeWorkItem(project.id, workItem.id, claim.claimToken, {
      summaryMarkdown: 'Submitted durable merge evidence.',
      sessionSummaryMarkdown: 'The merge adds durable evidence for the next coding agent.',
      prUrl: pullRequestUrl
    })
    const mergeCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: rootPath })).stdout.trim()
    let generationCalls = 0
    const provider = {
      propose: async (prompt: string) => {
        generationCalls += 1
        if (generationCalls === 1) throw new Error('transient provider outage')
        return `# Generated documentation\n\n${prompt.includes('next coding agent')
          ? 'The next coding agent should inspect src/merge-evidence.ts.'
          : 'The merged change records durable evidence.'}`
      }
    }
    const automation = new WikiAutomationService(projects, provider as never)
    const pullRequests = new PullRequestService(
      projects,
      {} as never,
      async () => JSON.stringify([{
        author: { login: 'integration-agent' },
        headRefName: 'feature/merge-evidence',
        isDraft: false,
        mergeCommit: { oid: mergeCommit },
        mergedAt: '2026-08-14T00:00:00.000Z',
        number: 42,
        state: 'MERGED',
        title: 'Document merge evidence',
        updatedAt: '2026-08-14T00:00:01.000Z',
        url: pullRequestUrl
      }]),
      automation
    )

    await expect(pullRequests.list(project.id)).resolves.toEqual([])
    await (automation as unknown as { processProject(projectId: string): Promise<void> }).processProject(project.id)
    await (automation as unknown as { processProject(projectId: string): Promise<void> }).processProject(project.id)
    await expect(pullRequests.list(project.id)).resolves.toEqual([])

    const store = await ProjectStore.open(rootPath)
    const repository = new WikiAutomationRepository(store)
    const [job] = repository.listJobs()
    const evidence = repository.getMergeEvidence(job.id)
    const report = repository.getJobReport(job.id)
    store.close()

    expect(job).toMatchObject({ status: 'completed', attemptCount: 2, requestedBy: `merged-pull-request:${pullRequestUrl}:${mergeCommit}` })
    expect(evidence).toMatchObject({
      pullRequestUrl,
      pullRequestNumber: 42,
      mergeCommitSha: mergeCommit,
      workItemId: workItem.id,
      sessionSummaryMarkdown: 'The merge adds durable evidence for the next coding agent.'
    })
    expect(evidence.diffMarkdown).toContain('src/merge-evidence.ts')
    expect(report.artifacts.filter((artifact) => artifact.kind === 'wiki_article')).toHaveLength(4)

    const mcp = new WorkstackMcpTools(projects)
    await expect(mcp.call('workstack_list_wiki_articles', { project: project.name })).resolves.toMatchObject({
      articles: expect.arrayContaining([
        expect.objectContaining({ slug: 'generated-agent-brief' }),
        expect.objectContaining({ slug: 'generated-42-change-log' })
      ])
    })
    await expect(mcp.call('workstack_get_wiki_article', {
      project: project.name,
      slug: 'generated-agent-brief'
    })).resolves.toMatchObject({
      article: { content: expect.stringContaining('src/merge-evidence.ts') }
    })

    const context = await buildCopilotSessionContext(await projects.getProject(project.id), workItem)
    expect(context).toContain('## generated-agent-brief')
    expect(context).toContain('The next coding agent should inspect src/merge-evidence.ts.')
    expect(context).toContain('Recent graph evidence (relevance-selected and bounded):')
  })
})

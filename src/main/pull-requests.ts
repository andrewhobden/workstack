import { spawn } from 'node:child_process'
import { WorkstackError } from '../core/errors'
import { ProjectsService } from '../core/projects-service'
import type { ProjectPullRequest } from '../shared/desktop-api'
import { CopilotLauncher } from './copilot-launcher'

interface GitHubPullRequest {
  author: { login: string } | null
  headRefName: string
  isDraft: boolean
  mergeCommit: { oid: string } | null
  mergedAt: string | null
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  title: string
  updatedAt: string
  url: string
}

export interface MergedPullRequestHandler {
  handleMergedPullRequest(input: {
    projectId: string
    workItemId: string
    pullRequest: Pick<GitHubPullRequest, 'headRefName' | 'mergeCommit' | 'mergedAt' | 'number' | 'title' | 'url'>
  }): Promise<void>
}

export class PullRequestService {
  private readonly runGh: (args: string[], cwd: string) => Promise<string>

  constructor(
    private readonly projects: ProjectsService,
    private readonly copilot: CopilotLauncher,
    runGh?: (args: string[], cwd: string) => Promise<string>,
    private readonly mergedPullRequestHandler?: MergedPullRequestHandler
  ) {
    this.runGh = runGh ?? runGitHubCli
  }

  async merge(projectId: string, urls: string[]): Promise<void> {
    const selectedUrls = new Set(urls)
    const selected = (await this.list(projectId)).filter((pullRequest) => selectedUrls.has(pullRequest.url))
    if (!selected.length) {
      throw new WorkstackError('VALIDATION_ERROR', 'Select at least one open pull request to merge.')
    }
    await this.copilot.launchMerge(await this.projects.getProject(projectId), selected)
  }

  async list(projectId: string): Promise<ProjectPullRequest[]> {
    const rootPath = await this.projects.verifyProjectRoot(projectId)
    const pullRequests = JSON.parse(await this.runGh([
      'pr', 'list', '--state', 'all', '--limit', '100',
      '--json', 'number,title,url,headRefName,isDraft,author,updatedAt,state,mergedAt,mergeCommit'
    ], rootPath)) as GitHubPullRequest[]
    const workItems = await this.projects.listWorkItems(projectId)
    const completions = await Promise.all(workItems.map(async (item) => [item, await this.projects.getCompletion(projectId, item.id)] as const))
    const workItemByUrl = new Map(completions.flatMap(([item, completion]) => completion?.prUrl ? [[completion.prUrl, item] as const] : []))

    for (const pullRequest of pullRequests) {
      const workItem = workItemByUrl.get(pullRequest.url)
      if (pullRequest.state === 'MERGED' && workItem?.status === 'in_progress') {
        await this.projects.finalizeMergedPullRequestWorkItem(projectId, workItem.id)
        try {
          await this.mergedPullRequestHandler?.handleMergedPullRequest({
            projectId,
            workItemId: workItem.id,
            pullRequest: {
              headRefName: pullRequest.headRefName,
              mergeCommit: pullRequest.mergeCommit,
              mergedAt: pullRequest.mergedAt,
              number: pullRequest.number,
              title: pullRequest.title,
              url: pullRequest.url
            }
          })
        } catch (error) {
          console.error(`[pull-requests] Unable to queue wiki generation for PR #${pullRequest.number}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    return pullRequests
      .filter((pullRequest) => pullRequest.state === 'OPEN')
      .map((pullRequest) => {
        const workItem = workItemByUrl.get(pullRequest.url)
        return {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headRefName: pullRequest.headRefName,
          isDraft: pullRequest.isDraft,
          authorLogin: pullRequest.author?.login ?? null,
          updatedAt: pullRequest.updatedAt,
          workItem: workItem ? { displayId: workItem.displayId, title: workItem.title } : undefined
        }
      })
  }
}

async function runGitHubCli(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    process.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    process.once('error', (error) => reject(new WorkstackError('INTERNAL_ERROR', `Unable to run GitHub CLI: ${error.message}`)))
    process.once('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new WorkstackError('INTERNAL_ERROR', `Unable to list pull requests: ${stderr.trim() || `gh exited with code ${code ?? 'unknown'}`}`))
    })
  })
}

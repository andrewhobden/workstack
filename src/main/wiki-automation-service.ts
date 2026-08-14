import { spawn } from 'node:child_process'
import { ProjectStore } from '../core/project-store'
import { ProjectsService } from '../core/projects-service'
import { WikiAutomationRepository } from '../core/wiki-automation'
import type { LocalDependencyGraph, WikiAutomationJob } from '../core/types'
import { OpenAiCompatibleProvider } from './ai-provider'
import type { MergedPullRequestHandler } from './pull-requests'

const CATCHUP_INTERVAL_MS = 15 * 60 * 1_000
const MAX_DIFF_CHARACTERS = 60_000
const MAX_SOURCE_PATHS = 100
const FULL_RESCAN_MAX_FILES = 2_000
const FULL_RESCAN_MAX_EDGES = 10_000
const FULL_RESCAN_REQUESTED_BY = 'manual-full-codebase-rescan'

interface MergedPullRequest {
  headRefName: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
  number: number
  title: string
  url: string
}

interface DiffEvidence {
  commitSha: string
  diff: string
  sourcePaths: string[]
}

export class WikiAutomationService implements MergedPullRequestHandler {
  private readonly activeProjects = new Map<string, Promise<void>>()
  private catchupTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly projects: ProjectsService,
    private readonly provider: OpenAiCompatibleProvider
  ) {}

  start(): void {
    if (this.catchupTimer) return
    void this.catchUp()
    this.catchupTimer = setInterval(() => { void this.catchUp() }, CATCHUP_INTERVAL_MS)
  }

  stop(): void {
    if (this.catchupTimer) clearInterval(this.catchupTimer)
    this.catchupTimer = undefined
  }

  async handleMergedPullRequest(input: {
    projectId: string
    workItemId: string
    pullRequest: MergedPullRequest
  }): Promise<void> {
    try {
      await this.enqueueMergedPullRequest(input.projectId, input.workItemId, input.pullRequest)
      void this.processProject(input.projectId)
    } catch (error) {
      this.report('Unable to enqueue merged pull request wiki generation', error)
    }
  }

  /**
   * Queues a project-wide generated-wiki refresh and starts its durable worker.
   * A future IPC bridge can return the job ID immediately and use job reports for progress.
   */
  async requestFullCodebaseRescan(projectId: string): Promise<WikiAutomationJob> {
    const project = await this.projects.getProject(projectId)
    const store = await ProjectStore.open(project.rootPath)
    let job: WikiAutomationJob
    try {
      job = new WikiAutomationRepository(store).createJob({
        title: 'Manual full-codebase wiki rescan',
        requestedBy: FULL_RESCAN_REQUESTED_BY,
        promptMarkdown: fullCodebaseRescanPrompt()
      })
    } finally {
      store.close()
    }
    void this.processProject(projectId)
    return job
  }

  async catchUp(): Promise<void> {
    try {
      await Promise.all((await this.projects.listProjects()).map((project) => this.processProject(project.id)))
    } catch (error) {
      this.report('Unable to catch up wiki automation jobs', error)
    }
  }

  private async enqueueMergedPullRequest(
    projectId: string,
    workItemId: string,
    pullRequest: MergedPullRequest
  ): Promise<void> {
    const project = await this.projects.getProject(projectId)
    const evidence = await gatherDiffEvidence(project.rootPath, pullRequest.mergeCommit?.oid)
    const requestedBy = `merged-pull-request:${pullRequest.url}:${evidence.commitSha}`
    const sessionSummaryMarkdown = (await this.projects.getCompletion(projectId, workItemId))?.sessionSummaryMarkdown ?? ''
    const store = await ProjectStore.open(project.rootPath)
    try {
      const repository = new WikiAutomationRepository(store)
      repository.createMergedPullRequestJob({
        title: `PR #${pullRequest.number}: ${pullRequest.title}`,
        requestedBy,
        sourcePaths: evidence.sourcePaths,
        promptMarkdown: generationPrompt(
          workItemId,
          pullRequest,
          evidence,
          sessionSummaryMarkdown
        ),
        mergeEvidence: {
          pullRequestUrl: pullRequest.url,
          pullRequestNumber: pullRequest.number,
          pullRequestTitle: pullRequest.title,
          headRefName: pullRequest.headRefName,
          mergedAt: pullRequest.mergedAt,
          mergeCommitSha: evidence.commitSha,
          workItemId,
          sessionSummaryMarkdown,
          diffMarkdown: evidence.diff
        }
      })
    } finally {
      store.close()
    }
  }

  private processProject(projectId: string): Promise<void> {
    const active = this.activeProjects.get(projectId)
    if (active) return active

    const processing = this.processProjectQueue(projectId)
      .catch((error) => this.report(`Unable to process wiki automation jobs for project ${projectId}`, error))
      .finally(() => this.activeProjects.delete(projectId))
    this.activeProjects.set(projectId, processing)
    return processing
  }

  private async processProjectQueue(projectId: string): Promise<void> {
    const project = await this.projects.getProject(projectId)
    const recoveryStore = await ProjectStore.open(project.rootPath)
    try {
      const repository = new WikiAutomationRepository(recoveryStore)
      repository.retryInterruptedJobs()
      repository.retryFailedJobs()
    } finally {
      recoveryStore.close()
    }

    while (true) {
      const store = await ProjectStore.open(project.rootPath)
      let job
      try {
        job = new WikiAutomationRepository(store).startNextJob()
      } finally {
        store.close()
      }
      if (!job) return

      try {
        let graph: LocalDependencyGraph
        const artifactStore = await ProjectStore.open(project.rootPath)
        try {
          const repository = new WikiAutomationRepository(artifactStore)
          graph = repository.buildLocalDependencyGraph(graphInputFor(job))
          const previousArtifact = repository.findMostRelevantDependencyGraphArtifact(job.id)
          const delta = repository.buildLocalDependencyGraphDelta(
            graph,
            previousArtifact && repository.getDependencyGraphSnapshot(previousArtifact)
          )
          repository.addArtifact(job.id, {
            kind: 'dependency_graph',
            title: `${job.title} dependency graph delta`,
            contentMarkdown: `\`\`\`json\n${JSON.stringify({
              baselineArtifactId: previousArtifact?.id ?? null,
              delta,
              snapshot: graph
            }, null, 2)}\n\`\`\``,
            metadata: {
              generatedBy: 'local-dependency-graph',
              baselineArtifactId: previousArtifact?.id ?? null,
              graph,
              delta,
              truncated: graph.truncated || delta.truncated
            }
          })
        } finally {
          artifactStore.close()
        }

        for (const document of generatedDocuments(job)) {
          const markdown = (await this.provider.propose(`${job.promptMarkdown}\n\n${graphEvidencePrompt(graph)}\n\n${document.instruction}`)).trim()
          if (!markdown) throw new Error(`AI provider returned no ${document.title} content.`)
          await this.projects.saveGeneratedWikiArticle(projectId, document.slug, markdown)
          const artifactStore = await ProjectStore.open(project.rootPath)
          try {
            new WikiAutomationRepository(artifactStore).addArtifact(job.id, {
              kind: 'wiki_article',
              title: document.title,
              contentMarkdown: markdown,
              relativePath: `wiki/${document.slug}.md`,
              metadata: { generatedBy: 'merged-pull-request', protected: true }
            })
          } finally {
            artifactStore.close()
          }
        }

        const completeStore = await ProjectStore.open(project.rootPath)
        try {
          new WikiAutomationRepository(completeStore).completeJob(job.id)
        } finally {
          completeStore.close()
        }
      } catch (error) {
        await this.failJob(project.rootPath, job.id, error)
      }
    }
  }

  private async failJob(rootPath: string, jobId: string, error: unknown): Promise<void> {
    try {
      const store = await ProjectStore.open(rootPath)
      try {
        new WikiAutomationRepository(store).failJob(jobId, errorMessage(error))
      } finally {
        store.close()
      }
    } catch (failure) {
      this.report(`Unable to record failure for wiki automation job ${jobId}`, failure)
    }
  }

  private report(message: string, error: unknown): void {
    console.error(`[wiki-automation] ${message}: ${errorMessage(error)}`)
  }
}

async function gatherDiffEvidence(rootPath: string, mergedCommitSha: string | undefined): Promise<DiffEvidence> {
  const commitSha = mergedCommitSha || (await safeRunGit(['rev-parse', 'HEAD'], rootPath, 80)).trim() || 'unknown'
  const [sourcePathsOutput, diff] = await Promise.all([
    safeRunGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], rootPath, 20_000),
    safeRunGit(['show', '--format=', '--no-ext-diff', '--unified=3', commitSha], rootPath, MAX_DIFF_CHARACTERS)
  ])
  return {
    commitSha,
    sourcePaths: sourcePathsOutput.split('\n').map((entry) => entry.trim()).filter(Boolean).slice(0, MAX_SOURCE_PATHS),
    diff: diff.slice(0, MAX_DIFF_CHARACTERS)
  }
}

function generationPrompt(workItemId: string, pullRequest: MergedPullRequest, evidence: DiffEvidence, sessionSummaryMarkdown: string): string {
  return `Document this merged pull request accurately in Markdown.

Pull request: #${pullRequest.number} ${pullRequest.title}
URL: ${pullRequest.url}
Branch: ${pullRequest.headRefName}
Merged at: ${pullRequest.mergedAt ?? 'unknown'}
Merge commit: ${evidence.commitSha}
Work item: ${workItemId}

Use only the evidence below. Do not speculate. Return Markdown only.

Worker handoff evidence:
${sessionSummaryMarkdown || '(No worker handoff was submitted.)'}

Bounded git diff evidence:
\`\`\`diff
${evidence.diff || '(No git diff evidence was available.)'}
\`\`\``
}

function graphInputFor(job: WikiAutomationJob): { entryPaths?: string[]; maxFiles: number; maxEdges: number } {
  if (job.requestedBy === FULL_RESCAN_REQUESTED_BY) {
    return { maxFiles: FULL_RESCAN_MAX_FILES, maxEdges: FULL_RESCAN_MAX_EDGES }
  }
  return { entryPaths: job.sourcePaths, maxFiles: 250, maxEdges: 1_000 }
}

function generatedDocuments(job: WikiAutomationJob): Array<{ slug: string; title: string; instruction: string }> {
  if (job.requestedBy === FULL_RESCAN_REQUESTED_BY) {
    return [
      {
        slug: 'generated-overview',
        title: 'Generated project overview',
        instruction: 'Refresh the generated project overview for the whole codebase. Describe purpose and current capabilities only when supported by the graph evidence.'
      },
      {
        slug: 'generated-architecture',
        title: 'Generated architecture',
        instruction: 'Refresh generated architecture documentation for the whole codebase. Focus on components, data/control flow, and dependencies supported by the graph evidence. Use headings and concise bullets.'
      },
      {
        slug: 'generated-codebase-map',
        title: 'Generated codebase map',
        instruction: 'Create a concise generated codebase map. Group important paths and describe their observed import relationships; do not claim behavior that the graph does not evidence.'
      },
      {
        slug: 'generated-agent-brief',
        title: 'Generated agent brief',
        instruction: 'Refresh the handoff brief for the next coding agent: relevant architecture, codebase entry points, and suggested files to inspect. Label statements that are directly evidenced.'
      }
    ]
  }

  const title = job.title
  return [
    {
      slug: 'generated-overview',
      title: 'Generated project overview',
      instruction: 'Update the generated project overview. Explain the service purpose and current capabilities affected by this merge. Preserve only facts supported by the evidence.'
    },
    {
      slug: 'generated-architecture',
      title: 'Generated architecture',
      instruction: 'Update generated architecture documentation. Focus on components, data/control flow, and dependencies affected by this merge. Use headings and concise bullets where helpful.'
    },
    {
      slug: `generated-${title.match(/^PR #(\d+)/)?.[1] ?? 'merged'}-change-log`,
      title: `${title} change log`,
      instruction: 'Write a generated change-log entry for this pull request. Cover intent, implementation, validation or operational impact, and limitations only when evidence supports them.'
    },
    {
      slug: 'generated-agent-brief',
      title: 'Generated agent brief',
      instruction: 'Write a short handoff brief for the next coding agent: current relevant architecture, recently changed behavior, constraints, and suggested files to inspect. Label statements that are directly evidenced.'
    }
  ]
}

function fullCodebaseRescanPrompt(): string {
  return `Refresh generated project wiki articles from a full local-codebase dependency graph.

Use only the graph evidence included below. Do not speculate about code behavior, external services, or files not present in that evidence. Return Markdown only.

This is a manual rescan, not a change log. Generated articles may be replaced; manually authored wiki articles must not be changed.`
}

function graphEvidencePrompt(graph: LocalDependencyGraph): string {
  return `Local dependency graph evidence:
\`\`\`json
${JSON.stringify(graph, null, 2)}
\`\`\``
}

async function safeRunGit(args: string[], cwd: string, maxOutput: number): Promise<string> {
  try {
    return await runGit(args, cwd, maxOutput)
  } catch {
    return ''
  }
}

function runGit(args: string[], cwd: string, maxOutput: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString().slice(0, maxOutput - stdout.length)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `git exited with code ${code ?? 'unknown'}`))
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

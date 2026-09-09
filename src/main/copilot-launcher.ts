import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { WorkstackError } from '../core/errors'
import { agentExecutionPreflight, requireAgentExecutionProfile, type AgentExecutionPreflight, type AgentExecutionProfile } from '../core/execution-profiles'
import { excludedEvidencePath, redactEvidence } from '../core/evidence-policy'
import { decodeDependencyGraphArtifact } from '../core/dependency-graph-artifact'
import { ContextLaunchService, type ContextLaunchBackend } from './context-launch'
import type { ContextApproval } from '../core/context-packet-contracts'
import { parseWorktrees, selectTaskWorkspace } from '../core/workspace-identity'
import type { ProjectMetadata, WorkItem } from '../core/types'
import type { ProjectPullRequest } from '../shared/desktop-api'

const MAX_WIKI_ARTICLES_IN_SESSION_CONTEXT = 5
const MAX_WIKI_ARTICLE_CHARACTERS = 1_000
const MAX_WORK_ITEM_FIELD_CHARACTERS = 2_200
const MAX_GRAPH_EVIDENCE_CHARACTERS = 1_200
const MAX_SESSION_CONTEXT_CHARACTERS = 12_000

interface CopilotLauncherOptions {
  appPath: string
  executablePath: string
  isPackaged: boolean
  platform: NodeJS.Platform
  temporaryDirectory: string
  runGit?(args: string[], cwd: string): Promise<string>
  openTerminal?(command: string): Promise<void>
  listCopilotProcesses?(worktreePath: string): Promise<number[]>
  readProcessCommand?(pid: number): Promise<string | undefined>
  terminateProcess?(pid: number): Promise<void>
  runGh?(args: string[], cwd: string): Promise<string>
  processShutdownTimeoutMs?: number
  context?: ContextLaunchBackend
}

export interface CopilotLaunchResult {
  contextPacketId?: string
  started: boolean
  branch: string
  pullRequest?: { state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string }
}

export class CopilotLauncher {
  private readonly openTerminal: (command: string) => Promise<void>
  private readonly runGit: (args: string[], cwd: string) => Promise<string>
  private readonly listCopilotProcesses: (worktreePath: string) => Promise<number[]>
  private readonly readProcessCommand: (pid: number) => Promise<string | undefined>
  private readonly terminateProcess: (pid: number) => Promise<void>
  private readonly runGh: (args: string[], cwd: string) => Promise<string>
  private readonly context: ContextLaunchBackend

  constructor(private readonly options: CopilotLauncherOptions) {
    this.openTerminal = options.openTerminal ?? openMacTerminal
    this.runGit = options.runGit ?? runGit
    this.listCopilotProcesses = options.listCopilotProcesses ?? findCopilotProcesses
    this.readProcessCommand = options.readProcessCommand ?? readProcessCommand
    this.terminateProcess = options.terminateProcess ?? terminateProcess
    this.runGh = options.runGh ?? runGitHubCli
    this.context = options.context ?? new ContextLaunchService()
  }

  async preflight(project: ProjectMetadata, workItem: WorkItem): Promise<AgentExecutionPreflight> {
    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = await this.resolveWorktree(project, repositoryRoot, workItem, false)
    return agentExecutionPreflight(project.settings.agentExecutionProfile, worktree.path, this.options.platform)
  }

  async launch(project: ProjectMetadata, workItem: WorkItem, prompt: string, approval: ContextApproval = {}): Promise<CopilotLaunchResult> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Launching Copilot is currently supported on macOS only.')
    }

    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      throw new WorkstackError('VALIDATION_ERROR', 'Enter an initial prompt for the Copilot session.')
    }

    requireAgentExecutionProfile(project.settings.agentExecutionProfile, project.rootPath, this.options.platform)
    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = await this.resolveWorktree(project, repositoryRoot, workItem, false)
    const exists = existsSync(worktree.path)
    if (exists) {
      const pullRequest = await this.findPullRequest(repositoryRoot, worktree.branch)
      if (pullRequest) return { started: false, pullRequest, branch: worktree.branch }
      if ((await this.runningCopilotPids(worktree.path, this.sessionPidPath(project, workItem))).length) {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'A Copilot session is already running for this task. Use Restart to resume it safely.')
      }
    }
    const prepared = await this.context.prepare(project, workItem, worktree, 'launch', trimmedPrompt, approval)
    try {
      await this.context.revalidate(project, prepared)
      await this.persistWorkspace(project, workItem, repositoryRoot, worktree)
      if (!exists) await this.createWorktree(repositoryRoot, worktree)
      const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
      const configPath = path.join(configDirectory, 'mcp-config.json')
      await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), { encoding: 'utf8', mode: 0o600 })
      await this.context.revalidate(project, prepared)
      await this.openTerminal(buildCopilotCommand({ executionProfile: project.settings.agentExecutionProfile,
        projectRoot: worktree.path, sessionPidPath: this.sessionPidPath(project, workItem), prompt: prepared.prompt, mcpConfigPath: configPath }))
    } catch (error) {
      await this.context.finish(project, prepared, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    await this.context.finish(project, prepared, 'started')
    return { started: true, branch: worktree.branch, contextPacketId: prepared.packetId }
  }

  async restack(project: ProjectMetadata, workItem: WorkItem): Promise<void> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Restacking Copilot work is currently supported on macOS only.')
    }

    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = await this.resolveWorktree(project, repositoryRoot, workItem)
    await this.removeWorktree(repositoryRoot, worktree.path, this.sessionPidPath(project, workItem))
  }

  async restart(project: ProjectMetadata, workItem: WorkItem, beforeLaunch?: () => Promise<void>, approval: ContextApproval = {}): Promise<{ contextPacketId: string }> {
    if (this.options.platform !== 'darwin') throw new WorkstackError('INTERNAL_ERROR', 'Restarting Copilot work is currently supported on macOS only.')
    requireAgentExecutionProfile(project.settings.agentExecutionProfile, project.rootPath, this.options.platform)
    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = await this.resolveWorktree(project, repositoryRoot, workItem, false)
    if (!existsSync(worktree.path)) throw new WorkstackError('PROJECT_NOT_FOUND', 'The isolated worktree no longer exists. Restack the item to start it again.')
    const prompt = 'Continue the selected Workstack task from the existing worktree. Review the current changes and task context, then claim this exact work item before continuing.'
    const prepared = await this.context.prepare(project, workItem, worktree, 'restart', prompt, approval)
    try {
      await this.context.revalidate(project, prepared)
      await this.stopCopilot(worktree.path, this.sessionPidPath(project, workItem))
      await this.persistWorkspace(project, workItem, repositoryRoot, worktree)
      const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
      const configPath = path.join(configDirectory, 'mcp-config.json')
      await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), { encoding: 'utf8', mode: 0o600 })
      await this.context.revalidate(project, prepared)
      await beforeLaunch?.()
      await this.context.revalidate(project, prepared)
      await this.openTerminal(buildCopilotCommand({ executionProfile: project.settings.agentExecutionProfile, projectRoot: worktree.path,
        sessionPidPath: this.sessionPidPath(project, workItem), prompt: prepared.prompt, mcpConfigPath: configPath }))
    } catch (error) {
      await this.context.finish(project, prepared, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    await this.context.finish(project, prepared, 'started')
    return { contextPacketId: prepared.packetId }
  }

  async launchMerge(project: ProjectMetadata, pullRequests: ProjectPullRequest[]): Promise<void> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Launching Copilot is currently supported on macOS only.')
    }
    requireAgentExecutionProfile(project.settings.agentExecutionProfile, project.rootPath, this.options.platform)
    const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
    const configPath = path.join(configDirectory, 'mcp-config.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), { encoding: 'utf8', mode: 0o600 })
    const selected = pullRequests.map((pullRequest) => `- #${pullRequest.number}: ${pullRequest.title} (${pullRequest.url})`).join('\n')
    await this.openTerminal(buildCopilotCommand({
      executionProfile: project.settings.agentExecutionProfile,
      projectRoot: project.rootPath,
      mcpConfigPath: configPath,
      prompt: `Approve and merge these pull requests. Resolve any merge conflicts, run the appropriate validation, and use GitHub CLI to merge them.\n\n${selected}\n\nAfter each merge, confirm Workstack reflects the completed work item.`
    }))
  }

  private async createWorktree(repositoryRoot: string, worktree: { branch: string; path: string }): Promise<void> {
    const existingBranch = (await this.runGit(['branch', '--list', worktree.branch], repositoryRoot)).trim()
    await this.runGit(
      existingBranch
        ? ['worktree', 'add', worktree.path, worktree.branch]
        : ['worktree', 'add', '-b', worktree.branch, worktree.path],
      repositoryRoot
    )
  }

  private async repositoryRoot(project: ProjectMetadata): Promise<string> {
    const repositoryRoot = (await this.runGit(['rev-parse', '--show-toplevel'], project.rootPath)).trim()
    if (!repositoryRoot) {
      throw new WorkstackError('INTERNAL_ERROR', 'Unable to determine the Git repository root for this project.')
    }
    return repositoryRoot
  }

  private async runningCopilotPids(worktreePath: string, sessionPidPath: string): Promise<number[]> {
    for (const pidPath of [sessionPidPath, path.join(worktreePath, '.workstack-copilot.pid')]) {
      if (!existsSync(pidPath)) continue
      const pid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10)
      if (Number.isSafeInteger(pid) && pid > 0) {
        const command = await this.readProcessCommand(pid)
        if (command && isCopilotProcess(command, worktreePath)) return [pid]
        if (command) {
          throw new WorkstackError('INTERNAL_ERROR', 'Refusing to terminate a process that is not the recorded Copilot session.')
        }
      }
    }
    return this.listCopilotProcesses(worktreePath)
  }

  private async stopCopilot(worktreePath: string, sessionPidPath: string): Promise<void> {
    for (const pid of await this.runningCopilotPids(worktreePath, sessionPidPath)) {
      await this.terminateProcess(pid)
      const deadline = Date.now() + (this.options.processShutdownTimeoutMs ?? 10_000)
      while (true) {
        const command = await this.readProcessCommand(pid)
        if (!command || !isCopilotProcess(command, worktreePath)) break
        if (Date.now() >= deadline) {
          throw new WorkstackError('STORE_BUSY', `Copilot process ${pid} has not stopped. The worktree at ${worktreePath} has been preserved; retry after the session exits.`)
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      }
    }
  }

  private async removeWorktree(repositoryRoot: string, worktreePath: string, sessionPidPath: string): Promise<void> {
    if (!existsSync(worktreePath)) return
    await this.stopCopilot(worktreePath, sessionPidPath)
    const changes = await this.runGit(['status', '--porcelain', '--untracked-files=all'], worktreePath)
    if (changes.trim()) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', `This worktree contains uncommitted or untracked files and has been preserved at ${worktreePath}. Use Restart to continue, or commit/stash the changes before restacking.`)
    }
    await this.runGit(['worktree', 'remove', worktreePath], repositoryRoot)
  }

  private workspaceDirectory(project: ProjectMetadata): string {
    return path.join(project.rootPath, '.workstack', 'workspaces')
  }

  private sessionPidPath(project: ProjectMetadata, workItem: WorkItem): string {
    return path.join(this.workspaceDirectory(project), `${encodeURIComponent(workItem.id)}.pid`)
  }

  private async resolveWorktree(project: ProjectMetadata, repositoryRoot: string, workItem: WorkItem, persist = true): Promise<{ branch: string; path: string }> {
    const directory = this.workspaceDirectory(project)
    const manifestPath = path.join(directory, `${encodeURIComponent(workItem.id)}.json`)
    const registered = parseWorktrees(await this.runGit(['worktree', 'list', '--porcelain', '-z'], repositoryRoot))
    let worktree: { branch: string; path: string }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { workItemId: string; repositoryRoot: string; branch: string; path: string }
      if (manifest.workItemId !== workItem.id || manifest.repositoryRoot !== repositoryRoot || !manifest.branch || !path.isAbsolute(manifest.path)) {
        throw new WorkstackError('VALIDATION_ERROR', 'The task workspace mapping is invalid. Existing files have been preserved.')
      }
      worktree = { branch: manifest.branch, path: manifest.path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      worktree = selectTaskWorkspace(repositoryRoot, workItem, registered)
    }
    const registeredWorkspace = registered.find((entry) => entry.path === worktree.path)
    if (existsSync(worktree.path) && (!registeredWorkspace || registeredWorkspace.branch !== worktree.branch)) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', `The existing workspace at ${worktree.path} is not registered on the expected task branch. It has been preserved for manual recovery.`)
    }
    const attachedElsewhere = registered.find((entry) => entry.branch === worktree.branch && entry.path !== worktree.path)
    if (attachedElsewhere) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', `The task branch is already attached at ${attachedElsewhere.path}. No worktree was changed.`)
    }
    if (persist) await this.persistWorkspace(project, workItem, repositoryRoot, worktree)
    return worktree
  }

  private async persistWorkspace(project: ProjectMetadata, workItem: WorkItem, repositoryRoot: string, worktree: { path: string; branch: string }): Promise<void> {
    const directory = this.workspaceDirectory(project)
    const manifestPath = path.join(directory, `${encodeURIComponent(workItem.id)}.json`)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify({ workItemId: workItem.id, repositoryRoot, ...worktree }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, manifestPath)
  }

  private async findPullRequest(repositoryRoot: string, branch: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string } | undefined> {
    const pullRequests = JSON.parse(await this.runGh([
      'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'state,url'
    ], repositoryRoot)) as Array<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string }>
    return pullRequests.find((pullRequest) => pullRequest.state !== 'CLOSED')
  }

  private mcpServerConfig(): { command: string; args: string[] } {
    return {
      command: this.options.executablePath,
      args: this.options.isPackaged ? ['--mcp'] : [this.options.appPath, '--mcp']
    }
  }
}

export async function buildCopilotSessionContext(project: ProjectMetadata, workItem: WorkItem): Promise<string> {
  const workItemContext = [
    'Selected Workstack project: ' + project.name,
    `Project ID: ${project.id}; work item ID: ${workItem.id}`,
    `Selected work item: ${workItem.displayId} - ${workItem.title}`,
    `Type: ${workItem.type}; priority: ${workItem.priority}; status: ${workItem.status}`,
    `Description:\n${redactEvidence(workItem.descriptionMarkdown).slice(0, MAX_WORK_ITEM_FIELD_CHARACTERS) || '(none)'}`,
    `Acceptance criteria:\n${redactEvidence(workItem.acceptanceCriteriaMarkdown).slice(0, MAX_WORK_ITEM_FIELD_CHARACTERS) || '(none)'}`
  ].join('\n')
  const wikiDirectory = path.join(project.rootPath, '.workstack', 'knowledge', 'wiki')
  let articles: Array<{ name: string; content: string; modifiedAt: number }>
  try {
    articles = (await Promise.all((await readdir(wikiDirectory))
      .filter((name) => name.endsWith('.md') && !excludedEvidencePath(name))
      .map(async (name) => {
        const articlePath = path.join(wikiDirectory, name)
        const metadata = await lstat(articlePath)
        if (!metadata.isFile()) return undefined
        return { name, content: redactEvidence(await readFile(articlePath, 'utf8')), modifiedAt: metadata.mtimeMs }
      }))).filter((article): article is { name: string; content: string; modifiedAt: number } => article !== undefined)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      articles = []
    } else {
      throw error
    }
  }
  const databasePath = path.join(project.rootPath, '.workstack', 'workstack.db')
  if (existsSync(databasePath)) {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_publication'").get()) {
        const publication = database.prepare('SELECT revision_id FROM wiki_publication WHERE id = 1').get() as { revision_id: string } | undefined
        if (publication) {
          const pages = database.prepare('SELECT slug, content FROM wiki_revision_pages WHERE revision_id = ?').all(publication.revision_id) as Array<{ slug: string; content: string }>
          articles = [...articles.filter((article) => !article.name.startsWith('generated-')), ...pages.map((article) => ({ name: `${article.slug}.md`, content: redactEvidence(article.content), modifiedAt: 0 }))]
        }
      }
    } finally { database.close() }
  }
  const selectedArticles = selectWikiArticles(articles, workItem)
  const wikiContext = selectedArticles.length
    ? `Project wiki context (relevance-ranked and bounded):\n${selectedArticles.map(({ name, content }) => `## ${name.slice(0, -3)}\n${content.slice(0, MAX_WIKI_ARTICLE_CHARACTERS)}`).join('\n\n')}`
    : 'Project wiki context: no articles are currently available.'
  const graphContext = await readRecentGraphEvidence(project.rootPath, workItem)
  const checkpointContext = readCheckpointContext(project.rootPath, workItem.id)
  return redactEvidence([workItemContext, checkpointContext, wikiContext, graphContext].filter(Boolean).join('\n\n')).slice(0, MAX_SESSION_CONTEXT_CHARACTERS)
}

function readCheckpointContext(rootPath: string, workItemId: string): string | undefined {
  const databasePath = path.join(rootPath, '.workstack', 'workstack.db')
  if (!existsSync(databasePath)) return undefined
  let database: Database.Database | undefined
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    const row = database.prepare(`SELECT id, agent_id, created_at, payload_json FROM work_checkpoints
      WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workItemId) as {
        id: string; agent_id: string | null; created_at: string; payload_json: string
      } | undefined
    if (!row) return undefined
    const payload = JSON.parse(row.payload_json) as { filesChanged: string[]; [key: string]: unknown }
    const context = JSON.stringify({ ...payload, filesChanged: payload.filesChanged.filter((file) => !excludedEvidencePath(file)) })
    return `Latest recovery checkpoint ${row.id} (agent ${row.agent_id ?? 'unknown'}, ${row.created_at}):\n${redactEvidence(context).slice(0, 2400)}\nRead workstack_get_work_item_handoff for the complete checkpoint and previous attempts.`
  } finally {
    database?.close()
  }
}

function selectWikiArticles(
  articles: Array<{ name: string; content: string; modifiedAt: number }>,
  workItem: WorkItem
): Array<{ name: string; content: string; modifiedAt: number }> {
  const terms = contextTerms(workItem)
  const agentBrief = articles.find((article) => article.name === 'generated-agent-brief.md')
  const recentChange = articles
    .filter((article) => isGeneratedChangeLog(article.name))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || wikiScore(right, terms) - wikiScore(left, terms) || left.name.localeCompare(right.name))
    .at(0)
  const ranked = articles
    .filter((article) => article !== agentBrief && article !== recentChange)
    .sort((left, right) => wikiScore(right, terms) - wikiScore(left, terms) || right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name))
  return [agentBrief, recentChange, ...ranked]
    .filter((article): article is { name: string; content: string; modifiedAt: number } => article !== undefined)
    .slice(0, MAX_WIKI_ARTICLES_IN_SESSION_CONTEXT)
}

function wikiScore(article: { name: string; content: string }, terms: string[]): number {
  const text = `${article.name}\n${article.content}`.toLowerCase()
  const relevance = terms.reduce((score, term) => score + (text.includes(term) ? 10 : 0), 0)
  return relevance
}

function isGeneratedChangeLog(name: string): boolean {
  return /^generated-.+-change-log\.md$/.test(name)
}

function contextTerms(workItem: WorkItem): string[] {
  return [...new Set(`${workItem.title} ${workItem.descriptionMarkdown} ${workItem.acceptanceCriteriaMarkdown}`
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].slice(0, 30)
}

interface GraphRow {
  id: string
  title: string
  source_paths_json: string
  content_markdown: string
  created_at: string
  metadata_json: string
}

async function readRecentGraphEvidence(rootPath: string, workItem: WorkItem): Promise<string | undefined> {
  const databasePath = path.join(rootPath, '.workstack', 'workstack.db')
  if (!existsSync(databasePath)) return undefined
  let database: Database.Database | undefined
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    const rows = database.prepare(
      `SELECT a.id, j.title, j.source_paths_json, a.content_markdown, a.created_at, a.metadata_json
       FROM wiki_automation_artifacts a
       JOIN wiki_automation_jobs j ON j.id = a.job_id
       WHERE a.kind = 'dependency_graph'
       ORDER BY COALESCE(j.completed_at, j.updated_at, j.created_at) DESC, a.created_at DESC
       LIMIT 6`
    ).all() as GraphRow[]
    const terms = contextTerms(workItem)
    const evidence = rows
      .map((row) => ({ row, summary: summarizeGraph(row, terms) }))
      .filter((entry): entry is { row: GraphRow; summary: string } => entry.summary !== undefined)
      .sort((left, right) => graphScore(right.summary, terms) - graphScore(left.summary, terms))
      .at(0)
    return evidence ? `Recent graph evidence (relevance-selected and bounded):\n${evidence.summary}` : undefined
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

function summarizeGraph(row: GraphRow, terms: string[]): string | undefined {
  try {
    const sourcePaths = JSON.parse(row.source_paths_json) as unknown
    const decoded = decodeDependencyGraphArtifact(row.content_markdown, JSON.parse(row.metadata_json))
    if (!decoded) return undefined
    const graph = decoded.snapshot
    const paths = [
      ...(Array.isArray(sourcePaths) ? sourcePaths.filter((value): value is string => typeof value === 'string') : []),
      ...(graph.nodes ?? []).flatMap((node) => typeof node.path === 'string' ? [node.path] : [])
    ]
    const relevantPaths = rankPaths(paths, terms).slice(0, 8)
    const relevantEdges = (graph.edges ?? [])
      .filter((edge): edge is { from: string; to: string } => typeof edge.from === 'string' && typeof edge.to === 'string')
      .filter((edge) => !excludedEvidencePath(edge.from) && !excludedEvidencePath(edge.to))
      .filter((edge) => relevantPaths.includes(edge.from) || relevantPaths.includes(edge.to))
      .slice(0, 8)
      .map((edge) => `${edge.from} -> ${edge.to}`)
    const lines = [`Source merge: ${row.title}`, `Graph artifact revision: ${row.id}; format: ${decoded.format}; source snapshot partial: ${decoded.truncated || (Array.isArray(sourcePaths) && sourcePaths.length > 0)}`, `Generated: ${row.created_at}`, `Relevant files: ${relevantPaths.join(', ') || '(none)'}`]
    if (relevantEdges.length) lines.push(`Relevant dependencies:\n${relevantEdges.map((edge) => `- ${edge}`).join('\n')}`)
    return lines.join('\n').slice(0, MAX_GRAPH_EVIDENCE_CHARACTERS)
  } catch {
    return undefined
  }
}

function rankPaths(paths: string[], terms: string[]): string[] {
  return [...new Set(paths)]
    .filter((entry) => !path.isAbsolute(entry) && !entry.split('/').includes('..') && !excludedEvidencePath(entry))
    .sort((left, right) => graphScore(right, terms) - graphScore(left, terms) || left.localeCompare(right))
}

function graphScore(value: string, terms: string[]): number {
  const lower = value.toLowerCase()
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
}

export function worktreeSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll("'", '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function buildCopilotCommand({
  projectRoot,
  prompt,
  mcpConfigPath,
  sessionPidPath,
  executionProfile
}: {
  projectRoot: string
  prompt: string
  mcpConfigPath: string
  sessionPidPath?: string
  executionProfile?: AgentExecutionProfile
}): string {
  requireAgentExecutionProfile(executionProfile, projectRoot, 'darwin')
  const copilot = [
    'copilot',
    '-C',
    projectRoot,
    '--additional-mcp-config',
    `@${mcpConfigPath}`,
    '--autopilot',
    '--allow-all',
    '-i',
    redactEvidence(prompt)
  ].map(shellQuote).join(' ')
  const invocation = sessionPidPath
    ? `printf '%s\\n' "$$" > ${shellQuote(sessionPidPath)} && exec ${copilot}`
    : copilot
  return `cd -- ${shellQuote(projectRoot)} && ${invocation}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function openMacTerminal(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script ${JSON.stringify(command)}`,
      'end tell'
    ].join('\n')
    const process = spawn('osascript', ['-e', script], {
      stdio: 'ignore'
    })
    process.once('error', reject)
    process.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new WorkstackError('INTERNAL_ERROR', `Unable to open Terminal (exit code ${code ?? 'unknown'}).`))
    })
  })
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const process = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    process.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    process.once('error', (error) => reject(new WorkstackError('INTERNAL_ERROR', `Unable to run Git: ${error.message}`)))
    process.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new WorkstackError('INTERNAL_ERROR', `Unable to create an isolated worktree: ${redactEvidence(stderr.trim()) || `git exited with code ${code ?? 'unknown'}`}`))
    })
  })
}

async function runGitHubCli(args: string[], cwd: string): Promise<string> {
  return runCommand('gh', args, cwd)
}

async function readProcessCommand(pid: number): Promise<string | undefined> {
  const output = await runCommand('ps', ['-p', String(pid), '-o', 'command='])
  return output.trim() || undefined
}

async function findCopilotProcesses(worktreePath: string): Promise<number[]> {
  const output = await runCommand('ps', ['-axo', 'pid=,command='])
  return output
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!match || !isCopilotProcess(match[2], worktreePath)) return []
      return [Number.parseInt(match[1], 10)]
    })
}

function isCopilotProcess(command: string, worktreePath: string): boolean {
  return command.includes('copilot') && command.includes(worktreePath)
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new WorkstackError('INTERNAL_ERROR', `Unable to stop Copilot process ${pid}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    process.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    process.once('error', (error) => reject(new WorkstackError('INTERNAL_ERROR', `Unable to inspect running processes: ${error.message}`)))
    process.once('exit', (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout)
        return
      }
      reject(new WorkstackError('INTERNAL_ERROR', `Unable to inspect running processes: ${redactEvidence(stderr.trim()) || `command exited with code ${code ?? 'unknown'}`}`))
    })
  })
}

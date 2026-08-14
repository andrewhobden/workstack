import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { WorkstackError } from '../core/errors'
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
}

export interface CopilotLaunchResult {
  started: boolean
  pullRequest?: { state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string }
}

export class CopilotLauncher {
  private readonly openTerminal: (command: string) => Promise<void>
  private readonly runGit: (args: string[], cwd: string) => Promise<string>
  private readonly listCopilotProcesses: (worktreePath: string) => Promise<number[]>
  private readonly readProcessCommand: (pid: number) => Promise<string | undefined>
  private readonly terminateProcess: (pid: number) => Promise<void>
  private readonly runGh: (args: string[], cwd: string) => Promise<string>

  constructor(private readonly options: CopilotLauncherOptions) {
    this.openTerminal = options.openTerminal ?? openMacTerminal
    this.runGit = options.runGit ?? runGit
    this.listCopilotProcesses = options.listCopilotProcesses ?? findCopilotProcesses
    this.readProcessCommand = options.readProcessCommand ?? readProcessCommand
    this.terminateProcess = options.terminateProcess ?? terminateProcess
    this.runGh = options.runGh ?? runGitHubCli
  }

  async launch(project: ProjectMetadata, workItem: WorkItem, prompt: string): Promise<CopilotLaunchResult> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Launching Copilot is currently supported on macOS only.')
    }

    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      throw new WorkstackError('VALIDATION_ERROR', 'Enter an initial prompt for the Copilot session.')
    }

    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = worktreeFor(repositoryRoot, workItem)
    if (existsSync(worktree.path)) {
      const pullRequest = await this.findPullRequest(repositoryRoot, worktree.branch)
      if (pullRequest) return { started: false, pullRequest }
      await this.removeWorktree(repositoryRoot, worktree.path)
    }
    await this.createWorktree(repositoryRoot, worktree)
    const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
    const configPath = path.join(configDirectory, 'mcp-config.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), {
      encoding: 'utf8',
      mode: 0o600
    })

    await this.openTerminal(buildCopilotCommand({
      projectRoot: worktree.path,
      sessionPidPath: path.join(worktree.path, '.workstack-copilot.pid'),
      prompt: `${trimmedPrompt}\n\n${await buildCopilotSessionContext(project, workItem)}\nPrepared worktree: ${worktree.path}\nPrepared branch: ${worktree.branch}\nUse workstack_get_work_item_handoff with this project and work item ID before claiming it. When completing the task, include a concise evidence-based session_summary_markdown in workstack_complete_work_item so the next worker can continue from your handoff.`,
      mcpConfigPath: configPath
    }))
    return { started: true }
  }

  async restack(project: ProjectMetadata, workItem: WorkItem): Promise<void> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Restacking Copilot work is currently supported on macOS only.')
    }

    const repositoryRoot = await this.repositoryRoot(project)
    await this.removeWorktree(repositoryRoot, worktreeFor(repositoryRoot, workItem).path)
  }

  async restart(project: ProjectMetadata, workItem: WorkItem): Promise<void> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Restarting Copilot work is currently supported on macOS only.')
    }

    const repositoryRoot = await this.repositoryRoot(project)
    const worktree = worktreeFor(repositoryRoot, workItem)
    if (!existsSync(worktree.path)) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The isolated worktree no longer exists. Restack the item to start it again.')
    }
    for (const pid of await this.runningCopilotPids(worktree.path)) {
      await this.terminateProcess(pid)
    }
    const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
    const configPath = path.join(configDirectory, 'mcp-config.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), {
      encoding: 'utf8',
      mode: 0o600
    })
    await this.openTerminal(buildCopilotCommand({
      projectRoot: worktree.path,
      sessionPidPath: path.join(worktree.path, '.workstack-copilot.pid'),
      prompt: `Continue the selected Workstack task from the existing worktree. Review the current changes and task context, then use workstack_get_work_item_handoff and claim this exact work item before continuing. When completing the task, include a concise evidence-based session_summary_markdown in workstack_complete_work_item so the next worker can continue from your handoff.\n\n${await buildCopilotSessionContext(project, workItem)}\nWorktree: ${worktree.path}\nBranch: ${worktree.branch}`,
      mcpConfigPath: configPath
    }))
  }

  async launchMerge(project: ProjectMetadata, pullRequests: ProjectPullRequest[]): Promise<void> {
    if (this.options.platform !== 'darwin') {
      throw new WorkstackError('INTERNAL_ERROR', 'Launching Copilot is currently supported on macOS only.')
    }
    const configDirectory = await mkdtemp(path.join(this.options.temporaryDirectory, 'workstack-copilot-'))
    const configPath = path.join(configDirectory, 'mcp-config.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: { workstack: this.mcpServerConfig() } }), { encoding: 'utf8', mode: 0o600 })
    const selected = pullRequests.map((pullRequest) => `- #${pullRequest.number}: ${pullRequest.title} (${pullRequest.url})`).join('\n')
    await this.openTerminal(buildCopilotCommand({
      projectRoot: project.rootPath,
      mcpConfigPath: configPath,
      prompt: `Approve and merge these pull requests. Resolve any merge conflicts, run the appropriate validation, and use GitHub CLI to merge them.\n\n${selected}\n\nAfter each merge, confirm Workstack reflects the completed work item.`
    }))
  }

  private async createWorktree(repositoryRoot: string, worktree: { branch: string; path: string }): Promise<void> {
    const existingBranch = (await this.runGit(['branch', '--list', worktree.branch], repositoryRoot)).trim()
    await this.runGit(
      existingBranch
        ? ['worktree', 'add', '--force', worktree.path, worktree.branch]
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

  private async runningCopilotPids(worktreePath: string): Promise<number[]> {
    const pidPath = path.join(worktreePath, '.workstack-copilot.pid')
    if (existsSync(pidPath)) {
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

  private async removeWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) return
    for (const pid of await this.runningCopilotPids(worktreePath)) {
      await this.terminateProcess(pid)
    }
    await this.runGit(['worktree', 'remove', '--force', worktreePath], repositoryRoot)
  }

  private async findPullRequest(repositoryRoot: string, branch: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string } | undefined> {
    const pullRequests = JSON.parse(await this.runGh([
      'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'state,url'
    ], repositoryRoot)) as Array<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string }>
    return pullRequests[0]
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
    `Selected work item: ${workItem.displayId} - ${workItem.title}`,
    `Type: ${workItem.type}; priority: ${workItem.priority}; status: ${workItem.status}`,
    `Description:\n${workItem.descriptionMarkdown.slice(0, MAX_WORK_ITEM_FIELD_CHARACTERS) || '(none)'}`,
    `Acceptance criteria:\n${workItem.acceptanceCriteriaMarkdown.slice(0, MAX_WORK_ITEM_FIELD_CHARACTERS) || '(none)'}`
  ].join('\n')
  const wikiDirectory = path.join(project.rootPath, '.workstack', 'knowledge', 'wiki')
  let articles: Array<{ name: string; content: string; modifiedAt: number }>
  try {
    articles = (await Promise.all((await readdir(wikiDirectory))
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        const articlePath = path.join(wikiDirectory, name)
        const metadata = await lstat(articlePath)
        if (!metadata.isFile()) return undefined
        return { name, content: await readFile(articlePath, 'utf8'), modifiedAt: metadata.mtimeMs }
      }))).filter((article): article is { name: string; content: string; modifiedAt: number } => article !== undefined)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      articles = []
    } else {
      throw error
    }
  }
  const selectedArticles = selectWikiArticles(articles, workItem)
  const wikiContext = selectedArticles.length
    ? `Project wiki context (relevance-ranked and bounded):\n${selectedArticles.map(({ name, content }) => `## ${name.slice(0, -3)}\n${content.slice(0, MAX_WIKI_ARTICLE_CHARACTERS)}`).join('\n\n')}`
    : 'Project wiki context: no articles are currently available.'
  const graphContext = await readRecentGraphEvidence(project.rootPath, workItem)
  return [workItemContext, wikiContext, graphContext].filter(Boolean).join('\n\n').slice(0, MAX_SESSION_CONTEXT_CHARACTERS)
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
  title: string
  source_paths_json: string
  content_markdown: string
  created_at: string
}

async function readRecentGraphEvidence(rootPath: string, workItem: WorkItem): Promise<string | undefined> {
  const databasePath = path.join(rootPath, '.workstack', 'workstack.db')
  if (!existsSync(databasePath)) return undefined
  let database: Database.Database | undefined
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    const rows = database.prepare(
      `SELECT j.title, j.source_paths_json, a.content_markdown, a.created_at
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
    const markdown = row.content_markdown.slice(0, 60_000)
    const start = markdown.indexOf('{')
    const end = markdown.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    const graph = JSON.parse(markdown.slice(start, end + 1)) as { nodes?: Array<{ path?: unknown }>; edges?: Array<{ from?: unknown; to?: unknown }> }
    const paths = [
      ...(Array.isArray(sourcePaths) ? sourcePaths.filter((value): value is string => typeof value === 'string') : []),
      ...(graph.nodes ?? []).flatMap((node) => typeof node.path === 'string' ? [node.path] : [])
    ]
    const relevantPaths = rankPaths(paths, terms).slice(0, 8)
    const relevantEdges = (graph.edges ?? [])
      .filter((edge): edge is { from: string; to: string } => typeof edge.from === 'string' && typeof edge.to === 'string')
      .filter((edge) => relevantPaths.includes(edge.from) || relevantPaths.includes(edge.to))
      .slice(0, 8)
      .map((edge) => `${edge.from} -> ${edge.to}`)
    const lines = [`Source merge: ${row.title}`, `Generated: ${row.created_at}`, `Relevant files: ${relevantPaths.join(', ') || '(none)'}`]
    if (relevantEdges.length) lines.push(`Relevant dependencies:\n${relevantEdges.map((edge) => `- ${edge}`).join('\n')}`)
    return lines.join('\n').slice(0, MAX_GRAPH_EVIDENCE_CHARACTERS)
  } catch {
    return undefined
  }
}

function rankPaths(paths: string[], terms: string[]): string[] {
  return [...new Set(paths)]
    .filter((entry) => !path.isAbsolute(entry) && !entry.split('/').includes('..'))
    .sort((left, right) => graphScore(right, terms) - graphScore(left, terms) || left.localeCompare(right))
}

function graphScore(value: string, terms: string[]): number {
  const lower = value.toLowerCase()
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
}

function worktreeFor(repositoryRoot: string, workItem: WorkItem): { branch: string; path: string } {
  const slug = worktreeSlug(workItem.title, workItem.displayId)
  return {
    branch: `anhobden/${slug}`,
    path: path.join(
      path.dirname(repositoryRoot),
      `${path.basename(repositoryRoot)}-${workItem.displayId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${slug}`
    )
  }
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
  sessionPidPath
}: {
  projectRoot: string
  prompt: string
  mcpConfigPath: string
  sessionPidPath?: string
}): string {
  const copilot = [
    'copilot',
    '-C',
    projectRoot,
    '--additional-mcp-config',
    `@${mcpConfigPath}`,
    '--autopilot',
    '--allow-all',
    '-i',
    prompt
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
      reject(new WorkstackError('INTERNAL_ERROR', `Unable to create an isolated worktree: ${stderr.trim() || `git exited with code ${code ?? 'unknown'}`}`))
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
      reject(new WorkstackError('INTERNAL_ERROR', `Unable to inspect running processes: ${stderr.trim() || `command exited with code ${code ?? 'unknown'}`}`))
    })
  })
}

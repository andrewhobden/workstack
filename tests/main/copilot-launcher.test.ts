import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CopilotLauncher, buildCopilotSessionContext, worktreeSlug } from '../../src/main/copilot-launcher'
import type { ProjectMetadata, WorkItem } from '../../src/core/types'
import type { ProjectPullRequest } from '../../src/shared/desktop-api'
import { ProjectStore } from '../../src/core/project-store'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-copilot-launcher-'))
  cleanupPaths.push(directory)
  return directory
}

const project: ProjectMetadata = {
  id: '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
  name: 'Workstack',
  description: '',
  rootPath: '/tmp/project with spaces',
  settings: {
    workItemPrefix: 'WS',
    defaultLeaseSeconds: 1800,
    heartbeatSeconds: 300,
    autoReleaseExpiredClaims: true,
    autoUpdateKnowledgeOnCompletion: true,
    copilotLaunchPrompt: 'Claim the selected work item.'
  },
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z'
}

const workItem: WorkItem = {
  id: 'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f',
  sequenceNumber: 1,
  displayId: 'WS-1',
  type: 'feature',
  title: "Support team's launch flow",
  descriptionMarkdown: '',
  acceptanceCriteriaMarkdown: '',
  priority: 'normal',
  status: 'backlog',
  source: 'manual',
  createdBy: 'human',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  completedAt: null
}

const pullRequest: ProjectPullRequest = {
  number: 42,
  title: 'Merge the completed work',
  url: 'https://github.com/andrewhobden/workstack/pull/42',
  headRefName: 'anhobden/completed-work',
  isDraft: false,
  authorLogin: 'andrewhobden',
  updatedAt: '2026-08-12T00:00:00.000Z'
}

describe('CopilotLauncher', () => {
  it('opens an interactive session with safely quoted project context and Workstack MCP', async () => {
    const tempDirectory = await temporaryDirectory()
    const commands: string[] = []
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    const launcher = new CopilotLauncher({
      appPath: '/Applications/Workstack.app/Contents/Resources/app.asar',
      executablePath: '/Applications/Workstack.app/Contents/MacOS/Workstack',
      isPackaged: true,
      platform: 'darwin',
      temporaryDirectory: tempDirectory,
      runGit: async (args, cwd) => {
        gitCalls.push({ args, cwd })
        return args[0] === 'rev-parse' ? '/tmp/project with spaces\n' : ''
      },
      openTerminal: async (command) => { commands.push(command) }
    })

    await launcher.launch(project, workItem, "Start safely; don't skip tests.")

    expect(gitCalls).toEqual([
      { args: ['rev-parse', '--show-toplevel'], cwd: '/tmp/project with spaces' },
      { args: ['branch', '--list', 'anhobden/support-teams-launch-flow'], cwd: '/tmp/project with spaces' },
      {
        args: ['worktree', 'add', '-b', 'anhobden/support-teams-launch-flow', '/tmp/project with spaces-ws-1-support-teams-launch-flow'],
        cwd: '/tmp/project with spaces'
      }
    ])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("'copilot' '-C' '/tmp/project with spaces-ws-1-support-teams-launch-flow'")
    expect(commands[0]).toContain("'--autopilot'")
    expect(commands[0]).toContain("'--allow-all'")
    expect(commands[0]).toContain(`printf '%s\\n' "$$" > '/tmp/project with spaces-ws-1-support-teams-launch-flow/.workstack-copilot.pid'`)
    expect(commands[0]).toContain("'-i' 'Start safely; don'\\''t skip tests.")
    expect(commands[0]).toContain('Selected work item: WS-1 - Support team')
    expect(commands[0]).toContain('Prepared branch: anhobden/support-teams-launch-flow')
    const configPath = commands[0].match(/'@([^']+)'/)?.[1]
    expect(configPath).toBeDefined()
    expect(JSON.parse(await readFile(configPath!, 'utf8'))).toEqual({
      mcpServers: {
        workstack: {
          command: '/Applications/Workstack.app/Contents/MacOS/Workstack',
          args: ['--mcp']
        }
      }
    })
  })

  it('derives a safe branch slug from the work item title', () => {
    expect(worktreeSlug('  Add SSO / OAuth 2.0  ', 'WS-1')).toBe('add-sso-oauth-2-0')
    expect(worktreeSlug('###', 'WS-1')).toBe('ws-1')
  })

  it('adds bounded project wiki and work-item context to a new session', async () => {
    const temporaryRoot = await temporaryDirectory()
    const repositoryRoot = path.join(temporaryRoot, 'project')
    await mkdir(path.join(repositoryRoot, '.workstack', 'knowledge', 'wiki'), { recursive: true })
    await writeFile(path.join(repositoryRoot, '.workstack', 'knowledge', 'wiki', 'architecture.md'), 'Use the existing worktree.', 'utf8')
    const commands: string[] = []
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: temporaryRoot,
      runGit: async (args) => args[0] === 'rev-parse' ? `${repositoryRoot}\n` : '',
      openTerminal: async (command) => { commands.push(command) }
    })

    await launcher.launch({ ...project, rootPath: repositoryRoot }, {
      ...workItem,
      descriptionMarkdown: 'Preserve isolated worktrees.',
      acceptanceCriteriaMarkdown: 'The prompt includes wiki context.'
    }, 'Start.')

    expect(commands[0]).toContain('Description:\nPreserve isolated worktrees.')
    expect(commands[0]).toContain('Acceptance criteria:\nThe prompt includes wiki context.')
    expect(commands[0]).toContain('## architecture\nUse the existing worktree.')
    expect(commands[0]).toContain('workstack_get_work_item_handoff')
  })

  it('prioritizes the generated agent brief and includes recent merge and relevant graph evidence', async () => {
    const rootPath = await temporaryDirectory()
    const store = await ProjectStore.initialize({ rootPath, name: 'Context project' })
    const contextProject = store.project
    const repository = new WikiAutomationRepository(store)
    const job = repository.createJob({
      title: 'PR #42: Support launch flow',
      requestedBy: 'merged-pull-request:https://example.test/pr/42',
      sourcePaths: ['src/launch-flow.ts'],
      promptMarkdown: 'Document the merge.'
    })
    repository.startNextJob()
    repository.addArtifact(job.id, {
      kind: 'dependency_graph',
      title: 'launch flow dependency graph',
      contentMarkdown: `\`\`\`json\n${JSON.stringify({
        nodes: [{ path: 'src/launch-flow.ts' }, { path: 'src/terminal.ts' }],
        edges: [{ from: 'src/launch-flow.ts', to: 'src/terminal.ts' }]
      })}\n\`\`\``
    })
    repository.completeJob(job.id)
    store.close()

    const wikiPath = path.join(rootPath, '.workstack', 'knowledge', 'wiki')
    await writeFile(path.join(wikiPath, 'architecture.md'), 'Architecture reference.', 'utf8')
    await writeFile(path.join(wikiPath, 'generated-42-change-log.md'), 'Recent merge: the launch flow now prepares terminal sessions.', 'utf8')
    await writeFile(path.join(wikiPath, 'generated-agent-brief.md'), 'Start with the launch flow and inspect its terminal boundary.', 'utf8')

    const context = await buildCopilotSessionContext(contextProject, {
      ...workItem,
      title: 'Support launch flow',
      descriptionMarkdown: 'Prepare terminal sessions safely.'
    })

    expect(context.indexOf('## generated-agent-brief')).toBeLessThan(context.indexOf('## generated-42-change-log'))
    expect(context).toContain('Recent merge: the launch flow now prepares terminal sessions.')
    expect(context).toContain('Recent graph evidence (relevance-selected and bounded):')
    expect(context).toContain('Relevant files: src/launch-flow.ts')
    expect(context).toContain('src/launch-flow.ts -> src/terminal.ts')
  })

  it('starts an autopilot merge session in Terminal', async () => {
    const commands: string[] = []
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: await temporaryDirectory(),
      openTerminal: async (command) => { commands.push(command) }
    })

    await launcher.launchMerge(project, [pullRequest])

    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("'copilot' '-C' '/tmp/project with spaces'")
    expect(commands[0]).toContain("'--autopilot'")
    expect(commands[0]).toContain("'--allow-all'")
    expect(commands[0]).toContain('Approve and merge these pull requests.')
    expect(commands[0]).toContain('#42: Merge the completed work')
  })

  it('reconciles an existing pull request instead of relaunching the backlog item', async () => {
    const temporaryRoot = await temporaryDirectory()
    const repositoryRoot = path.join(temporaryRoot, 'project')
    const worktreePath = path.join(temporaryRoot, 'project-ws-1-support-teams-launch-flow')
    await mkdir(worktreePath, { recursive: true })
    const commands: string[] = []
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: temporaryRoot,
      runGit: async (args) => args[0] === 'rev-parse' ? `${repositoryRoot}\n` : '',
      runGh: async () => JSON.stringify([{ state: 'OPEN', url: 'https://github.com/andrewhobden/workstack/pull/42' }]),
      openTerminal: async (command) => { commands.push(command) }
    })

    await expect(launcher.launch({ ...project, rootPath: repositoryRoot }, workItem, 'Resume work.')).resolves.toEqual({
      started: false,
      pullRequest: { state: 'OPEN', url: 'https://github.com/andrewhobden/workstack/pull/42' }
    })
    expect(commands).toEqual([])
  })

  it('removes a stale worktree and recreates its existing branch before relaunching', async () => {
    const temporaryRoot = await temporaryDirectory()
    const repositoryRoot = path.join(temporaryRoot, 'project')
    const worktreePath = path.join(temporaryRoot, 'project-ws-1-support-teams-launch-flow')
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    await mkdir(worktreePath, { recursive: true })
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: temporaryRoot,
      runGit: async (args, cwd) => {
        gitCalls.push({ args, cwd })
        if (args[0] === 'rev-parse') return `${repositoryRoot}\n`
        if (args[0] === 'branch') return '  anhobden/support-teams-launch-flow\n'
        return ''
      },
      runGh: async () => '[]',
      listCopilotProcesses: async () => [],
      openTerminal: async () => undefined
    })

    await expect(launcher.launch({ ...project, rootPath: repositoryRoot }, workItem, 'Resume work.')).resolves.toEqual({ started: true })
    expect(gitCalls).toEqual([
      { args: ['rev-parse', '--show-toplevel'], cwd: repositoryRoot },
      { args: ['worktree', 'remove', '--force', worktreePath], cwd: repositoryRoot },
      { args: ['branch', '--list', 'anhobden/support-teams-launch-flow'], cwd: repositoryRoot },
      { args: ['worktree', 'add', '--force', worktreePath, 'anhobden/support-teams-launch-flow'], cwd: repositoryRoot }
    ])
  })

  it('restarts a Copilot session from its existing worktree', async () => {
    const temporaryRoot = await temporaryDirectory()
    const repositoryRoot = path.join(temporaryRoot, 'project')
    const worktreePath = path.join(temporaryRoot, 'project-ws-1-support-teams-launch-flow')
    const terminated: number[] = []
    const commands: string[] = []
    await mkdir(worktreePath, { recursive: true })
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: temporaryRoot,
      runGit: async (args) => args[0] === 'rev-parse' ? `${repositoryRoot}\n` : '',
      listCopilotProcesses: async () => [101],
      terminateProcess: async (pid) => { terminated.push(pid) },
      openTerminal: async (command) => { commands.push(command) }
    })

    await launcher.restart({ ...project, rootPath: repositoryRoot }, workItem)

    expect(terminated).toEqual([101])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('Continue the selected Workstack task from the existing worktree.')
    expect(commands[0]).toContain('Project wiki context: no articles are currently available.')
    expect(commands[0]).toContain("'--autopilot'")
    expect(commands[0]).toContain("'--allow-all'")
  })

  it('terminates the tracked Copilot session and removes its worktree when restacking', async () => {
    const temporaryRoot = await temporaryDirectory()
    const repositoryRoot = path.join(temporaryRoot, 'project')
    const restackProject = { ...project, rootPath: repositoryRoot }
    const worktreePath = path.join(temporaryRoot, 'project-ws-1-support-teams-launch-flow')
    const gitCalls: Array<{ args: string[]; cwd: string }> = []
    const terminated: number[] = []
    await mkdir(worktreePath, { recursive: true })
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'darwin',
      temporaryDirectory: temporaryRoot,
      runGit: async (args, cwd) => {
        gitCalls.push({ args, cwd })
        return args[0] === 'rev-parse' ? `${repositoryRoot}\n` : ''
      },
      listCopilotProcesses: async (path_) => {
        expect(path_).toBe(worktreePath)
        return [101]
      },
      terminateProcess: async (pid) => { terminated.push(pid) }
    })

    await launcher.restack(restackProject, workItem)

    expect(terminated).toEqual([101])
    expect(gitCalls).toEqual([
      { args: ['rev-parse', '--show-toplevel'], cwd: repositoryRoot },
      { args: ['worktree', 'remove', '--force', worktreePath], cwd: repositoryRoot }
    ])
  })

  it('rejects launch attempts outside macOS', async () => {
    const launcher = new CopilotLauncher({
      appPath: '/app',
      executablePath: '/electron',
      isPackaged: false,
      platform: 'linux',
      temporaryDirectory: await temporaryDirectory()
    })

    await expect(launcher.launch(project, workItem, 'Claim this work item.')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    })
  })
})

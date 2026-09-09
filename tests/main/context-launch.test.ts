import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
import { ContextPacketRepository } from '../../src/core/context-packets'
import { ContextLaunchService } from '../../src/main/context-launch'
import { CopilotLauncher } from '../../src/main/copilot-launcher'
import { captureContextRepository } from '../../src/core/context-repository'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectRegistry } from '../../src/core/project-registry'
import { WorkstackMcpTools } from '../../src/mcp/server'
import type { ContextPacket } from '../../src/core/context-packet-contracts'

const run = promisify(execFile)
const roots: string[] = []; const stores: ProjectStore[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))) })
async function fixture(nested = false) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workstack-real-context-'))); roots.push(base)
  const repositoryRoot = path.join(base, 'repository'); await mkdir(repositoryRoot)
  const rootPath = nested ? path.join(repositoryRoot, 'packages', 'app') : repositoryRoot
  const git = async (args: string[], cwd = repositoryRoot) => (await run('git', args, { cwd })).stdout
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'fixture@example.test']); await git(['config', 'user.name', 'Fixture'])
  await writeFile(path.join(repositoryRoot, '.gitignore'), '**/.workstack/\n')
  await writeFile(path.join(repositoryRoot, 'README.md'), '# Project\nA local task tool.\n')
  await git(['add', '.']); await git(['commit', '-m', 'Initial fixture'])
  const registry = new ProjectRegistry(path.join(base, 'registry.json'))
  const projects = new ProjectsService(registry)
  const summary = await projects.createProject({ rootPath, name: 'Real context', description: 'A task coordination application.', workItemPrefix: 'CTX' })
  await projects.updateProject(summary.id, { settings: { agentExecutionProfile: 'advanced' } })
  const project = await projects.getProject(summary.id)
  const item = await projects.createWorkItem(project.id, { title: 'Implement an explicit context packet', descriptionMarkdown: 'Preserve task evidence.', acceptanceCriteriaMarkdown: 'The launched packet agrees with the desktop and MCP.' })
  const store = await ProjectStore.open(rootPath); stores.push(store)
  const packets = new ContextPacketRepository(store)
  const claims = new ClaimsRepository(store)
  const commands: string[] = []; const gitCalls: string[][] = []; const terminated: number[] = []
  const options = { appPath: '/app', executablePath: '/electron', isPackaged: false, platform: 'darwin' as const, temporaryDirectory: base,
    runGit: async (args: string[], cwd: string) => { gitCalls.push(args); return git(args, cwd) }, runGh: async () => '[]', listCopilotProcesses: async () => [], readProcessCommand: async () => undefined,
    terminateProcess: async (pid: number) => { terminated.push(pid) }, openTerminal: async (command: string) => { commands.push(command) } }
  return { base, repositoryRoot, rootPath, store, projects, project, item, packets, claims, git, gitCalls, commands, options, terminated }
}

describe('real Git context launch boundary', { timeout: 20000 }, () => {
  it('uses the same immutable preview through launch, MCP claim, checkpoint and restart', async () => {
    const { packets, project, item, commands, options, claims, projects } = await fixture()
    const launcher = new CopilotLauncher(options)
    const preview = await projects.previewContextPacket(project.id, item.id)
    const result = await launcher.launch(project, item, 'Implement the approved task.', { packetId: preview.id })
    expect(result).toMatchObject({ started: true, contextPacketId: preview.id })
    expect(packets.get(preview.id)).toEqual(preview)
    expect(packets.listUsage(preview.id)).toMatchObject([{ kind: 'launch', state: 'started', promptMarkdown: expect.stringContaining(preview.launchMarkdown) }])
    expect(commands[0]).toContain(`context_packet_id=${preview.id}`)
    const mcp = new WorkstackMcpTools(projects)
    const same = await mcp.call('workstack_get_context_packet', { project: project.name, packet_id: preview.id }) as ContextPacket
    expect(same.launchMarkdown).toBe(preview.launchMarkdown)
    const claim = await mcp.call('workstack_claim_work_item', { project: project.name, work_item_id: item.displayId, agent_id: 'fixture-worker', context_packet_id: preview.id }) as { context_packet_id: string; claim_token: string }
    expect(claim.context_packet_id).toBe(preview.id)
    claims.saveCheckpoint(item.id, claim.claim_token, { progressMarkdown: 'The repository was inspected.', filesChanged: ['README.md'], nextActionsMarkdown: 'Add packet validation.' })
    const restartPreview = await packets.preview(item.id)
    const restarted = await launcher.restart(project, item, async () => { claims.release(item.id, claim.claim_token, 'Restart handoff') }, { packetId: restartPreview.id })
    expect(restarted.contextPacketId).toBe(restartPreview.id)
    expect(packets.listUsage(restartPreview.id)).toMatchObject([{ kind: 'restart', state: 'started' }])
    expect(packets.get(restartPreview.id).sections.find((section) => section.category === 'checkpoint')?.markdown).toContain('Add packet validation')
    const next = claims.claim(item.id, { agentId: 'replacement', contextPacketId: restartPreview.id })
    expect(next.contextPacketId).toBe(restartPreview.id)
    expect(commands).toHaveLength(2)
  })

  it('rejects a hard gap before creating a workspace, mutating ownership, or stopping a process', async () => {
    const { packets, project, item, options, gitCalls, commands, claims, terminated, rootPath } = await fixture()
    const { version, ...policy } = packets.getPolicy()
    packets.updatePolicy({ ...policy, expectedVersion: version, requirements: [{ category: 'conventions', severity: 'hard' }] })
    const launcher = new CopilotLauncher(options)
    const preview = await packets.preview(item.id)
    await expect(launcher.launch(project, item, 'Start', { packetId: preview.id })).rejects.toThrow('Context needs attention')
    expect(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
    await expect(readFile(path.join(rootPath, '.workstack', 'workspaces', `${item.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(commands).toEqual([]); expect(terminated).toEqual([]); expect(claims.getActive(item.id)).toBeUndefined()
  })

  it('rejects repository or ownership changes after preview without invoking an agent', async () => {
    const { packets, project, item, options, commands, repositoryRoot, claims, terminated } = await fixture()
    const launcher = new CopilotLauncher(options)
    const first = await packets.preview(item.id)
    await writeFile(path.join(repositoryRoot, 'README.md'), 'A changed repository.')
    await expect(launcher.launch(project, item, 'Start', { packetId: first.id })).rejects.toThrow('changed after this preview')
    const second = await packets.preview(item.id)
    const firstOwner = claims.claim(item.id, { agentId: 'another-worker', contextPacketId: second.id })
    await expect(launcher.launch(project, item, 'Start', { packetId: second.id })).rejects.toThrow('ownership or completion changed')
    await options.runGit(['worktree', 'add', '-b', second.repository.workspace!.branch, second.repository.workspace!.path], repositoryRoot)
    const restartPreview = await packets.preview(item.id)
    claims.release(item.id, firstOwner.claimToken)
    claims.claim(item.id, { agentId: 'replacement-owner' })
    await expect(launcher.restart(project, item, undefined, { packetId: restartPreview.id })).rejects.toThrow('ownership or completion changed')
    expect(terminated).toEqual([])
    expect(commands).toEqual([])
  })

  it('revalidates after worktree creation and records failure while preserving the prepared files', async () => {
    const { packets, project, item, options, commands, store } = await fixture()
    const preview = await packets.preview(item.id)
    const launcher = new CopilotLauncher({ ...options, runGit: async (args, cwd) => {
      const output = await options.runGit(args, cwd)
      if (args[0] === 'worktree' && args[1] === 'add') new WorkItemRepository(store).update(item.id, { acceptanceCriteriaMarkdown: 'The human revised this after preparation.' })
      return output
    } })
    await expect(launcher.launch(project, item, 'Start', { packetId: preview.id })).rejects.toThrow('changed after this preview')
    expect(commands).toEqual([])
    expect(packets.listUsage(preview.id)).toMatchObject([{ state: 'failed', reason: expect.stringContaining('changed') }])
    expect(await readFile(path.join(preview.repository.workspace!.path, 'README.md'), 'utf8')).toContain('A local task tool')
  })

  it('shares nested-root and legacy-worktree identity between preview and launcher', async () => {
    const { packets, project, item, options, repositoryRoot, base, git } = await fixture(true)
    const legacy = path.join(base, 'repository-ctx-1-legacy-title')
    await git(['worktree', 'add', '-b', 'operator/legacy-context', legacy])
    const preview = await packets.preview(item.id)
    expect(preview.repository.rootPath).toBe(repositoryRoot)
    expect(preview.repository.workspace).toMatchObject({ path: legacy, branch: 'operator/legacy-context' })
    const result = await new CopilotLauncher(options).launch(project, item, 'Start', { packetId: preview.id })
    expect(result.contextPacketId).toBe(preview.id)
    expect(packets.listUsage(preview.id)[0].state).toBe('started')
  })

  it('detects workspace branch changes even at the same commit and requires a complete Git revision', async () => {
    const { packets, project, item, options, git } = await fixture()
    await new CopilotLauncher(options).launch(project, item, 'Start')
    const latest = packets.get(packets.list(item.id)[0].id)
    const backend = new ContextLaunchService()
    const prepared = await backend.prepare(project, item, latest.repository.workspace!, 'restart', 'Continue')
    await git(['switch', '-c', 'unrelated-branch'], latest.repository.workspace!.path)
    await expect(backend.revalidate(project, prepared)).rejects.toThrow('changed after this preview')
    await backend.finish(project, prepared, 'failed', 'Branch changed')
    const state = captureContextRepository(project.rootPath, latest.repository.workspace)
    expect(state.complete).toBe(false)
    const nongit = await mkdtemp(path.join(os.tmpdir(), 'workstack-no-git-context-')); roots.push(nongit)
    const nongitStore = await ProjectStore.initialize({ rootPath: nongit, name: 'Directory' }); stores.push(nongitStore)
    await nongitStore.updateMetadata({ settings: { agentExecutionProfile: 'advanced' } })
    const nongitItem = new WorkItemRepository(nongitStore).create({ title: 'Directory task' })
    await expect(backend.prepare(nongitStore.project, nongitItem, { path: path.join(nongit, 'workspace'), branch: 'feature' }, 'launch', 'Start')).rejects.toThrow('complete Git repository')
  })

  it('records terminal failure without losing launch evidence or claiming the task', async () => {
    const { packets, project, item, options, claims } = await fixture()
    const launcher = new CopilotLauncher({ ...options, openTerminal: async () => { throw new Error('Terminal unavailable') } })
    await expect(launcher.launch(project, item, 'Exact operator prompt')).rejects.toThrow('Terminal unavailable')
    const packet = packets.get(packets.list(item.id)[0].id)
    expect(packets.listUsage(packet.id)).toMatchObject([{ state: 'failed', reason: 'Terminal unavailable', promptMarkdown: expect.stringContaining('Exact operator prompt') }])
    expect(claims.getActive(item.id)).toBeUndefined()
  })
})

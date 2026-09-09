import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectRegistry } from '../../src/core/project-registry'
import { registerIpcHandlers } from '../../src/main/ipc'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { OpenAiCompatibleProvider } from '../../src/main/ai-provider'
import type { CopilotLauncher } from '../../src/main/copilot-launcher'
import type { PullRequestService } from '../../src/main/pull-requests'
import type { WikiAutomationService } from '../../src/main/wiki-automation-service'

const transport = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), api: undefined as DesktopApi | undefined }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => transport.handlers.set(name, handler) },
  ipcRenderer: { invoke: async (name: string, ...args: unknown[]) => {
    const handler = transport.handlers.get(name)
    if (!handler) throw new Error(`Unregistered IPC channel: ${name}`)
    return handler({}, ...args)
  } },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { transport.api = api } },
  BrowserWindow: {}, dialog: {}, shell: {}, safeStorage: {}
}))
const directories: string[] = []
afterEach(async () => {
  transport.handlers.clear()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

it('persists dependency edits through preload and IPC and blocks launch or restart before changing launch settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-task-dependency-ipc-'))
  directories.push(directory)
  const registryPath = path.join(directory, 'registry.json')
  const service = new ProjectsService(new ProjectRegistry(registryPath))
  const launch = vi.fn(async () => ({}))
  const restart = vi.fn(async () => undefined)
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, { launch, restart } as unknown as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.api!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Task coordination' })
  const consumer = await api.workItems.create(project.id, { title: 'Consumer' })
  const producer = await api.workItems.create(project.id, { title: 'Producer' })
  expect(await api.taskDependencies.get(project.id, consumer.id)).toMatchObject({ readiness: { ready: true } })
  const result = await api.taskDependencies.update(project.id, consumer.id, { dependsOn: [producer.displayId], declaredPaths: ['src/api'], declaredComponents: ['API'] })
  expect(result).toMatchObject({ readiness: { ready: false, blockers: [{ displayId: producer.displayId }] }, declaredPaths: ['src/api'], declaredComponents: ['api'] })
  await expect(api.taskDependencies.update(project.id, consumer.id, { projectId: project.id } as never)).rejects.toThrow()
  await expect(api.taskDependencies.update(project.id, producer.id, { dependsOn: [consumer.id] })).rejects.toThrow('dependency cycle')
  const before = await service.getProject(project.id)
  await expect(api.workItems.launchCopilot(project.id, consumer.id, 'Must not persist this prompt')).rejects.toThrow(`Unresolved prerequisites: ${producer.displayId}`)
  await expect(api.workItems.restart(project.id, consumer.id)).rejects.toThrow('Unresolved prerequisites')
  expect(launch).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
  expect((await service.getProject(project.id)).settings.copilotLaunchPrompt).toBe(before.settings.copilotLaunchPrompt)
  const reopened = new ProjectsService(new ProjectRegistry(registryPath))
  expect((await reopened.getTaskCoordination(project.id, consumer.id)).prerequisites[0].workItemId).toBe(producer.id)
  await api.taskDependencies.update(project.id, consumer.id, { dependsOn: [] })
  expect(await api.workItems.launchCopilot(project.id, consumer.id, 'Launch ready work')).toEqual({ started: true })
  expect(launch).toHaveBeenCalledOnce()
})

import { execFile, fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'
import { acquireProjectOperation } from '../../src/core/project-lifecycle'

const execute = promisify(execFile)
const temporaryRoots: string[] = []
const children = new Set<ChildProcess>()
let workerPath: string
let workerDirectory: string
const workerEnvironment = { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') }

beforeAll(async () => {
  workerDirectory = await mkdtemp(path.join(os.tmpdir(), 'workstack-persistence-worker-'))
  workerPath = path.join(workerDirectory, 'worker.cjs')
  await build({ entryPoints: [path.join(process.cwd(), 'tests/integration/project-persistence-worker.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
})

afterEach(async () => {
  await Promise.all([...children].map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited } }))
  children.clear()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(async () => { await rm(workerDirectory, { recursive: true, force: true }) })

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-persistence-'))
  temporaryRoots.push(root)
  return root
}

async function readyWorker(mode: string, target: string, argument = ''): Promise<ChildProcess> {
  const child = fork(workerPath, [mode, target, argument], { silent: true, env: workerEnvironment })
  children.add(child)
  const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(([code]) => { throw new Error(`Worker exited before ready: ${code}`) })])
  expect(message).toEqual({ ready: true })
  return child
}

function runWorker(mode: string, target: string, argument = '') {
  return execute(process.execPath, [workerPath, mode, target, argument], { env: workerEnvironment })
}

describe('cross-process project persistence', () => {
  it('verifies and restores a deleted project through the documented recovery command', async () => {
    const root = await temporaryRoot()
    const service = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
    const project = await service.createProject({ rootPath: path.join(root, 'project'), name: 'Recover me' })
    const task = await service.createWorkItem(project.id, { title: 'Restored task' })
    await service.attachBytes(project.id, task.id, { originalFilename: 'context.txt', mimeType: 'text/plain', data: Buffer.from('restorable context') })
    const { backupPath } = await service.deleteProject(project.id)
    const command = path.join(process.cwd(), 'scripts/restore-project.mjs')
    expect(JSON.parse((await execute(process.execPath, [command, '--verify-backup', backupPath])).stdout)).toMatchObject({ action: 'verified', id: project.id })
    expect(JSON.parse((await execute(process.execPath, [command, '--restore', project.rootPath, backupPath])).stdout)).toMatchObject({ action: 'restored', id: project.id })
    const restored = await ProjectStore.open(project.rootPath)
    try { expect(restored.database.prepare('SELECT id FROM work_items WHERE id = ?').get(task.id)).toEqual({ id: task.id }) } finally { restored.close() }
    await expect(execute(process.execPath, [command, '--restore', project.rootPath, backupPath])).rejects.toMatchObject({ stderr: expect.stringContaining('Existing project data was preserved') })
    const stillAvailable = await ProjectStore.open(project.rootPath)
    stillAvailable.close()
    await fs.writeFile(path.join(backupPath, 'knowledge', 'index.md'), 'tampered after snapshot')
    await expect(execute(process.execPath, [command, '--verify-backup', backupPath])).rejects.toMatchObject({ stderr: expect.stringContaining('checksums') })
  })

  it('keeps partial removal blocked and restores after preserving the remaining data', async () => {
    const root = await temporaryRoot()
    const registry = new ProjectRegistry(path.join(root, 'registry.json'))
    const service = new ProjectsService(registry)
    const project = await service.createProject({ rootPath: path.join(root, 'project'), name: 'Partial removal' })
    const failing = new ProjectsService(registry, undefined, { cp: fs.cp, lstat: fs.lstat, mkdir: fs.mkdir, rm: async (target, options) => {
      if (target === path.join(project.rootPath, '.workstack')) {
        await fs.rm(path.join(target, 'knowledge', 'index.md'))
        throw new Error('simulated partial removal')
      }
      return fs.rm(target, options)
    } })
    await expect(failing.deleteProject(project.id)).rejects.toThrow('backup remains')
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_DELETING' })
    const backupBase = path.join(root, 'backups', 'project-deletions')
    const [backupName] = await fs.readdir(backupBase)
    const backupPath = path.join(backupBase, backupName, '.workstack')
    await fs.rename(path.join(project.rootPath, '.workstack'), path.join(project.rootPath, '.workstack-quarantine'))
    const command = path.join(process.cwd(), 'scripts/restore-project.mjs')
    await execute(process.execPath, [command, '--restore', project.rootPath, backupPath])
    await expect(service.getProject(project.id)).resolves.toMatchObject({ id: project.id })
    expect(await fs.readFile(path.join(project.rootPath, '.workstack', 'knowledge', 'index.md'), 'utf8')).toContain('Knowledge index')
  })
  it('preserves independent register, refresh and detach writes from different processes', async () => {
    const root = await temporaryRoot()
    const template = await ProjectStore.initialize({ rootPath: path.join(root, 'template'), name: 'Template' })
    const metadata = template.project
    template.close()
    const registryPath = path.join(root, 'projects.json')
    const registry = new ProjectRegistry(registryPath)
    const projects = Array.from({ length: 8 }, (_, index) => ({ ...metadata, id: randomUUID(), name: `Project ${index}`, rootPath: path.join(root, String(index)) }))
    await Promise.all(projects.map((project) => runWorker('registry', registryPath, JSON.stringify({ register: project }))))
    expect(await registry.list()).toHaveLength(8)
    await Promise.all(projects.map((project, index) => runWorker('registry', registryPath, JSON.stringify(index < 3 ? { remove: project.id } : { refresh: { ...project, description: 'Persisted concurrently' } }))))
    const records = await registry.list()
    expect(records).toHaveLength(5)
    expect(records.every((record) => record.description === 'Persisted concurrently')).toBe(true)
  })

  it('merges updates from separate pre-existing process handles', async () => {
    const root = await temporaryRoot()
    const store = await ProjectStore.initialize({ rootPath: root, name: 'Original' })
    store.close()
    const [first, second] = await Promise.all([readyWorker('update', root, JSON.stringify({ name: 'Changed name' })), readyWorker('update', root, JSON.stringify({ description: 'Changed description' }))])
    const exits = [once(first, 'exit'), once(second, 'exit')]
    first.send('write')
    second.send('write')
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]])
    const reopened = await ProjectStore.open(root)
    try { expect(reopened.project).toMatchObject({ name: 'Changed name', description: 'Changed description' }) } finally { reopened.close() }
  })

  it('drains an admitted process writer and captures its database and attachment writes in the backup', async () => {
    const root = await temporaryRoot()
    const service = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
    const project = await service.createProject({ rootPath: path.join(root, 'project'), name: 'Snapshot race' })
    const writer = await readyWorker('hold-writer', project.rootPath)
    const deletion = service.deleteProject(project.id)
    await expect.poll(async () => { try { const lease = acquireProjectOperation(project.rootPath); lease.release(); return 'active' } catch (error) { return (error as { code: string }).code } }).toBe('PROJECT_DELETING')
    await expect(runWorker('open', project.rootPath)).rejects.toMatchObject({ stdout: expect.stringContaining('PROJECT_DELETING') })
    const committed = once(writer, 'message')
    const exited = once(writer, 'exit')
    writer.send('write')
    const [{ itemId }] = await committed
    await exited
    const { backupPath } = await deletion
    const backup = await ProjectStore.openReadOnly(path.dirname(backupPath))
    try {
      expect(backup.database.prepare('SELECT title FROM work_items WHERE id = ?').get(itemId)).toEqual({ title: 'Committed after deletion began' })
      const attachment = backup.database.prepare('SELECT stored_relative_path FROM attachments WHERE work_item_id = ?').get(itemId) as { stored_relative_path: string }
      expect(await readFile(path.join(backupPath, attachment.stored_relative_path), 'utf8')).toBe('accepted operation evidence')
    } finally { backup.close() }
  })

  it('allows a nested operation from an admitted launch to finish while deletion drains', async () => {
    const root = await temporaryRoot()
    const service = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
    const project = await service.createProject({ rootPath: path.join(root, 'project'), name: 'Nested operation' })
    let continueLaunch!: () => void
    let admitted!: () => void
    const admission = new Promise<void>((resolve) => { admitted = resolve })
    const continuePromise = new Promise<void>((resolve) => { continueLaunch = resolve })
    const launch = service.withProjectOperation(project.id, async () => { admitted(); await continuePromise; return service.createWorkItem(project.id, { title: 'Accepted nested work' }) })
    await admission
    const deletion = service.deleteProject(project.id)
    await expect.poll(async () => (await service.listProjects())[0].availability).toBe('deleting')
    continueLaunch()
    const item = await launch
    const result = await deletion
    const backup = await ProjectStore.openReadOnly(path.dirname(result.backupPath))
    try { expect(backup.database.prepare('SELECT id FROM work_items WHERE id = ?').get(item.id)).toEqual({ id: item.id }) } finally { backup.close() }
  })

  it('recovers dead preparation owners but keeps destructive crash recovery blocked', async () => {
    const root = await temporaryRoot()
    const store = await ProjectStore.initialize({ rootPath: root, name: 'Crash recovery' })
    store.close()
    const preparing = await readyWorker('delete-preparation', root)
    const preparationExit = once(preparing, 'exit')
    preparing.kill('SIGKILL')
    await preparationExit
    const reopened = await ProjectStore.open(root)
    reopened.close()
    const removing = await readyWorker('delete-removing', root, '/recovery/backup')
    const removalExit = once(removing, 'exit')
    removing.kill('SIGKILL')
    await removalExit
    await expect(ProjectStore.open(root)).rejects.toThrow('/recovery/backup')
  })
})

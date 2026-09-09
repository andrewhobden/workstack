import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { ClaimsRepository } from '../../src/core/claims'
import { TaskDependenciesRepository } from '../../src/core/task-dependencies'
import { WorkItemRepository } from '../../src/core/work-items'

let workerRoot: string
let workerPath: string
const roots: string[] = []
const stores: ProjectStore[] = []
const children = new Set<ChildProcess>()
const environment = { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') }

beforeAll(async () => {
  workerRoot = await mkdtemp(path.join(os.tmpdir(), 'workstack-task-dependency-worker-'))
  workerPath = path.join(workerRoot, 'worker.cjs')
  await build({ entryPoints: ['tests/integration/task-dependency-worker.ts'], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
})
afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  }))
  children.clear()
  for (const store of stores.splice(0)) if (store.database.open) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { await rm(workerRoot, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-task-dependency-race-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Concurrent dependencies' })
  stores.push(store)
  const items = new WorkItemRepository(store)
  const task = items.create({ title: 'Dependent work' })
  const prerequisite = items.create({ title: 'Prerequisite work' })
  return { root, store, task, prerequisite }
}

async function worker(mode: string, root: string, taskId: string, prerequisiteId: string) {
  const child = fork(workerPath, [mode, root, taskId, prerequisiteId], { silent: true, env: environment })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
  const ready = once(child, 'message')
  const exited = once(child, 'exit').then(([code]) => {
    if (code !== 0) throw new Error(`Dependency worker failed (${code}): ${stderr}`)
    return JSON.parse(stdout) as { succeeded: boolean; code?: string }
  })
  await Promise.race([ready, exited.then(() => { throw new Error('Dependency worker exited before ready') })])
  return { start: () => child.send({ start: true }), result: exited }
}

describe('atomic task prerequisite changes', () => {
  it('does not claim from a stale readiness observation while a prerequisite edit holds the write transaction', async () => {
    const { root, store, task, prerequisite } = await fixture()
    const dependencies = new TaskDependenciesRepository(store)
    expect(dependencies.readiness(task.id).ready).toBe(true)
    const edit = await worker('hold-edit', root, task.id, prerequisite.id)
    store.database.pragma('busy_timeout = 30')
    expect(() => new ClaimsRepository(store).claim(task.id, { agentId: 'consumer' })).toThrow(/locked|busy/i)
    edit.start()
    expect(await edit.result).toEqual({ succeeded: true })
    expect(() => new ClaimsRepository(store).claim(task.id, { agentId: 'consumer' })).toThrow(/Unresolved prerequisites/)
    expect(new WorkItemRepository(store).get(task.id).status).toBe('backlog')
  })

  it('serializes simultaneous claim and prerequisite edits so exactly one may win', async () => {
    const { root, store, task, prerequisite } = await fixture()
    const [edit, claim] = await Promise.all([worker('edit', root, task.id, prerequisite.id), worker('claim', root, task.id, prerequisite.id)])
    edit.start()
    claim.start()
    const outcomes = await Promise.all([edit.result, claim.result])
    expect(outcomes.filter((result) => result.succeeded)).toHaveLength(1)
    const coordination = new TaskDependenciesRepository(store).get(task.id)
    const active = new ClaimsRepository(store).getActive(task.id)
    if (active) {
      expect(coordination.prerequisites).toEqual([])
      expect(outcomes[0]).toMatchObject({ succeeded: false, code: 'INVALID_STATE_TRANSITION' })
    } else {
      expect(coordination.readiness.ready).toBe(false)
      expect(outcomes[1]).toMatchObject({ succeeded: false, code: 'WORK_ITEM_NOT_CLAIMABLE' })
    }
  })

  it('rejects one side of concurrently proposed circular prerequisites', async () => {
    const { root, store, task, prerequisite } = await fixture()
    const [left, right] = await Promise.all([worker('edit', root, task.id, prerequisite.id), worker('edit', root, prerequisite.id, task.id)])
    left.start()
    right.start()
    const outcomes = await Promise.all([left.result, right.result])
    expect(outcomes.filter((result) => result.succeeded)).toHaveLength(1)
    expect(outcomes.find((result) => !result.succeeded)?.code).toBe('VALIDATION_ERROR')
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM task_dependencies').get()).toEqual({ count: 1 })
  })
})

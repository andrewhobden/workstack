import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

const execFileAsync = promisify(execFile)
const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('claim concurrency', () => {
  it('allows exactly one atomic claim across twenty independent SQLite processes', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-claim-race-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Race conditions' })
    const item = new WorkItemRepository(store).create({ title: 'Only one agent may own this' })
    const workerPath = path.join(process.cwd(), 'tests/integration/claim-race-worker.mjs')

    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        execFileAsync(process.execPath, [workerPath, store.paths.databasePath, item.id, String(index + 1)])
      )
    )

    expect(attempts.map(({ stdout }) => JSON.parse(stdout) as { claimed: boolean }).filter((result) => result.claimed)).toHaveLength(1)
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM work_claims WHERE state = 'active'").get()).toEqual({ count: 1 })
    expect(store.database.prepare('SELECT status FROM work_items WHERE id = ?').get(item.id)).toEqual({ status: 'in_progress' })
    store.close()
  })
})

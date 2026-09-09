import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireProjectOperation, assertProjectAvailable, atomicWriteText, beginProjectDeletion, projectLifecyclePath, withProcessLock } from '../../src/core/project-lifecycle'

vi.mock('node:fs', async (load) => ({ ...await load<typeof import('node:fs')>() }))

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'workstack-lifecycle-')); roots.push(value); return value }

describe('project lifecycle coordination failures', () => {
  it('retains live process mutexes, reclaims dead owners and releases locks after operation failures', async () => {
    const directory = await root()
    const file = projectLifecyclePath(directory)
    await withProcessLock(file, 'metadata', () => {})
    const db = new Database(file)
    db.prepare('INSERT INTO mutexes VALUES (?,?,?)').run('metadata', 'live-owner', process.pid)
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6000)
    await expect(withProcessLock(file, 'metadata', () => { throw new Error('must not run') })).rejects.toMatchObject({ code: 'STORE_BUSY' })
    clock.mockRestore()
    expect(db.prepare('SELECT token FROM mutexes').get()).toEqual({ token: 'live-owner' })
    db.prepare('UPDATE mutexes SET pid=?').run(2_147_483_647)
    await expect(withProcessLock(file, 'metadata', () => { throw new Error('application write failed') })).rejects.toThrow('application write failed')
    expect(db.prepare('SELECT * FROM mutexes').all()).toEqual([])
    await expect(withProcessLock(file, 'metadata', () => 'recovered')).resolves.toBe('recovered')
    db.close()
  })

  it('cleans staged content and preserves the previous projection when durable file write fails', async () => {
    const directory = await root()
    const file = path.join(directory, 'project.json')
    await writeFile(file, 'previous authoritative projection')
    vi.spyOn(filesystem, 'fsyncSync').mockImplementationOnce(() => { throw new Error('simulated disk sync failure') })
    expect(() => atomicWriteText(file, 'new projection')).toThrow('disk sync failure')
    expect(await readFile(file, 'utf8')).toBe('previous authoritative projection')
    expect(await readdir(directory)).toEqual(['project.json'])
    atomicWriteText(file, 'durably published')
    expect(await readFile(file, 'utf8')).toBe('durably published')
  })

  it('rejects a corrupt coordination database and can reopen after explicit repair', async () => {
    const directory = await root()
    const file = projectLifecyclePath(directory)
    await writeFile(file, 'not a SQLite database')
    expect(() => acquireProjectOperation(directory)).toThrow()
    await rm(file)
    const lease = acquireProjectOperation(directory)
    lease.release(); lease.release()
    expect(() => assertProjectAvailable(directory)).not.toThrow()
  })

  it('retains deletion tombstones and permits only explicit initialization to reactivate them', async () => {
    const directory = await root()
    const barrier = await beginProjectDeletion(directory)
    await expect(beginProjectDeletion(directory)).rejects.toMatchObject({ code: 'PROJECT_DELETING' })
    expect(() => acquireProjectOperation(directory)).toThrow('being deleted')
    barrier.finish('deleted'); barrier.finish('active')
    expect(() => assertProjectAvailable(directory)).toThrow('was deleted')
    expect(() => acquireProjectOperation(directory)).toThrow('Explicitly create')
    await expect(beginProjectDeletion(directory)).rejects.toThrow('already deleted')
    const lease = acquireProjectOperation(directory, true)
    expect(() => assertProjectAvailable(directory)).not.toThrow()
    lease.release(); lease.release()
  })

  it('drains dead operations and keeps a failed destructive phase blocked with its recovery path', async () => {
    const directory = await root()
    const lease = acquireProjectOperation(directory); lease.release()
    const database = new Database(projectLifecyclePath(directory))
    database.prepare('INSERT INTO operations VALUES (?,?)').run('dead-process-operation', 2_147_483_647)
    const barrier = await beginProjectDeletion(directory)
    expect(database.prepare('SELECT * FROM operations').all()).toEqual([])
    barrier.run(() => { const operation = acquireProjectOperation(directory); operation.release() })
    barrier.removing('/retained/recovery')
    barrier.finish('recovery')
    expect(() => assertProjectAvailable(directory)).toThrow('/retained/recovery')
    expect(() => acquireProjectOperation(directory, true)).toThrow('/retained/recovery')
    await expect(beginProjectDeletion(directory)).rejects.toThrow('/retained/recovery')
    database.close()
  })
})

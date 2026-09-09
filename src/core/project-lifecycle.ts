import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { WorkstackError } from './errors'

type OperationContext = { filePath: string; token?: string; deletionToken?: string }
const operationContext = new AsyncLocalStorage<OperationContext>()

/** Kept outside .workstack so the deletion barrier survives removing project data. */
export function projectLifecyclePath(rootPath: string): string {
  return path.join(path.resolve(rootPath), '.workstack-lifecycle.sqlite')
}

function coordinationDatabase(filePath: string): Database.Database {
  const database = new Database(filePath)
  try {
  database.pragma('busy_timeout = 5000')
  database.exec(`
    CREATE TABLE IF NOT EXISTS mutexes (name TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (token TEXT PRIMARY KEY, pid INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lifecycle (
      id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL,
      token TEXT, pid INTEGER, phase TEXT, backup_path TEXT
    );
    INSERT OR IGNORE INTO lifecycle (id, state) VALUES (1, 'active');
  `)
  return database
  } catch (error) { database.close(); throw error }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** A process-owned mutex. Never steal a living owner's lock merely because a job is slow. */
export async function withProcessLock<T>(filePath: string, name: string, operation: () => T | Promise<T>): Promise<T> {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const database = coordinationDatabase(filePath)
  const token = randomUUID()
  const deadline = Date.now() + 5000
  let acquired = false
  try {
    while (!acquired) {
      acquired = database.transaction(() => {
        const owner = database.prepare('SELECT pid FROM mutexes WHERE name = ?').get(name) as { pid: number } | undefined
        if (owner && processExists(owner.pid)) return false
        database.prepare('DELETE FROM mutexes WHERE name = ?').run(name)
        database.prepare('INSERT INTO mutexes (name, token, pid) VALUES (?, ?, ?)').run(name, token, process.pid)
        return true
      }).immediate()
      if (!acquired) {
        if (Date.now() >= deadline) throw new WorkstackError('STORE_BUSY', 'Another process is updating project data. Retry shortly.')
        await pause(15)
      }
    }
    return await operation()
  } finally {
    if (acquired) database.prepare('DELETE FROM mutexes WHERE name = ? AND token = ?').run(name, token)
    database.close()
  }
}

/** Atomic replacement with unique staging and durable contents before publication. */
export function atomicWriteText(filePath: string, text: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporaryPath, filePath)
    const directory = openSync(path.dirname(filePath), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporaryPath, { force: true })
  }
}

interface LifecycleRow { state: string; token: string | null; pid: number | null; phase: string | null; backup_path: string | null }

function lifecycle(database: Database.Database): LifecycleRow {
  return database.prepare('SELECT state, token, pid, phase, backup_path FROM lifecycle WHERE id = 1').get() as LifecycleRow
}

function deletingError(row: LifecycleRow): WorkstackError {
  const recovery = row.backup_path ? ` Recovery backup: ${row.backup_path}.` : ''
  return new WorkstackError('PROJECT_DELETING', `This project is being deleted or requires deletion recovery.${recovery}`)
}

function recoverAbandonedPreparation(database: Database.Database): void {
  const row = lifecycle(database)
  if (row.state === 'deleting' && row.phase === 'preparing' && row.pid && !processExists(row.pid)) {
    database.prepare("UPDATE lifecycle SET state = 'active', token = NULL, pid = NULL, phase = NULL WHERE id = 1").run()
  }
}

export function assertProjectAvailable(rootPath: string): void {
  const filePath = projectLifecyclePath(rootPath)
  if (!existsSync(filePath)) return
  const database = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const row = lifecycle(database)
    if (row.state === 'deleting') throw deletingError(row)
    if (row.state === 'deleted') throw new WorkstackError('PROJECT_NOT_FOUND', 'This project was deleted. Reconnect or explicitly create it again.')
  } finally { database.close() }
}

export interface ProjectOperationLease {
  release(): void
  run<T>(operation: () => T): T
}

export function acquireProjectOperation(rootPath: string, initialize = false): ProjectOperationLease {
  const filePath = projectLifecyclePath(rootPath)
  const database = coordinationDatabase(filePath)
  const token = randomUUID()
  try {
    database.transaction(() => {
      recoverAbandonedPreparation(database)
      const row = lifecycle(database)
      const inherited = operationContext.getStore()
      const sameFile = inherited?.filePath === filePath
      const parentActive = sameFile && inherited.token && database.prepare('SELECT token FROM operations WHERE token = ? AND pid = ?').get(inherited.token, process.pid)
      const deletionOwner = sameFile && inherited.deletionToken === row.token && row.pid === process.pid
      if (row.state === 'deleting' && !parentActive && !deletionOwner) throw deletingError(row)
      if (row.state === 'deleted') {
        if (!initialize) throw new WorkstackError('PROJECT_NOT_FOUND', 'This project was deleted. Explicitly create or reconnect it first.')
        database.prepare("UPDATE lifecycle SET state = 'active', token = NULL, pid = NULL, phase = NULL, backup_path = NULL WHERE id = 1").run()
      }
      database.prepare('INSERT INTO operations (token, pid) VALUES (?, ?)').run(token, process.pid)
    }).immediate()
  } catch (error) {
    database.close()
    throw error
  }
  let released = false
  return {
    run: (operation) => operationContext.run({ filePath, token }, operation),
    release: () => {
      if (released) return
      released = true
      try { database.prepare('DELETE FROM operations WHERE token = ?').run(token) } finally { database.close() }
    }
  }
}

export interface ProjectDeletionBarrier {
  run<T>(operation: () => T): T
  removing(backupPath: string): void
  finish(state: 'active' | 'deleted' | 'recovery'): void
}

export async function beginProjectDeletion(rootPath: string, timeoutMs = 5000): Promise<ProjectDeletionBarrier> {
  const filePath = projectLifecyclePath(rootPath)
  const database = coordinationDatabase(filePath)
  const token = randomUUID()
  let acquired = false
  try {
    database.transaction(() => {
      recoverAbandonedPreparation(database)
      const row = lifecycle(database)
      if (row.state === 'deleting') throw deletingError(row)
      if (row.state === 'deleted') throw new WorkstackError('PROJECT_NOT_FOUND', 'This project was already deleted.')
      database.prepare("UPDATE lifecycle SET state = 'deleting', token = ?, pid = ?, phase = 'preparing', backup_path = NULL WHERE id = 1").run(token, process.pid)
      acquired = true
    }).immediate()
    const deadline = Date.now() + timeoutMs
    while (true) {
      const active = database.transaction(() => {
        for (const operation of database.prepare('SELECT token, pid FROM operations').all() as Array<{ token: string; pid: number }>) {
          if (!processExists(operation.pid)) database.prepare('DELETE FROM operations WHERE token = ?').run(operation.token)
        }
        return (database.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count
      }).immediate()
      if (active === 0) break
      if (Date.now() >= deadline) throw new WorkstackError('STORE_BUSY', 'Deletion cancelled because project operations are still running. Stop active work and retry.')
      await pause(20)
    }
  } catch (error) {
    if (acquired) database.prepare("UPDATE lifecycle SET state = 'active', token = NULL, pid = NULL, phase = NULL WHERE token = ?").run(token)
    database.close()
    throw error
  }
  let finished = false
  return {
    run: (operation) => operationContext.run({ filePath, deletionToken: token }, operation),
    removing: (backupPath) => {
      database.prepare("UPDATE lifecycle SET phase = 'removing', backup_path = ? WHERE token = ?").run(backupPath, token)
    },
    finish: (state) => {
      if (finished) return
      finished = true
      try {
        database.prepare('UPDATE lifecycle SET state = ?, token = NULL, pid = NULL, phase = ? WHERE token = ?')
          .run(state === 'recovery' ? 'deleting' : state, state === 'recovery' ? 'recovery' : null, token)
      } finally { database.close() }
    }
  }
}

#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'

const manifestName = '.deletion-manifest.json'
const transient = new Set([manifestName, 'workstack.db-wal', 'workstack.db-shm', 'workstack.db-journal'])

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

async function filesIn(directory, relative = '') {
  const files = []
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (!relative && transient.has(entry.name)) continue
    const filename = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await filesIn(directory, filename))
    else if (entry.isFile()) {
      const data = await fs.readFile(path.join(directory, filename))
      files.push({ path: filename.split(path.sep).join('/'), size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
    } else throw new Error(`Backup entries must be regular files and directories: ${filename}`)
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function verify(directory, manifestDirectory = directory) {
  const location = await fs.lstat(directory)
  if (!location.isDirectory() || location.isSymbolicLink()) throw new Error('The backup must be a real directory.')
  const manifest = JSON.parse(await fs.readFile(path.join(manifestDirectory, manifestName), 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('A version 1 deletion manifest is required; this command does not restore unverified legacy backups.')
  if (JSON.stringify(await filesIn(directory)) !== JSON.stringify(manifest.files)) throw new Error('Backup file sizes or checksums do not match the deletion manifest.')
  const database = new Database(path.join(directory, 'workstack.db'), { readonly: true, fileMustExist: true })
  try {
    const integrity = database.pragma('integrity_check')
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || database.pragma('foreign_key_check').length) throw new Error('Backup database integrity check failed.')
    const projects = database.prepare('SELECT id, root_path FROM projects').all()
    const document = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'))
    if (projects.length !== 1 || document.id !== projects[0].id || path.resolve(document.rootPath) !== path.resolve(projects[0].root_path)) throw new Error('Backup database and project document identities do not agree.')
    for (const attachment of database.prepare('SELECT stored_relative_path, size_bytes, sha256 FROM attachments').all()) {
      const filename = path.resolve(directory, attachment.stored_relative_path)
      if (path.isAbsolute(attachment.stored_relative_path) || !isWithin(directory, filename)) throw new Error('Attachment path leaves the backup directory.')
      const data = await fs.readFile(filename)
      if (data.byteLength !== attachment.size_bytes || (attachment.sha256 && createHash('sha256').update(data).digest('hex') !== attachment.sha256)) throw new Error('Referenced attachment does not match its database checksum.')
    }
    return { id: projects[0].id, rootPath: path.resolve(projects[0].root_path), files: manifest.files.length }
  } finally { database.close() }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

async function restore(rootPath, backupPath) {
  if (!path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath || !path.isAbsolute(backupPath)) throw new Error('Use absolute paths for the project root and backup.')
  const project = await verify(backupPath)
  if (project.rootPath !== rootPath) throw new Error(`Restore to the original project root (${project.rootPath}), then use Workstack reconnect to relocate it.`)
  const root = await fs.lstat(rootPath)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The project root must be a real directory.')
  const destination = path.join(rootPath, '.workstack')
  if (isWithin(destination, backupPath)) throw new Error('The backup cannot be inside the destination project data.')
  const coordination = new Database(path.join(rootPath, '.workstack-lifecycle.sqlite'))
  const token = randomUUID()
  let acquired = false
  let published = false
  let previous
  const staging = path.join(rootPath, `.workstack-restore-${token}`)
  try {
    coordination.pragma('busy_timeout = 5000')
    coordination.exec(`CREATE TABLE IF NOT EXISTS operations (token TEXT PRIMARY KEY, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL, token TEXT, pid INTEGER, phase TEXT, backup_path TEXT);
      INSERT OR IGNORE INTO lifecycle (id, state) VALUES (1, 'active');`)
    coordination.transaction(() => {
      const state = coordination.prepare('SELECT * FROM lifecycle WHERE id = 1').get()
      previous = state
      if (state.pid && processExists(state.pid)) throw new Error(`Lifecycle owner process ${state.pid} is still running. Stop it before recovery.`)
      const running = coordination.prepare('SELECT pid FROM operations').all().filter(({ pid }) => processExists(pid))
      if (running.length) throw new Error('Project operations are still running. Stop the desktop, MCP processes and agents before recovery.')
      coordination.prepare('DELETE FROM operations').run()
      coordination.prepare("UPDATE lifecycle SET state = 'deleting', token = ?, pid = ?, phase = 'restoring', backup_path = ? WHERE id = 1").run(token, process.pid, backupPath)
      acquired = true
    }).immediate()
    try {
      await fs.lstat(destination)
      throw new Error(`Existing project data was preserved. Move ${destination} to a separate recovery quarantine folder before retrying; this command never overwrites it.`)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await fs.cp(backupPath, staging, { recursive: true, force: false, errorOnExist: true })
    await verify(staging, backupPath)
    for (const file of await filesIn(staging)) {
      const handle = await fs.open(path.join(staging, file.path), 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    const flushDirectory = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await flushDirectory(path.join(directory, entry.name))
      const handle = await fs.open(directory, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    await flushDirectory(staging)
    await fs.rename(staging, destination)
    published = true
    const rootHandle = await fs.open(rootPath, 'r')
    try { await rootHandle.sync() } finally { await rootHandle.close() }
    coordination.prepare("UPDATE lifecycle SET state = 'active', token = NULL, pid = NULL, phase = NULL WHERE token = ?").run(token)
    acquired = false
    return project
  } finally {
    if (acquired) {
      if (!published) coordination.prepare('UPDATE lifecycle SET state = ?, token = ?, pid = ?, phase = ?, backup_path = ? WHERE token = ?').run(previous.state, previous.token, previous.pid, previous.phase, previous.backup_path, token)
      else coordination.prepare("UPDATE lifecycle SET state = 'deleting', token = NULL, pid = NULL, phase = 'recovery' WHERE token = ?").run(token)
    }
    coordination.close()
    if (!published) await fs.rm(staging, { recursive: true, force: true })
  }
}

try {
  const [command, first, second, ...extra] = process.argv.slice(2)
  if (extra.length || (command === '--verify-backup' ? !first || second : command !== '--restore' || !first || !second)) throw new Error('Usage: node scripts/restore-project.mjs --verify-backup /absolute/backup/.workstack\n   or: node scripts/restore-project.mjs --restore /absolute/project /absolute/backup/.workstack')
  const result = command === '--verify-backup' ? await verify(path.resolve(first)) : await restore(first, path.resolve(second))
  process.stdout.write(`${JSON.stringify({ action: command === '--verify-backup' ? 'verified' : 'restored', ...result }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`Recovery failed: ${error.message}\n`)
  process.exitCode = 1
}

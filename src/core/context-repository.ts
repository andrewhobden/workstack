import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { excludedEvidencePath } from './evidence-policy'
import type { ContextRepositorySnapshot } from './context-packet-contracts'
import { parseWorktrees } from './workspace-identity'

export function contextWorktrees(rootPath: string) { return parseWorktrees(git(rootPath, ['worktree', 'list', '--porcelain', '-z']).toString('utf8')) }

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanTreeHash = hash('')
const maximumEvidenceBytes = 64 * 1024 * 1024
function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function readBoundedFile(absolute: string, maximumBytes: number): { content: Buffer; mode: number } {
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Repository evidence is not a bounded regular file')
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1))
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null)
      if (!count) return { content: Buffer.concat(chunks), mode: stat.mode }
      total += count
      if (total > maximumBytes) throw new Error('Repository evidence exceeds the 64 MiB snapshot limit')
      chunks.push(chunk.subarray(0, count))
    }
  } finally { closeSync(descriptor) }
}
function treeHash(root: string): string {
  const tracked = git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--', '.', ':(glob,exclude)**/.workstack/**', ':(glob,exclude)**/.workstack-lifecycle.sqlite*'])
  const digest = createHash('sha256')
  if (tracked.byteLength) digest.update(JSON.stringify(['tracked', tracked.byteLength])).update('\0').update(tracked)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean).sort()
  let bytes = tracked.byteLength
  for (const relative of untracked) {
    if (relative.split('/').includes('.workstack') || /^\.workstack-lifecycle\.sqlite(?:-(?:wal|shm|journal))?$/.test(path.basename(relative)) || excludedEvidencePath(relative)) continue
    const absolute = path.resolve(root, relative)
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Invalid repository path')
    const stat = lstatSync(absolute)
    if (bytes + stat.size > maximumEvidenceBytes) throw new Error('Repository evidence exceeds the 64 MiB snapshot limit')
    const file = stat.isSymbolicLink() ? { content: Buffer.from(readlinkSync(absolute)), mode: stat.mode } : readBoundedFile(absolute, maximumEvidenceBytes - bytes)
    bytes += file.content.byteLength
    if (bytes > maximumEvidenceBytes) throw new Error('Repository evidence exceeds the 64 MiB snapshot limit')
    digest.update(JSON.stringify([relative, file.mode, file.content.byteLength])).update('\0').update(file.content)
  }
  return digest.digest('hex')
}

/** Local-only Git evidence. Failure is explicit; no fallback to another revision. */
export function captureContextRepository(rootPath: string, workspace?: { path: string; branch: string }): ContextRepositorySnapshot {
  let ancestor = path.resolve(rootPath)
  while (!existsSync(path.join(ancestor, '.git')) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
  if (!existsSync(path.join(ancestor, '.git'))) return { rootPath, kind: 'directory', head: null, branch: null, workingTreeHash: cleanTreeHash, complete: true, limitations: ['This project is a directory without a Git revision.'] }
  const snapshot: ContextRepositorySnapshot = { rootPath, kind: 'git', head: null, branch: null, workingTreeHash: '', complete: false, limitations: [] }
  try {
    snapshot.rootPath = git(rootPath, ['rev-parse', '--show-toplevel']).toString('utf8').trim()
    snapshot.head = git(rootPath, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
    snapshot.branch = git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']).toString('utf8').trim()
    snapshot.workingTreeHash = treeHash(snapshot.rootPath)
    if (workspace) {
      let head = snapshot.head
      let workingTreeHash = cleanTreeHash
      if (existsSync(workspace.path)) {
        const workspaceRoot = git(workspace.path, ['rev-parse', '--show-toplevel']).toString('utf8').trim()
        const branch = git(workspace.path, ['rev-parse', '--abbrev-ref', 'HEAD']).toString('utf8').trim()
        const rootCommon = realpathSync(path.resolve(snapshot.rootPath, git(snapshot.rootPath, ['rev-parse', '--git-common-dir']).toString('utf8').trim()))
        const workspaceCommon = realpathSync(path.resolve(workspace.path, git(workspace.path, ['rev-parse', '--git-common-dir']).toString('utf8').trim()))
        if (realpathSync(workspaceRoot) !== realpathSync(workspace.path) || branch !== workspace.branch || rootCommon !== workspaceCommon) throw new Error('Task workspace root, branch or Git repository changed')
        head = git(workspace.path, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
        workingTreeHash = treeHash(workspaceRoot)
      } else {
        const ref = `refs/heads/${workspace.branch}`
        const branches = git(snapshot.rootPath, ['for-each-ref', '--format=%(refname) %(objectname)', ref]).toString('utf8').trim().split('\n')
        const branch = branches.find((entry) => entry.startsWith(`${ref} `))
        if (branch) head = branch.slice(ref.length + 1)
      }
      snapshot.workspace = { path: workspace.path, branch: workspace.branch, head, workingTreeHash }
    }
    snapshot.complete = true
  } catch {
    snapshot.limitations.push('Could not capture a complete repository revision within the local Git and file limits. Commit or reduce untracked files, check repository access, then rebuild context.')
  }
  return snapshot
}

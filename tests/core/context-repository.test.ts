import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fstatSync, lstatSync, readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureContextRepository, contextWorktrees } from '../../src/core/context-repository'
import { parseWorktrees, selectTaskWorkspace } from '../../src/core/workspace-identity'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFileSync: vi.fn(original.execFileSync) }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, fstatSync: vi.fn(original.fstatSync), lstatSync: vi.fn(original.lstatSync), readlinkSync: vi.fn(original.readlinkSync) }
})

const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const process = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const roots: string[] = []
const limit = 64 * 1024 * 1024
const cleanHash = createHash('sha256').update('').digest('hex')
afterEach(() => { vi.resetAllMocks(); roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })) })

function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workstack-repository-evidence-')))
  roots.push(root)
  return root
}
function fixture(initialCommit = true) {
  const base = directory()
  const root = path.join(base, 'repository')
  fs.mkdirSync(root)
  const git = (args: string[], cwd = root) => process.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test'])
  fs.writeFileSync(path.join(root, 'README.md'), '# Project\n')
  if (initialCommit) { git(['add', '.']); git(['commit', '-m', 'Initial fixture']) }
  return { base, root, git }
}
function sparseFile(file: string, size: number) { fs.writeFileSync(file, ''); fs.truncateSync(file, size) }
function expectIncomplete(snapshot: ReturnType<typeof captureContextRepository>) {
  expect(snapshot).toMatchObject({ kind: 'git', complete: false, limitations: [expect.stringContaining('Could not capture a complete repository revision')] })
}

describe('local repository context evidence', { timeout: 20000 }, () => {
  it('distinguishes directories, unborn repositories, invalid repositories and missing paths without inventing a revision', () => {
    const root = directory()
    expect(captureContextRepository(root)).toEqual({ rootPath: root, kind: 'directory', head: null, branch: null, workingTreeHash: cleanHash, complete: true, limitations: ['This project is a directory without a Git revision.'] })
    expect(captureContextRepository(path.join(root, 'not-created'))).toMatchObject({ kind: 'directory', head: null })
    const unborn = fixture(false)
    expectIncomplete(captureContextRepository(unborn.root))
    const invalid = path.join(root, 'invalid'); fs.mkdirSync(invalid); fs.mkdirSync(path.join(invalid, '.git'))
    expectIncomplete(captureContextRepository(invalid))
    const valid = fixture()
    expectIncomplete(captureContextRepository(path.join(valid.root, 'missing')))
  })

  it('binds canonical repository HEAD, branch and staged/unstaged changes even when the project is nested or symlinked', () => {
    const { base, root, git } = fixture()
    const nested = path.join(root, 'packages', 'app'); fs.mkdirSync(nested, { recursive: true })
    const clean = captureContextRepository(nested)
    expect(clean).toMatchObject({ rootPath: root, kind: 'git', branch: 'main', head: git(['rev-parse', 'HEAD']), complete: true, workingTreeHash: cleanHash, limitations: [] })
    const alias = path.join(base, 'alias'); fs.symlinkSync(root, alias)
    expect(captureContextRepository(alias)).toEqual(clean)
    fs.writeFileSync(path.join(root, 'README.md'), '# Changed\n')
    const unstaged = captureContextRepository(nested)
    expect(unstaged.head).toBe(clean.head); expect(unstaged.workingTreeHash).not.toBe(cleanHash)
    git(['add', 'README.md'])
    expect(captureContextRepository(root).workingTreeHash).toBe(unstaged.workingTreeHash)
    git(['commit', '-m', 'Change content'])
    const committed = captureContextRepository(root)
    expect(committed.head).not.toBe(clean.head); expect(committed.workingTreeHash).toBe(cleanHash)
    git(['switch', '--detach'])
    expect(captureContextRepository(root)).toMatchObject({ branch: 'HEAD', head: committed.head, complete: true })
  })

  it('excludes its own tracked and untracked state, ignored paths and unavailable evidence while detecting ordinary files', () => {
    const { root, git } = fixture()
    for (const file of ['.workstack/metadata.json', 'nested/.workstack/catalog.sqlite', '.workstack-lifecycle.sqlite', 'nested/.workstack-lifecycle.sqlite-wal']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'before')
    }
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n')
    git(['add', '.']); git(['commit', '-m', 'Legacy tracked application state'])
    for (const file of ['.workstack/metadata.json', 'nested/.workstack/catalog.sqlite', '.workstack-lifecycle.sqlite', 'nested/.workstack-lifecycle.sqlite-wal', '.workstack/new.db', 'nested/.workstack/new.db', '.workstack-lifecycle.sqlite-shm', '.workstack-lifecycle.sqlite-journal', '.env', '.npmrc', 'secret.key', 'node_modules/cache', 'ignored.txt']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'after')
    }
    expect(captureContextRepository(root)).toMatchObject({ complete: true, workingTreeHash: cleanHash })
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'Relevant local work')
    expect(captureContextRepository(root).workingTreeHash).not.toBe(cleanHash)
  })

  it('frames untracked file names, contents and modes so distinct file sets produce distinct evidence', () => {
    const { root } = fixture()
    const first = path.join(root, 'a'); const second = path.join(root, 'b')
    fs.writeFileSync(first, 'xb\0y')
    const oneFile = captureContextRepository(root).workingTreeHash
    fs.writeFileSync(first, 'x'); fs.writeFileSync(second, 'y')
    const twoFiles = captureContextRepository(root).workingTreeHash
    expect(twoFiles).not.toBe(oneFile)
    fs.rmSync(first); fs.rmSync(second); fs.writeFileSync(second, 'y'); fs.writeFileSync(first, 'x')
    expect(captureContextRepository(root).workingTreeHash).toBe(twoFiles)
    fs.chmodSync(first, 0o600)
    const privateFile = captureContextRepository(root).workingTreeHash
    fs.chmodSync(first, 0o700)
    expect(captureContextRepository(root).workingTreeHash).not.toBe(privateFile)
    fs.writeFileSync(path.join(root, 'a name\nwith a line break'), '')
    expect(captureContextRepository(root)).toMatchObject({ complete: true })
    expect(captureContextRepository(root).workingTreeHash).not.toBe(twoFiles)
  })

  it('hashes symlink targets without following external files or invoking configured diff helpers', () => {
    const { base, root, git } = fixture()
    const external = path.join(base, 'external.txt'); fs.writeFileSync(external, 'Outside project')
    const link = path.join(root, 'reference'); fs.symlinkSync('../external.txt', link)
    const before = captureContextRepository(root).workingTreeHash
    fs.writeFileSync(external, 'Changed outside project')
    expect(captureContextRepository(root).workingTreeHash).toBe(before)
    fs.rmSync(link); fs.symlinkSync('../other.txt', link)
    expect(captureContextRepository(root).workingTreeHash).not.toBe(before)
    const marker = path.join(base, 'helper-ran')
    const helper = path.join(base, 'diff-helper.sh')
    fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`); fs.chmodSync(helper, 0o700)
    git(['config', 'diff.external', helper]); git(['config', 'diff.review.textconv', helper])
    fs.writeFileSync(path.join(root, '.gitattributes'), 'README.md diff=review\n')
    fs.writeFileSync(path.join(root, 'README.md'), 'Changed tracked text')
    expect(captureContextRepository(root).complete).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('accepts exactly 64 MiB and rejects excess aggregate evidence and oversized Git output', () => {
    const { root } = fixture()
    const large = path.join(root, 'large.bin'); sparseFile(large, limit)
    expect(captureContextRepository(root).complete).toBe(true)
    fs.writeFileSync(path.join(root, 'README.md'), 'Tracked changes consume the same budget.')
    expectIncomplete(captureContextRepository(root))
    fs.rmSync(large)
    fs.writeFileSync(path.join(root, 'README.md'), randomBytes(14 * 1024 * 1024))
    expectIncomplete(captureContextRepository(root))
  }, 20_000)

  it('fails closed for escaped Git paths, disappeared files and non-regular file evidence', () => {
    const { root } = fixture()
    vi.mocked(execFileSync).mockImplementation(((command, args, options) => (args as string[]).includes('ls-files') ? Buffer.from('../outside\0') : process.execFileSync(command, args, options)) as typeof execFileSync)
    expectIncomplete(captureContextRepository(root))
    vi.mocked(execFileSync).mockImplementation(process.execFileSync)
    const vanished = path.join(root, 'vanished'); fs.writeFileSync(vanished, 'transient')
    vi.mocked(lstatSync).mockImplementationOnce(((file, options) => { fs.rmSync(vanished); return fs.lstatSync(file, options) }) as typeof lstatSync)
    expectIncomplete(captureContextRepository(root))
    const fifo = path.join(root, 'named-pipe'); process.execFileSync('mkfifo', [fifo])
    vi.mocked(execFileSync).mockImplementation(((command, args, options) => (args as string[]).includes('ls-files') ? Buffer.from('named-pipe\0') : process.execFileSync(command, args, options)) as typeof execFileSync)
    expectIncomplete(captureContextRepository(root))
    fs.rmSync(fifo)
  })

  it('detects files growing after enumeration or open and always closes bounded file handles', () => {
    const { root } = fixture()
    const file = path.join(root, 'growing.bin'); fs.writeFileSync(file, 'a')
    vi.mocked(lstatSync).mockImplementationOnce(((target, options) => {
      const stat = fs.lstatSync(target, options); fs.truncateSync(file, limit + 1); return stat
    }) as typeof lstatSync)
    expectIncomplete(captureContextRepository(root))
    fs.truncateSync(file, 1)
    let descriptor = -1
    vi.mocked(fstatSync).mockImplementationOnce(((fd, options) => {
      descriptor = fd; const stat = fs.fstatSync(fd, options); fs.truncateSync(file, limit + 1); return stat
    }) as typeof fstatSync)
    expectIncomplete(captureContextRepository(root))
    expect(() => fs.fstatSync(descriptor)).toThrow()
    fs.rmSync(file)
    sparseFile(path.join(root, 'a'), limit - 1)
    const link = path.join(root, 'z'); fs.symlinkSync('x', link)
    vi.mocked(readlinkSync).mockImplementationOnce(((target) => {
      fs.unlinkSync(link); fs.symlinkSync('xx', link); return fs.readlinkSync(target)
    }) as typeof readlinkSync)
    expectIncomplete(captureContextRepository(root))
    expect(vi.mocked(readlinkSync)).toHaveBeenCalledWith(link)
    expect(vi.mocked(readlinkSync).mock.results).toEqual([{ type: 'return', value: 'xx' }])
  }, 20_000)

  it('rejects a regular file replaced by an external symlink between enumeration and open', () => {
    const { base, root } = fixture()
    const outside = path.join(base, 'outside'); fs.writeFileSync(outside, 'Outside content')
    const file = path.join(root, 'local'); fs.writeFileSync(file, 'Local content')
    vi.mocked(lstatSync).mockImplementationOnce(((target, options) => {
      const stat = fs.lstatSync(target, options); fs.rmSync(file); fs.symlinkSync(outside, file); return stat
    }) as typeof lstatSync)
    expectIncomplete(captureContextRepository(root))
  })

  it('binds an existing workspace to its actual root, branch, HEAD, repository and local edits', () => {
    const { base, root, git } = fixture()
    const workspace = { path: path.join(base, 'task\nworkspace'), branch: 'feature/task' }
    git(['worktree', 'add', '-b', workspace.branch, workspace.path])
    expect(contextWorktrees(root)).toEqual([{ path: root, branch: 'main' }, workspace])
    const clean = captureContextRepository(root, workspace)
    expect(clean.workspace).toEqual({ ...workspace, head: clean.head, workingTreeHash: cleanHash })
    fs.writeFileSync(path.join(workspace.path, 'README.md'), 'Task edits')
    fs.writeFileSync(path.join(workspace.path, 'new.txt'), 'New task evidence')
    const changed = captureContextRepository(root, workspace)
    expect(changed.complete).toBe(true); expect(changed.workingTreeHash).toBe(cleanHash); expect(changed.workspace?.workingTreeHash).not.toBe(cleanHash)
    git(['add', '.'], workspace.path); git(['commit', '-m', 'Task change'], workspace.path)
    const committed = captureContextRepository(root, workspace)
    expect(committed.workspace?.head).not.toBe(committed.head); expect(committed.workspace?.workingTreeHash).toBe(cleanHash)
    const alias = path.join(base, 'workspace-alias'); fs.symlinkSync(workspace.path, alias)
    expect(captureContextRepository(root, { ...workspace, path: alias })).toMatchObject({ complete: true, workspace: { head: committed.workspace?.head } })
    const nested = path.join(workspace.path, 'nested'); fs.mkdirSync(nested)
    expectIncomplete(captureContextRepository(root, { ...workspace, path: nested }))
    expectIncomplete(captureContextRepository(root, { ...workspace, branch: 'other' }))
    const foreign = fixture(); foreign.git(['switch', '-c', workspace.branch])
    expectIncomplete(captureContextRepository(root, { ...workspace, path: foreign.root }))
    expectIncomplete(captureContextRepository(root, { ...workspace, path: directory() }))
  })

  it('uses an exact existing branch revision for a future workspace and the captured HEAD for a new branch', () => {
    const { base, root, git } = fixture()
    const original = git(['rev-parse', 'HEAD'])
    git(['switch', '-c', 'future/child']); fs.writeFileSync(path.join(root, 'README.md'), 'Future branch')
    git(['add', '.']); git(['commit', '-m', 'Future revision'])
    const future = git(['rev-parse', 'HEAD']); git(['switch', 'main'])
    const workspace = { path: path.join(base, 'not-created'), branch: 'future/child' }
    expect(captureContextRepository(root, workspace)).toMatchObject({ complete: true, head: original, workspace: { ...workspace, head: future, workingTreeHash: cleanHash } })
    expect(captureContextRepository(root, { ...workspace, branch: 'future' })).toMatchObject({ complete: true, workspace: { head: original } })
    expect(captureContextRepository(root, { ...workspace, branch: 'entirely-new' })).toMatchObject({ complete: true, workspace: { head: original } })
  })
})

describe('shared task workspace identity', () => {
  it('parses NUL-safe and legacy worktree listings while excluding detached, bare and incomplete records', () => {
    expect(parseWorktrees('worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /repo-old\nbranch refs/heads/task\n\nworktree /detached\nHEAD b\ndetached\n\nworktree /bare\nbare\n\nbranch refs/heads/orphan\n')).toEqual([{ path: '/repo', branch: 'main' }, { path: '/repo-old', branch: 'task' }])
    expect(parseWorktrees('worktree /repo\nwith newline\0HEAD a\0branch refs/heads/main\0\0worktree /detached\0detached\0\0')).toEqual([{ path: '/repo\nwith newline', branch: 'main' }])
    expect(parseWorktrees('')).toEqual([])
  })

  it('preserves legacy mappings, rejects ambiguity, and derives stable unique identities independently of title', () => {
    const item = { id: 'UUID/1!', displayId: 'APP / 12' }
    const fresh = selectTaskWorkspace('/parent/repo', item, [{ path: '/different/repo-app-12-old', branch: 'foreign/path' }, { path: '/parent/repo-app-120-old', branch: 'foreign/task' }, { path: '/parent/elsewhere-app-12-old', branch: 'foreign/repo' }])
    expect(fresh).toEqual({ path: '/parent/repo-app---12-uuid-1-', branch: 'codex/app---12-uuid-1-' })
    const legacy = { path: '/parent/repo-app-12-old-title', branch: 'operator/old-branch' }
    expect(selectTaskWorkspace('/parent/repo', item, [legacy])).toEqual(legacy)
    expect(() => selectTaskWorkspace('/parent/repo', item, [legacy, { path: '/parent/repo-app-12-other-title', branch: 'operator/other' }])).toThrow('Several existing worktrees match this task')
    expect(selectTaskWorkspace('/parent/repo', { ...item, id: 'UUID/2!' }, [])).not.toEqual(fresh)
  })
})

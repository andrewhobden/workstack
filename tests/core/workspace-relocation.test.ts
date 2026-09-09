import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import * as lifecycle from '../../src/core/project-lifecycle'
import { relocateTaskWorkspaces } from '../../src/core/workspace-relocation'

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  stores.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'workstack-relocation-')))
  roots.push(root)
  return root
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

interface Manifest { workItemId: string; repositoryRoot: string; branch: string; path: string; contextPacketId: string }
const manifestPath = (root: string, workItemId: string) => path.join(root, '.workstack', 'workspaces', `${encodeURIComponent(workItemId)}.json`)
const readManifest = (root: string, workItemId: string): Manifest => JSON.parse(readFileSync(manifestPath(root, workItemId), 'utf8'))
const adminDirectory = (workspace: string) => readFileSync(path.join(workspace, '.git'), 'utf8').trim().slice('gitdir: '.length)

async function fixture() {
  const base = temporaryRoot()
  const original = path.join(base, 'original', 'repository')
  const moved = path.join(base, 'relocated', 'repository')
  mkdirSync(original, { recursive: true })
  mkdirSync(path.dirname(moved), { recursive: true })
  git(original, ['init', '-b', 'main'])
  git(original, ['config', 'user.name', 'Relocation fixture'])
  git(original, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(path.join(original, '.gitignore'), '.workstack/\n')
  writeFileSync(path.join(original, 'README.md'), 'Committed project content.\n')
  git(original, ['add', '.'])
  git(original, ['commit', '-m', 'Initial fixture'])
  const store = await ProjectStore.initialize({ rootPath: original, name: 'Retained project' })
  const project = store.project
  store.close()
  mkdirSync(path.join(original, '.workstack', 'workspaces'), { recursive: true })
  function addWorkspace(workItemId = 'task-1', created = true): Manifest {
    const manifest = { workItemId, repositoryRoot: original, branch: `codex/${workItemId}`, path: path.join(path.dirname(original), `repository-${workItemId}`), contextPacketId: `packet-${workItemId}` }
    if (created) {
      git(original, ['worktree', 'add', '-b', manifest.branch, manifest.path])
      writeFileSync(path.join(manifest.path, 'README.md'), `Retain dirty tracked work for ${workItemId}.\n`)
      writeFileSync(path.join(manifest.path, 'unfinished.txt'), `Retain untracked work for ${workItemId}.\n`)
    }
    writeFileSync(manifestPath(original, workItemId), JSON.stringify(manifest))
    return manifest
  }
  function move(together: Manifest[] = []): void {
    renameSync(original, moved)
    together.forEach((manifest) => renameSync(manifest.path, path.join(path.dirname(moved), path.basename(manifest.path))))
  }
  return { base, original, moved, project, addWorkspace, move }
}

describe('retained task workspace relocation', { timeout: 20000 }, () => {
  it('leaves non-Git projects without workspace manifests alone', () => {
    const current = temporaryRoot()
    const previous = path.join(current, 'missing-original')
    expect(() => relocateTaskWorkspaces(previous, current)).not.toThrow()
    const directory = path.join(current, '.workstack', 'workspaces')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'notes.txt'), 'Not a workspace manifest.')
    expect(() => relocateTaskWorkspaces(previous, current)).not.toThrow()
    expect(readFileSync(path.join(directory, 'notes.txt'), 'utf8')).toBe('Not a workspace manifest.')
  })

  it('relocates a prepared manifest without creating its worktree or branch', async () => {
    const { original, moved, addWorkspace, move } = await fixture()
    const manifest = addWorkspace('prepared-task', false)
    move()
    relocateTaskWorkspaces(original, moved)
    const projected = readManifest(moved, manifest.workItemId)
    expect(projected).toEqual({ ...manifest, repositoryRoot: moved, path: path.join(path.dirname(moved), path.basename(manifest.path)) })
    expect(existsSync(projected.path)).toBe(false)
    expect(git(moved, ['branch', '--list', manifest.branch])).toBe('')
    expect(git(moved, ['worktree', 'list', '--porcelain'])).not.toContain(manifest.branch)
  })

  it.each(['filename', 'repository', 'schema', 'json'] as const)('rejects an invalid %s before repairing any valid workspace', async (failure) => {
    const { original, moved, addWorkspace, move } = await fixture()
    const valid = addWorkspace('01-valid')
    const invalid = addWorkspace('02-invalid', false)
    const invalidPath = manifestPath(original, invalid.workItemId)
    if (failure === 'filename') renameSync(invalidPath, manifestPath(original, 'wrong-task-id'))
    if (failure === 'repository') writeFileSync(invalidPath, JSON.stringify({ ...invalid, repositoryRoot: path.join(original, 'foreign-repository') }))
    if (failure === 'schema') writeFileSync(invalidPath, JSON.stringify({ ...invalid, path: 'relative/workspace' }))
    if (failure === 'json') writeFileSync(invalidPath, '{ interrupted metadata')
    const pointer = readFileSync(path.join(valid.path, '.git'), 'utf8')
    move()
    expect(() => relocateTaskWorkspaces(original, moved)).toThrow()
    expect(readFileSync(path.join(valid.path, '.git'), 'utf8')).toBe(pointer)
    expect(readManifest(moved, valid.workItemId)).toEqual(valid)
    expect(readFileSync(path.join(valid.path, 'unfinished.txt'), 'utf8')).toContain('01-valid')
  })

  it('rejects duplicate registrations for one branch even when the first matches the manifest', async () => {
    const { original, base, addWorkspace } = await fixture()
    const manifest = addWorkspace()
    const duplicate = path.join(base, 'second-checkout')
    git(original, ['worktree', 'add', '--force', duplicate, manifest.branch])
    const pointer = readFileSync(path.join(manifest.path, '.git'), 'utf8')
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readFileSync(path.join(manifest.path, '.git'), 'utf8')).toBe(pointer)
    expect(git(original, ['worktree', 'list', '--porcelain']).split(`branch refs/heads/${manifest.branch}`)).toHaveLength(3)
    expect(existsSync(duplicate)).toBe(true)
  })

  it('rejects a branch registered at a different path instead of adopting that checkout', async () => {
    const { original, base, addWorkspace } = await fixture()
    const manifest = addWorkspace()
    const unrelated = path.join(base, 'unrelated-files')
    mkdirSync(unrelated)
    writeFileSync(path.join(unrelated, 'notes.txt'), 'Preserve unrelated files.')
    const mismatched = { ...manifest, path: unrelated }
    writeFileSync(manifestPath(original, manifest.workItemId), JSON.stringify(mismatched))
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readManifest(original, manifest.workItemId)).toEqual(mismatched)
    expect(readFileSync(path.join(unrelated, 'notes.txt'), 'utf8')).toBe('Preserve unrelated files.')
  })

  it('refuses a missing registered workspace and preserves its displaced files', async () => {
    const { base, original, moved, addWorkspace, move } = await fixture()
    const manifest = addWorkspace()
    const displaced = path.join(base, 'manually-displaced-task')
    renameSync(manifest.path, displaced)
    move()
    expect(() => relocateTaskWorkspaces(original, moved)).toThrow('Restore its folder or repair its Git registration')
    expect(readManifest(moved, manifest.workItemId)).toEqual(manifest)
    expect(readFileSync(path.join(displaced, 'unfinished.txt'), 'utf8')).toContain(manifest.workItemId)
    expect(existsSync(manifest.path)).toBe(false)
    expect(git(moved, ['worktree', 'list', '--porcelain'])).toContain(manifest.branch)
  })

  it('refuses existing task files whose registration has been lost', async () => {
    const { original, addWorkspace } = await fixture()
    const manifest = addWorkspace()
    rmSync(adminDirectory(manifest.path), { recursive: true })
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readFileSync(path.join(manifest.path, 'unfinished.txt'), 'utf8')).toContain(manifest.workItemId)
    expect(readManifest(original, manifest.workItemId)).toEqual(manifest)
  })

  it('refuses malformed Git pointers without overwriting them', async () => {
    const { original, addWorkspace } = await fixture()
    const manifest = addWorkspace()
    writeFileSync(path.join(manifest.path, '.git'), 'The operator must repair this pointer.\n')
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readFileSync(path.join(manifest.path, '.git'), 'utf8')).toBe('The operator must repair this pointer.\n')
  })

  it('refuses a foreign repository Git pointer and leaves both registrations unchanged', async () => {
    const local = await fixture()
    const foreign = await fixture()
    const manifest = local.addWorkspace()
    const other = foreign.addWorkspace()
    const pointer = readFileSync(path.join(other.path, '.git'), 'utf8')
    const localBacklinkPath = path.join(adminDirectory(manifest.path), 'gitdir')
    const foreignBacklinkPath = path.join(adminDirectory(other.path), 'gitdir')
    const backlinks = [localBacklinkPath, foreignBacklinkPath].map((file) => readFileSync(file, 'utf8'))
    writeFileSync(path.join(manifest.path, '.git'), pointer)
    expect(() => relocateTaskWorkspaces(local.original, local.original)).toThrow('could not be matched')
    expect(readFileSync(path.join(manifest.path, '.git'), 'utf8')).toBe(pointer)
    expect([localBacklinkPath, foreignBacklinkPath].map((file) => readFileSync(file, 'utf8'))).toEqual(backlinks)
    expect(git(other.path, ['rev-parse', '--show-toplevel'])).toBe(other.path)
  })

  it('refuses a same-repository administration directory with another workspace backlink', async () => {
    const { original, addWorkspace } = await fixture()
    const manifest = addWorkspace('first-task')
    const other = addWorkspace('second-task')
    const pointer = readFileSync(path.join(other.path, '.git'), 'utf8')
    const backlinkPath = path.join(adminDirectory(other.path), 'gitdir')
    const backlink = readFileSync(backlinkPath, 'utf8')
    writeFileSync(path.join(manifest.path, '.git'), pointer)
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readFileSync(backlinkPath, 'utf8')).toBe(backlink)
    expect(readManifest(original, manifest.workItemId)).toEqual(manifest)
  })

  it('retries ProjectStore.initialize after one atomic manifest projection failed without losing dirty work', async () => {
    const { moved, project, addWorkspace, move } = await fixture()
    const manifests = [addWorkspace('01-task'), addWorkspace('02-task')]
    move(manifests)
    const write = lifecycle.atomicWriteText
    const failedPath = manifestPath(moved, manifests[1].workItemId)
    const interruption = vi.spyOn(lifecycle, 'atomicWriteText').mockImplementation((filePath, content) => {
      if (filePath === failedPath) throw new Error('Simulated second projection interruption')
      write(filePath, content)
    })
    await expect(ProjectStore.initialize({ rootPath: moved, name: 'Ignore replacement identity' })).rejects.toThrow('second projection interruption')
    expect(readManifest(moved, manifests[0].workItemId).repositoryRoot).toBe(moved)
    expect(readManifest(moved, manifests[1].workItemId)).toEqual(manifests[1])
    const interruptedStore = await ProjectStore.open(moved)
    stores.push(interruptedStore)
    expect(interruptedStore.project).toEqual(project)
    interruptedStore.close()
    interruption.mockRestore()
    const recovered = await ProjectStore.initialize({ rootPath: moved, name: 'Ignore replacement identity' })
    stores.push(recovered)
    expect(recovered.project).toMatchObject({ id: project.id, name: project.name, rootPath: moved })
    for (const manifest of manifests) {
      const workspace = path.join(path.dirname(moved), path.basename(manifest.path))
      expect(readManifest(moved, manifest.workItemId)).toEqual({ ...manifest, repositoryRoot: moved, path: workspace })
      expect(git(workspace, ['rev-parse', '--show-toplevel'])).toBe(workspace)
      expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(manifest.branch)
      expect(readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(`Retain dirty tracked work for ${manifest.workItemId}.\n`)
      expect(readFileSync(path.join(workspace, 'unfinished.txt'), 'utf8')).toBe(`Retain untracked work for ${manifest.workItemId}.\n`)
    }
    expect(JSON.parse(readFileSync(recovered.paths.projectPath, 'utf8'))).toMatchObject({ id: project.id, rootPath: moved })
  })

  it.each(['branch', 'repository'] as const)('detects a %s change between validation and manifest publication', async (change) => {
    const { original, addWorkspace } = await fixture()
    const first = addWorkspace('01-task')
    const second = addWorkspace('02-task')
    const foreign = change === 'repository' ? await fixture() : undefined
    const foreignWorkspace = foreign?.addWorkspace(second.workItemId)
    const write = lifecycle.atomicWriteText
    vi.spyOn(lifecycle, 'atomicWriteText').mockImplementation((filePath, content) => {
      write(filePath, content)
      if (filePath !== manifestPath(original, first.workItemId)) return
      if (foreignWorkspace) writeFileSync(path.join(second.path, '.git'), readFileSync(path.join(foreignWorkspace.path, '.git')))
      else git(second.path, ['switch', '-c', 'operator/changed-during-reconnect'])
    })
    expect(() => relocateTaskWorkspaces(original, original)).toThrow('could not be matched')
    expect(readManifest(original, second.workItemId)).toEqual(second)
    expect(readFileSync(path.join(second.path, 'unfinished.txt'), 'utf8')).toContain(second.workItemId)
  })
})

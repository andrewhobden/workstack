import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { WorkstackError } from './errors'
import { atomicWriteText } from './project-lifecycle'
import { parseWorktrees } from './workspace-identity'

const manifestSchema = z.object({ workItemId: z.string().min(1), repositoryRoot: z.string().refine(path.isAbsolute), branch: z.string().min(1), path: z.string().refine(path.isAbsolute) }).passthrough()
const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const relocate = (value: string, previous: string, current: string) => path.resolve(current, path.relative(previous, value))
const invalid = (location: string) => new WorkstackError('INVALID_STATE_TRANSITION', `The retained task workspace at ${location} could not be matched to this relocated repository. Restore its folder or repair its Git registration, then reconnect again. All task files have been preserved.`)

/** Repair only registered task worktrees; never recreate, clean, prune or change their branches. */
export function relocateTaskWorkspaces(previousRoot: string, currentRoot: string): void {
  const directory = path.join(currentRoot, '.workstack', 'workspaces')
  if (!existsSync(directory)) return
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
  if (!files.length) return
  const repositoryRoot = git(currentRoot, ['rev-parse', '--show-toplevel'])
  const common = git(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const registered = parseWorktrees(git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
  const repairs = files.map((file) => {
    const manifestPath = path.join(directory, file)
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (file !== `${encodeURIComponent(manifest.workItemId)}.json` ||
        (manifest.repositoryRoot !== repositoryRoot && relocate(manifest.repositoryRoot, previousRoot, currentRoot) !== repositoryRoot)) throw invalid(manifest.path)
    const workspacePath = existsSync(manifest.path) ? manifest.path : relocate(manifest.path, manifest.repositoryRoot, repositoryRoot)
    const registrations = registered.filter((entry) => entry.branch === manifest.branch)
    if (registrations.length > 1) throw invalid(manifest.path)
    const registration = registrations[0]
    if (registration && registration.path !== manifest.path && registration.path !== workspacePath) throw invalid(registration.path)
    const present = existsSync(workspacePath)
    if (present) {
      if (!registration) throw invalid(workspacePath)
      const pointer = /^gitdir: (.+)\s*$/.exec(readFileSync(path.join(workspacePath, '.git'), 'utf8'))
      if (!pointer) throw invalid(workspacePath)
      const oldAdmin = path.resolve(workspacePath, pointer[1].trim())
      const admin = existsSync(oldAdmin) ? oldAdmin : relocate(oldAdmin, manifest.repositoryRoot, repositoryRoot)
      // A foreign repository must never be repointed by `git worktree repair`.
      if (path.dirname(admin) !== path.join(common, 'worktrees')) throw invalid(workspacePath)
      const backlink = readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()
      if (backlink !== path.join(manifest.path, '.git') && backlink !== path.join(workspacePath, '.git')) throw invalid(workspacePath)
    } else if (registration) throw invalid(manifest.path)
    return { manifestPath, manifest, workspacePath, present }
  })
  const retained = repairs.filter((entry) => entry.present)
  if (retained.length) git(repositoryRoot, ['worktree', 'repair', '--', ...retained.map((entry) => entry.workspacePath)])
  for (const { manifestPath, manifest, workspacePath, present } of repairs) {
    if (present && (git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']) !== manifest.branch || git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common)) throw invalid(workspacePath)
    // Each projection is atomic. If interrupted, the original project root remains
    // in SQLite and reconnect can safely repeat already-completed Git repairs.
    atomicWriteText(manifestPath, JSON.stringify({ ...manifest, repositoryRoot, path: workspacePath }))
  }
}

import path from 'node:path'
import { WorkstackError } from './errors'

export interface TaskWorkspace { path: string; branch: string }
export function parseWorktrees(output: string): TaskWorkspace[] {
  return output.split(output.includes('\0') ? '\0\0' : '\n\n').flatMap((record) => {
    const fields = record.split(output.includes('\0') ? '\0' : '\n')
    const worktreePath = fields.find((field) => field.startsWith('worktree '))?.slice(9)
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))?.slice(18)
    return worktreePath && branch ? [{ path: worktreePath, branch }] : []
  })
}
export function selectTaskWorkspace(repositoryRoot: string, item: { id: string; displayId: string }, registered: TaskWorkspace[]): TaskWorkspace {
  const prefix = `${path.basename(repositoryRoot)}-${item.displayId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`
  const candidates = registered.filter((entry) => path.dirname(entry.path) === path.dirname(repositoryRoot) && path.basename(entry.path).startsWith(prefix))
  if (candidates.length > 1) throw new WorkstackError('INVALID_STATE_TRANSITION', 'Several existing worktrees match this task. Resolve the ambiguous task workspace mapping before continuing; all files have been preserved.')
  const identity = `${item.displayId}-${item.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return candidates[0] ?? { branch: `codex/${identity}`, path: path.join(path.dirname(repositoryRoot), `${path.basename(repositoryRoot)}-${identity}`) }
}

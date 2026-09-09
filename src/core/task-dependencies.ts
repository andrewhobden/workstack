import { createHash, randomUUID } from 'node:crypto'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import type { ProjectStore } from './project-store'
import type { CompletionRecord } from './types'
import {
  taskDependenciesInputSchema,
  type ActiveTaskOverlap,
  type TaskCoordination,
  type TaskDependenciesInput,
  type TaskPrerequisite,
  type TaskReadiness,
  type TaskReference
} from './task-dependency-contracts'

const taskSelection = 'id AS workItemId, display_id AS displayId, title, status'
interface Scope { kind: 'path' | 'component'; value: string }
interface CompletionRow {
  work_item_id: string; pr_state: 'OPEN' | 'CLOSED' | 'MERGED' | null
  summary_markdown: string; session_summary_markdown: string; implementation_notes_markdown: string
  validation_markdown: string; known_limitations_markdown: string
  files_changed_json: string | null; components_changed_json: string | null
  commit_sha: string | null; branch: string | null; pr_url: string | null
  completed_by_agent_id: string | null; completed_by_session_id: string | null; created_at: string
}

export class TaskDependenciesRepository {
  constructor(private readonly store: ProjectStore, private readonly clock: Clock = systemClock) {}

  get(workItemId: string): TaskCoordination {
    return this.store.database.transaction(() => {
      const task = this.resolve(workItemId)
      const prerequisites = this.prerequisites(task.workItemId)
      const scopes = this.scopes(task.workItemId)
      const related = this.store.database.prepare(`SELECT ${taskSelection} FROM work_items WHERE id IN (
        SELECT second_work_item_id FROM task_related WHERE first_work_item_id = ?
        UNION SELECT first_work_item_id FROM task_related WHERE second_work_item_id = ?
      ) ORDER BY sequence_number`).all(task.workItemId, task.workItemId) as TaskReference[]
      return {
        workItemId: task.workItemId, readiness: readiness(prerequisites), prerequisites, related,
        declaredPaths: scopes.filter((scope) => scope.kind === 'path').map((scope) => scope.value),
        declaredComponents: scopes.filter((scope) => scope.kind === 'component').map((scope) => scope.value),
        activeOverlaps: this.overlaps(task.workItemId, scopes)
      }
    })()
  }

  readiness(workItemId: string): TaskReadiness {
    return this.store.database.transaction(() => readiness(this.prerequisites(this.resolve(workItemId).workItemId)))()
  }

  /** Called inside the same IMMEDIATE transaction that grants a claim. */
  assertReady(workItemId: string): void {
    const state = this.readiness(workItemId)
    if (!state.ready) {
      throw new WorkstackError('WORK_ITEM_NOT_CLAIMABLE', `Unresolved prerequisites: ${state.blockers.map((blocker) => `${blocker.displayId}: ${blocker.reason}`).join('; ')}`)
    }
  }

  update(workItemId: string, input: TaskDependenciesInput): TaskCoordination {
    const parsed = taskDependenciesInputSchema.parse(input)
    return this.store.database.transaction(() => {
      const task = this.resolve(workItemId)
      const now = this.clock.now().toISOString()
      if (parsed.dependsOn !== undefined) {
        if (task.status !== 'backlog') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Prerequisites can only be edited while a task is in the backlog. Recover or release active work first.')
        const targets = this.targets(task, parsed.dependsOn)
        this.store.database.prepare('DELETE FROM task_dependencies WHERE work_item_id = ?').run(task.workItemId)
        for (const target of targets) {
          const cycle = this.store.database.prepare(`WITH RECURSIVE reachable(id) AS (
            SELECT prerequisite_id FROM task_dependencies WHERE work_item_id = ?
            UNION SELECT d.prerequisite_id FROM task_dependencies d JOIN reachable r ON d.work_item_id = r.id
          ) SELECT id FROM reachable WHERE id = ?`).get(target.workItemId, task.workItemId)
          if (cycle) throw new WorkstackError('VALIDATION_ERROR', `Adding ${task.displayId} → ${target.displayId} would create a dependency cycle: ${target.displayId} already depends on ${task.displayId}.`)
          this.store.database.prepare('INSERT INTO task_dependencies VALUES (?, ?, ?)').run(task.workItemId, target.workItemId, now)
        }
      }
      if (parsed.relatedTo !== undefined) {
        const targets = this.targets(task, parsed.relatedTo)
        this.store.database.prepare('DELETE FROM task_related WHERE first_work_item_id = ? OR second_work_item_id = ?').run(task.workItemId, task.workItemId)
        for (const target of targets) {
          const pair = [task.workItemId, target.workItemId].sort()
          this.store.database.prepare('INSERT INTO task_related VALUES (?, ?, ?)').run(pair[0], pair[1], now)
        }
      }
      if (parsed.declaredPaths !== undefined) this.replaceScopes(task.workItemId, 'path', parsed.declaredPaths.map(normalizeDeclaredPath))
      if (parsed.declaredComponents !== undefined) this.replaceScopes(task.workItemId, 'component', parsed.declaredComponents.map((value) => value.toLowerCase()))
      this.store.database.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, task.workItemId)
      this.store.database.prepare(`INSERT INTO activity_events (id,event_type,actor_type,actor_id,work_item_id,payload_json,created_at)
        VALUES (?, 'task_coordination_updated', 'human', NULL, ?, ?, ?)`).run(randomUUID(), task.workItemId, JSON.stringify(parsed), now)
      return this.get(task.workItemId)
    }).immediate()
  }

  private targets(task: TaskReference, identifiers: string[]): TaskReference[] {
    const targets = new Map<string, TaskReference>()
    for (const identifier of identifiers) {
      const target = this.resolve(identifier)
      if (target.workItemId === task.workItemId) throw new WorkstackError('VALIDATION_ERROR', 'A task cannot link to itself.')
      targets.set(target.workItemId, target)
    }
    return [...targets.values()].sort((left, right) => left.workItemId.localeCompare(right.workItemId))
  }

  private resolve(identifier: string): TaskReference {
    const task = this.store.database.prepare(`SELECT ${taskSelection} FROM work_items WHERE id = ? OR display_id = ?`).get(identifier, identifier) as TaskReference | undefined
    if (!task) throw new WorkstackError('WORK_ITEM_NOT_FOUND', `Task ${identifier} does not exist in this project.`)
    return task
  }

  private prerequisites(workItemId: string): TaskPrerequisite[] {
    const tasks = this.store.database.prepare(`SELECT ${taskSelection} FROM work_items WHERE id IN (
      SELECT prerequisite_id FROM task_dependencies WHERE work_item_id = ?
    ) ORDER BY sequence_number`).all(workItemId) as TaskReference[]
    return tasks.map((task) => {
      const row = this.store.database.prepare('SELECT * FROM completion_records WHERE work_item_id = ?').get(task.workItemId) as CompletionRow | undefined
      const satisfied = task.status === 'completed' && Boolean(row) && (row?.pr_url === null || row?.pr_state === 'MERGED')
      const reason = satisfied ? null : row?.pr_state === 'OPEN' ? 'Pull request is awaiting review or has reopened.'
        : row?.pr_state === 'CLOSED' ? 'Pull request closed without merge; a replacement attempt is required.'
          : task.status === 'completed' ? 'Finalized completion evidence is unavailable.' : `Task is ${task.status.replaceAll('_', ' ')}.`
      const completion = row ? toCompletion(row) : null
      const sourceRevisions = this.store.database.prepare(`SELECT c.id AS sourceId, r.id AS revisionId, r.content_hash AS contentHash
        FROM source_catalog c JOIN source_revisions r ON r.id = c.current_revision_id
        WHERE c.work_item_id = ? ORDER BY c.id`).all(task.workItemId) as Array<{ sourceId: string; revisionId: string; contentHash: string }>
      return { ...task, satisfied, reason, outcome: completion ? {
        completion, recordHash: createHash('sha256').update(JSON.stringify(completion)).digest('hex'), sourceRevisions
      } : null }
    })
  }

  private scopes(workItemId: string): Scope[] {
    return this.store.database.prepare('SELECT kind, value FROM task_declared_scopes WHERE work_item_id = ? ORDER BY kind, value').all(workItemId) as Scope[]
  }

  private replaceScopes(workItemId: string, kind: Scope['kind'], values: string[]): void {
    this.store.database.prepare('DELETE FROM task_declared_scopes WHERE work_item_id = ? AND kind = ?').run(workItemId, kind)
    for (const value of [...new Set(values)].sort()) this.store.database.prepare('INSERT INTO task_declared_scopes VALUES (?, ?, ?)').run(workItemId, kind, value)
  }

  private overlaps(workItemId: string, selected: Scope[]): ActiveTaskOverlap[] {
    const active = this.store.database.prepare(`SELECT w.id AS workItemId, w.display_id AS displayId, w.title, w.status,
      c.id AS claimId, c.agent_id AS agentId, c.agent_display_name AS agentDisplayName, c.session_id AS sessionId
      FROM work_claims c JOIN work_items w ON w.id = c.work_item_id
      WHERE c.state = 'active' AND c.lease_expires_at > ? AND c.work_item_id <> ? ORDER BY w.sequence_number, c.id`)
      .all(this.clock.now().toISOString(), workItemId) as Array<Omit<ActiveTaskOverlap, 'advisory' | 'evidence'>>
    const result: ActiveTaskOverlap[] = []
    for (const task of active) {
      const candidates = this.scopes(task.workItemId).map((scope) => ({ ...scope, basis: 'declared' as 'declared' | 'checkpoint', checkpointId: null as string | null }))
      const checkpoint = this.store.database.prepare('SELECT id, payload_json FROM work_checkpoints WHERE claim_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(task.claimId) as { id: string; payload_json: string } | undefined
      if (checkpoint) {
        const payload = JSON.parse(checkpoint.payload_json) as { filesChanged: string[] }
        for (const file of payload.filesChanged) {
          try { candidates.push({ kind: 'path', value: normalizeDeclaredPath(file), basis: 'checkpoint', checkpointId: checkpoint.id }) }
          catch { /* Existing checkpoints may contain non-project paths; they are not scope evidence. */ }
        }
      }
      const evidence: ActiveTaskOverlap['evidence'] = []
      for (const scope of selected) for (const candidate of candidates) {
        const overlaps = scope.kind === candidate.kind && (scope.kind === 'component' ? scope.value === candidate.value
          : scope.value === candidate.value || scope.value.startsWith(`${candidate.value}/`) || candidate.value.startsWith(`${scope.value}/`))
        if (overlaps) evidence.push({ kind: scope.kind, selectedValue: scope.value, activeValue: candidate.value, basis: candidate.basis, checkpointId: candidate.checkpointId })
      }
      if (evidence.length) result.push({ ...task, advisory: true, evidence })
    }
    return result
  }
}

function readiness(prerequisites: TaskPrerequisite[]): TaskReadiness {
  const blockers = prerequisites.filter((task) => !task.satisfied).map((task) => ({ workItemId: task.workItemId, displayId: task.displayId, reason: task.reason! }))
  return { ready: blockers.length === 0, blockers }
}

export function normalizeDeclaredPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..') || [...normalized].some((character) => '*?[]{}'.includes(character) || character.charCodeAt(0) < 32)) {
    throw new WorkstackError('VALIDATION_ERROR', 'Declare repository-relative file or directory paths without parent traversal or glob patterns.')
  }
  return normalized
}

function toCompletion(row: CompletionRow): CompletionRecord {
  return {
    workItemId: row.work_item_id, prState: row.pr_state, summaryMarkdown: row.summary_markdown,
    sessionSummaryMarkdown: row.session_summary_markdown, implementationNotesMarkdown: row.implementation_notes_markdown,
    validationMarkdown: row.validation_markdown, knownLimitationsMarkdown: row.known_limitations_markdown,
    filesChanged: JSON.parse(row.files_changed_json ?? '[]') as string[], componentsChanged: JSON.parse(row.components_changed_json ?? '[]') as string[],
    commitSha: row.commit_sha, branch: row.branch, prUrl: row.pr_url,
    completedByAgentId: row.completed_by_agent_id, completedBySessionId: row.completed_by_session_id, createdAt: row.created_at
  }
}

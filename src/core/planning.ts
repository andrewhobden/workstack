import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { ProjectStore } from './project-store'
import type { PlanningMessage, PlanningProposal, WorkItemType } from './types'
import { WorkItemRepository } from './work-items'

const proposalPatchSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['feature', 'bug', 'chore']).optional(),
  descriptionMarkdown: z.string().optional(),
  requirementsMarkdown: z.string().optional(),
  acceptanceCriteriaMarkdown: z.string().optional(),
  implementationContextMarkdown: z.string().optional(),
  relatedReferences: z.array(z.string()).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional()
}).strict()

interface ProposalRow {
  planning_session_id: string
  title: string
  type: WorkItemType
  description_markdown: string
  requirements_markdown: string
  acceptance_criteria_markdown: string
  implementation_context_markdown: string
  related_references_json: string
  priority: PlanningProposal['priority']
  user_modified_fields_json: string
  revision: number
  updated_at: string
}

interface PlanningMessageRow {
  id: string
  planning_session_id: string
  role: PlanningMessage['role']
  content_markdown: string
  created_at: string
}

export class PlanningRepository {
  constructor(private readonly store: ProjectStore, private readonly dependencies: { clock?: Clock; id?: () => string } = {}) {}

  createSession(): PlanningProposal {
    const id = this.createId()
    const now = this.now()
    this.store.database.transaction(() => {
      this.store.database.prepare(
        "INSERT INTO planning_sessions (id, project_id, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)"
      ).run(id, this.store.project.id, now, now)
      this.store.database.prepare(
        `INSERT INTO work_item_proposals (
          planning_session_id, updated_at
        ) VALUES (?, ?)`
      ).run(id, now)
    })()
    return this.getProposal(id)
  }

  getProposal(sessionId: string): PlanningProposal {
    const row = this.store.database.prepare('SELECT * FROM work_item_proposals WHERE planning_session_id = ?').get(sessionId) as ProposalRow | undefined
    if (!row) {
      throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The requested planning proposal does not exist.')
    }

    return toProposal(row)
  }

  listMessages(sessionId: string): PlanningMessage[] {
    this.getProposal(sessionId)
    return (this.store.database.prepare(
      'SELECT * FROM planning_messages WHERE planning_session_id = ? ORDER BY created_at ASC, id ASC'
    ).all(sessionId) as PlanningMessageRow[]).map(toPlanningMessage)
  }

  addMessage(sessionId: string, role: PlanningMessage['role'], contentMarkdown: string): PlanningMessage {
    this.getProposal(sessionId)
    const content = contentMarkdown.trim()
    if (!content) throw new WorkstackError('VALIDATION_ERROR', 'A planning message cannot be empty.')
    const message: PlanningMessage = { id: this.createId(), planningSessionId: sessionId, role, contentMarkdown: content, createdAt: this.now() }
    this.store.database.prepare(
      'INSERT INTO planning_messages (id, planning_session_id, role, content_markdown, created_at) VALUES (@id, @planningSessionId, @role, @contentMarkdown, @createdAt)'
    ).run(message)
    return message
  }

  updateProposal(sessionId: string, patch: Partial<Omit<PlanningProposal, 'planningSessionId' | 'userModifiedFields' | 'revision' | 'updatedAt'>>, userEdited = true): PlanningProposal {
    const parsed = proposalPatchSchema.parse(patch)
    const existing = this.getProposal(sessionId)
    const permitted = (userEdited
      ? parsed
      : Object.fromEntries(Object.entries(parsed).filter(([field]) => !existing.userModifiedFields.includes(field)))) as typeof parsed
    const userModifiedFields = userEdited
      ? [...new Set([...existing.userModifiedFields, ...Object.keys(permitted)])]
      : existing.userModifiedFields
    const next = {
      ...existing,
      ...permitted,
      relatedReferences: permitted.relatedReferences ?? existing.relatedReferences,
      userModifiedFields,
      revision: existing.revision + 1,
      updatedAt: this.now()
    }
    this.store.database.prepare(
      `UPDATE work_item_proposals SET
        title = @title, type = @type, description_markdown = @descriptionMarkdown,
        requirements_markdown = @requirementsMarkdown, acceptance_criteria_markdown = @acceptanceCriteriaMarkdown,
        implementation_context_markdown = @implementationContextMarkdown, related_references_json = @relatedReferencesJson,
        priority = @priority, user_modified_fields_json = @userModifiedFieldsJson, revision = @revision, updated_at = @updatedAt
       WHERE planning_session_id = @planningSessionId`
    ).run({ ...next, relatedReferencesJson: JSON.stringify(next.relatedReferences), userModifiedFieldsJson: JSON.stringify(next.userModifiedFields) })
    return next
  }

  convertToWorkItem(sessionId: string) {
    const proposal = this.getProposal(sessionId)
    if (!proposal.title.trim()) {
      throw new WorkstackError('VALIDATION_ERROR', 'A proposal title is required before adding it to the backlog.')
    }
    return this.store.database.transaction(() => {
      const session = this.store.database.prepare("SELECT status FROM planning_sessions WHERE id = ?").get(sessionId) as { status: string }
      if (session.status !== 'open') {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'This proposal has already been converted or is unavailable.')
      }
      const workItem = new WorkItemRepository(this.store, { clock: this.dependencies.clock, id: this.dependencies.id }).create({
        title: proposal.title,
        type: proposal.type,
        descriptionMarkdown: proposal.descriptionMarkdown,
        acceptanceCriteriaMarkdown: proposal.acceptanceCriteriaMarkdown,
        priority: proposal.priority,
        source: 'ai_plan'
      })
      this.store.database.prepare(
        "UPDATE planning_sessions SET status = 'converted', converted_work_item_id = ?, updated_at = ? WHERE id = ?"
      ).run(workItem.id, this.now(), sessionId)
      return workItem
    }).immediate()
  }

  private now(): string {
    return (this.dependencies.clock ?? systemClock).now().toISOString()
  }

  private createId(): string {
    return (this.dependencies.id ?? randomUUID)()
  }
}

function toProposal(row: ProposalRow): PlanningProposal {
  return {
    planningSessionId: row.planning_session_id,
    title: row.title,
    type: row.type,
    descriptionMarkdown: row.description_markdown,
    requirementsMarkdown: row.requirements_markdown,
    acceptanceCriteriaMarkdown: row.acceptance_criteria_markdown,
    implementationContextMarkdown: row.implementation_context_markdown,
    relatedReferences: JSON.parse(row.related_references_json) as string[],
    priority: row.priority,
    userModifiedFields: JSON.parse(row.user_modified_fields_json) as string[],
    revision: row.revision,
    updatedAt: row.updated_at
  }

}

function toPlanningMessage(row: PlanningMessageRow): PlanningMessage {
  return { id: row.id, planningSessionId: row.planning_session_id, role: row.role, contentMarkdown: row.content_markdown, createdAt: row.created_at }
}

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { ProjectStore } from './project-store'
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  type ActivityEvent,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItem,
  type WorkItemFilters,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemType
} from './types'

const createWorkItemSchema = z.object({
  type: z.enum(WORK_ITEM_TYPES).default('feature'),
  title: z.string().trim().min(1),
  descriptionMarkdown: z.string().default(''),
  acceptanceCriteriaMarkdown: z.string().default(''),
  priority: z.enum(WORK_ITEM_PRIORITIES).default('normal'),
  source: z.enum(WORK_ITEM_SOURCES).default('manual'),
  createdBy: z.string().trim().min(1).optional()
})

const updateWorkItemSchema = z
  .object({
    type: z.enum(WORK_ITEM_TYPES).optional(),
    title: z.string().optional(),
    descriptionMarkdown: z.string().optional(),
    acceptanceCriteriaMarkdown: z.string().optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional()
  })
  .strict()

const listFiltersSchema = z
  .object({
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    type: z.enum(WORK_ITEM_TYPES).optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    source: z.enum(WORK_ITEM_SOURCES).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()

interface WorkItemRow {
  id: string
  sequence_number: number
  display_id: string
  type: WorkItemType
  title: string
  description_markdown: string
  acceptance_criteria_markdown: string
  priority: WorkItemPriority
  status: WorkItemStatus
  source: WorkItemSource
  created_by: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ActivityEventRow {
  id: string
  event_type: string
  actor_type: ActivityEvent['actorType']
  actor_id: string | null
  work_item_id: string | null
  payload_json: string
  created_at: string
}

export class WorkItemRepository {
  constructor(
    private readonly store: ProjectStore,
    private readonly dependencies: { clock?: Clock; id?: () => string } = {}
  ) {}

  create(input: CreateWorkItemInput): WorkItem {
    const parsed = createWorkItemSchema.parse(input)
    const now = this.now()
    const id = this.createId()
    const insert = this.store.database.prepare(
      `INSERT INTO work_items (
        id, sequence_number, display_id, type, title, description_markdown,
        acceptance_criteria_markdown, priority, status, source, created_by, created_at, updated_at
      ) VALUES (
        @id, @sequenceNumber, @displayId, @type, @title, @descriptionMarkdown,
        @acceptanceCriteriaMarkdown, @priority, 'backlog', @source, @createdBy, @createdAt, @updatedAt
      )`
    )

    const transaction = this.store.database.transaction(() => {
      const sequenceNumber = this.nextSequenceNumber()
      const workItem: WorkItem = {
        id,
        sequenceNumber,
        displayId: `${this.store.project.settings.workItemPrefix}-${sequenceNumber}`,
        type: parsed.type,
        title: parsed.title,
        descriptionMarkdown: parsed.descriptionMarkdown,
        acceptanceCriteriaMarkdown: parsed.acceptanceCriteriaMarkdown,
        priority: parsed.priority,
        status: 'backlog',
        source: parsed.source,
        createdBy: parsed.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      }

      insert.run({
        ...workItem,
        sequenceNumber: workItem.sequenceNumber,
        displayId: workItem.displayId,
        descriptionMarkdown: workItem.descriptionMarkdown,
        acceptanceCriteriaMarkdown: workItem.acceptanceCriteriaMarkdown,
        createdBy: workItem.createdBy,
        createdAt: workItem.createdAt,
        updatedAt: workItem.updatedAt
      })
      this.replaceSearchDocument(workItem)
      this.recordActivity('work_item_created', 'human', workItem.createdBy, workItem.id, { displayId: workItem.displayId })
      this.syncMirror(workItem)
      return workItem
    })

    return transaction.immediate()
  }

  get(id: string): WorkItem {
    const row = this.store.database.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined
    if (!row) {
      throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The requested work item does not exist.')
    }
    return toWorkItem(row)
  }

  list(filters: WorkItemFilters = {}): WorkItem[] {
    const parsed = listFiltersSchema.parse(filters)
    const clauses: string[] = []
    const values: unknown[] = []

    appendClause(clauses, values, 'status', parsed.status)
    appendClause(clauses, values, 'type', parsed.type)
    appendClause(clauses, values, 'priority', parsed.priority)
    appendClause(clauses, values, 'source', parsed.source)

    if (parsed.query?.trim()) {
      clauses.push(`(
        LOWER(title) LIKE ?
        OR LOWER(description_markdown) LIKE ?
        OR LOWER(acceptance_criteria_markdown) LIKE ?
        OR id IN (
          SELECT work_item_id FROM work_item_search
          WHERE LOWER(completion_markdown) LIKE ?
        )
      )`)
      const query = `%${parsed.query.trim().toLowerCase()}%`
      values.push(query, query, query, query)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = parsed.limit ? 'LIMIT ?' : ''
    if (parsed.limit) {
      values.push(parsed.limit)
    }

    const rows = this.store.database
      .prepare(`SELECT * FROM work_items ${where} ORDER BY sequence_number DESC ${limit}`)
      .all(...values) as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  update(id: string, patch: UpdateWorkItemInput): WorkItem {
    const parsed = updateWorkItemSchema.parse(patch)
    const existing = this.get(id)
    const now = this.now()
    const title = parsed.title === undefined ? existing.title : parsed.title.trim()
    if (!title) {
      throw new WorkstackError('VALIDATION_ERROR', 'Work item title is required.')
    }

    const next: WorkItem = {
      ...existing,
      type: parsed.type ?? existing.type,
      title,
      descriptionMarkdown: parsed.descriptionMarkdown ?? existing.descriptionMarkdown,
      acceptanceCriteriaMarkdown: parsed.acceptanceCriteriaMarkdown ?? existing.acceptanceCriteriaMarkdown,
      priority: parsed.priority ?? existing.priority,
      updatedAt: now
    }

    const transaction = this.store.database.transaction(() => {
      this.store.database
        .prepare(
          `UPDATE work_items
           SET type = @type,
               title = @title,
               description_markdown = @descriptionMarkdown,
               acceptance_criteria_markdown = @acceptanceCriteriaMarkdown,
               priority = @priority,
               updated_at = @updatedAt
           WHERE id = @id`
        )
        .run(next)
      this.replaceSearchDocument(next)
      this.recordActivity('work_item_updated', 'human', next.createdBy, next.id, { displayId: next.displayId })
      this.syncMirror(next)
    })
    transaction.immediate()
    return next
  }

  delete(id: string): void {
    const workItem = this.get(id)
    if (workItem.status !== 'backlog') {
      throw new WorkstackError('INVALID_STATE_TRANSITION', 'Only backlog work items can be deleted.')
    }

    const transaction = this.store.database.transaction(() => {
      this.store.database.prepare('DELETE FROM work_item_search WHERE work_item_id = ?').run(id)
      this.recordActivity('work_item_deleted', 'human', workItem.createdBy, id, { displayId: workItem.displayId })
      this.store.database.prepare('DELETE FROM work_items WHERE id = ?').run(id)
    })
    transaction.immediate()
    rmSync(this.workItemPath(id), { recursive: true, force: true })
  }

  listActivity(workItemId?: string): ActivityEvent[] {
    const rows = workItemId
      ? (this.store.database
          .prepare('SELECT * FROM activity_events WHERE work_item_id = ? ORDER BY created_at DESC, id DESC')
          .all(workItemId) as ActivityEventRow[])
      : (this.store.database
          .prepare('SELECT * FROM activity_events ORDER BY created_at DESC, id DESC')
          .all() as ActivityEventRow[])
    return rows.map(toActivityEvent)
  }

  private nextSequenceNumber(): number {
    const result = this.store.database
      .prepare('SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence_number FROM work_items')
      .get() as { next_sequence_number: number }
    return result.next_sequence_number
  }

  private replaceSearchDocument(workItem: WorkItem): void {
    this.store.database.prepare('DELETE FROM work_item_search WHERE work_item_id = ?').run(workItem.id)
    this.store.database
      .prepare(
        `INSERT INTO work_item_search (
          work_item_id, title, description_markdown, acceptance_criteria_markdown, completion_markdown
        ) VALUES (?, ?, ?, ?, '')`
      )
      .run(
        workItem.id,
        workItem.title,
        workItem.descriptionMarkdown,
        workItem.acceptanceCriteriaMarkdown
      )
  }

  recordActivity(
    eventType: string,
    actorType: ActivityEvent['actorType'],
    actorId: string | null,
    workItemId: string,
    payload: Record<string, unknown>
  ): void {
    this.store.database
      .prepare(
        `INSERT INTO activity_events (
          id, event_type, actor_type, actor_id, work_item_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.createId(), eventType, actorType, actorId, workItemId, JSON.stringify(payload), this.now())
  }

  syncMirror(workItem: WorkItem): void {
    const directory = this.workItemPath(workItem.id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'work-item.md'), renderWorkItemMirror(workItem), 'utf8')
  }

  updateCompletionSearchDocument(workItemId: string, completionMarkdown: string): void {
    this.store.database
      .prepare('UPDATE work_item_search SET completion_markdown = ? WHERE work_item_id = ?')
      .run(completionMarkdown, workItemId)
  }

  private workItemPath(id: string): string {
    return path.join(this.store.paths.workItemsPath, id)
  }

  private now(): string {
    return (this.dependencies.clock ?? systemClock).now().toISOString()
  }

  private createId(): string {
    return (this.dependencies.id ?? randomUUID)()
  }
}

function appendClause(clauses: string[], values: unknown[], column: string, value: string | undefined): void {
  if (value) {
    clauses.push(`${column} = ?`)
    values.push(value)
  }
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    displayId: row.display_id,
    type: row.type,
    title: row.title,
    descriptionMarkdown: row.description_markdown,
    acceptanceCriteriaMarkdown: row.acceptance_criteria_markdown,
    priority: row.priority,
    status: row.status,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function toActivityEvent(row: ActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    workItemId: row.work_item_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at
  }
}

export function renderWorkItemMirror(workItem: WorkItem): string {
  return `---
id: ${workItem.id}
display_id: ${workItem.displayId}
type: ${workItem.type}
status: ${workItem.status}
priority: ${workItem.priority}
created_at: ${workItem.createdAt}
updated_at: ${workItem.updatedAt}
---

# ${workItem.title}

## Description
${workItem.descriptionMarkdown}

## Acceptance criteria
${workItem.acceptanceCriteriaMarkdown}
`
}

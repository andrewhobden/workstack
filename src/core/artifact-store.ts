import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { WorkstackError } from './errors'
import { ProjectStore } from './project-store'
import { WorkItemRepository } from './work-items'
import type { Attachment, BinaryAttachmentInput, FileAttachmentInput, PastedImageInput } from './types'

interface AttachmentRow {
  id: string
  work_item_id: string | null
  planning_session_id: string | null
  original_filename: string
  stored_relative_path: string
  mime_type: string | null
  size_bytes: number
  sha256: string | null
  created_at: string
}

export class ArtifactStore {
  constructor(
    private readonly store: ProjectStore,
    private readonly createId: () => string = randomUUID
  ) {}

  attachFile(workItemId: string, input: FileAttachmentInput): Attachment {
    const source = statSync(input.sourcePath)
    if (!source.isFile()) {
      throw new WorkstackError('VALIDATION_ERROR', 'Only files can be attached to a work item.')
    }

    const originalFilename = input.originalFilename ?? path.basename(input.sourcePath)
    return this.persist({ kind: 'work_item', id: workItemId }, {
      originalFilename,
      mimeType: input.mimeType ?? 'application/octet-stream',
      write: (destination) => copyFileSync(input.sourcePath, destination)
    })
  }

  attachBytes(workItemId: string, input: BinaryAttachmentInput): Attachment {
    if (input.data.length === 0) {
      throw new WorkstackError('VALIDATION_ERROR', 'Attachment data cannot be empty.')
    }

    return this.persist({ kind: 'work_item', id: workItemId }, {
      originalFilename: input.originalFilename,
      mimeType: input.mimeType ?? 'application/octet-stream',
      write: (destination) => writeFileSync(destination, input.data)
    })
  }

  pasteImage(workItemId: string, input: PastedImageInput): Attachment {
    if (input.data.length === 0) {
      throw new WorkstackError('VALIDATION_ERROR', 'Pasted image data cannot be empty.')
    }

    const attachment = this.attachBytes(workItemId, {
      data: input.data,
      originalFilename: input.originalFilename ?? 'screenshot.png',
      mimeType: input.mimeType ?? 'image/png'
    })
    const workItem = new WorkItemRepository(this.store).get(workItemId)
    const markdown = `![${attachment.originalFilename}](attachments/${path.basename(attachment.storedRelativePath)})`
    new WorkItemRepository(this.store).update(workItemId, {
      descriptionMarkdown: appendMarkdown(workItem.descriptionMarkdown, markdown)
    })
    return attachment
  }

  list(workItemId: string): Attachment[] {
    return (
      this.store.database
        .prepare('SELECT * FROM attachments WHERE work_item_id = ? ORDER BY created_at ASC, id ASC')
        .all(workItemId) as AttachmentRow[]
    ).map(toAttachment)
  }

  attachPlanningBytes(sessionId: string, input: BinaryAttachmentInput): Attachment {
    if (input.data.length === 0) {
      throw new WorkstackError('VALIDATION_ERROR', 'Attachment data cannot be empty.')
    }
    return this.persist({ kind: 'planning_session', id: sessionId }, {
      originalFilename: input.originalFilename,
      mimeType: input.mimeType ?? 'application/octet-stream',
      write: (destination) => writeFileSync(destination, input.data)
    })
  }

  pastePlanningImage(sessionId: string, input: PastedImageInput): Attachment {
    if (input.data.length === 0) {
      throw new WorkstackError('VALIDATION_ERROR', 'Pasted image data cannot be empty.')
    }
    return this.attachPlanningBytes(sessionId, {
      data: input.data,
      originalFilename: input.originalFilename ?? 'screenshot.png',
      mimeType: input.mimeType ?? 'image/png'
    })
  }

  listPlanning(sessionId: string): Attachment[] {
    this.requirePlanningSession(sessionId)
    return (
      this.store.database
        .prepare('SELECT * FROM attachments WHERE planning_session_id = ? ORDER BY created_at ASC, id ASC')
        .all(sessionId) as AttachmentRow[]
    ).map(toAttachment)
  }

  get(workItemId: string, attachmentId: string): Attachment {
    const row = this.store.database
      .prepare('SELECT * FROM attachments WHERE id = ? AND work_item_id = ?')
      .get(attachmentId, workItemId) as AttachmentRow | undefined
    if (!row) {
      throw new WorkstackError('ATTACHMENT_NOT_FOUND', 'The requested attachment does not exist.')
    }
    return toAttachment(row)
  }

  getPlanning(sessionId: string, attachmentId: string): Attachment {
    this.requirePlanningSession(sessionId)
    const row = this.store.database
      .prepare('SELECT * FROM attachments WHERE id = ? AND planning_session_id = ?')
      .get(attachmentId, sessionId) as AttachmentRow | undefined
    if (!row) {
      throw new WorkstackError('ATTACHMENT_NOT_FOUND', 'The requested attachment does not exist.')
    }
    return toAttachment(row)
  }

  resolvePath(workItemId: string, attachmentId: string): string {
    const attachment = this.get(workItemId, attachmentId)
    const candidate = path.resolve(this.store.paths.workstackPath, attachment.storedRelativePath)
    const artifactRoot = path.resolve(this.store.paths.workstackPath)
    if (!candidate.startsWith(`${artifactRoot}${path.sep}`)) {
      throw new WorkstackError('ATTACHMENT_NOT_FOUND', 'The attachment path is outside the Workstack artifact store.')
    }
    return candidate
  }

  read(workItemId: string, attachmentId: string): Buffer {
    return readFileSync(this.resolvePath(workItemId, attachmentId))
  }

  readPlanning(sessionId: string, attachmentId: string): Buffer {
    return readFileSync(this.resolvePlanningPath(sessionId, attachmentId))
  }

  remove(workItemId: string, attachmentId: string): void {
    const pathToRemove = this.resolvePath(workItemId, attachmentId)
    this.store.database.prepare('DELETE FROM attachments WHERE id = ? AND work_item_id = ?').run(attachmentId, workItemId)
    rmSync(pathToRemove, { force: true })
  }

  removePlanning(sessionId: string, attachmentId: string): void {
    const pathToRemove = this.resolvePlanningPath(sessionId, attachmentId)
    this.store.database.prepare('DELETE FROM attachments WHERE id = ? AND planning_session_id = ?').run(attachmentId, sessionId)
    rmSync(pathToRemove, { force: true })
  }

  resolvePlanningPath(sessionId: string, attachmentId: string): string {
    return this.resolveAttachmentPath(this.getPlanning(sessionId, attachmentId))
  }

  private persist(
    owner: { kind: 'work_item' | 'planning_session'; id: string },
    input: { originalFilename: string; mimeType: string; write(destination: string): void }
  ): Attachment {
    if (owner.kind === 'work_item') {
      new WorkItemRepository(this.store).get(owner.id)
    } else {
      this.requirePlanningSession(owner.id)
    }
    const id = this.createId()
    const originalFilename = input.originalFilename.trim()
    if (!originalFilename) {
      throw new WorkstackError('VALIDATION_ERROR', 'Attachment filename is required.')
    }

    const storedFilename = `${id}-${safeFilename(originalFilename)}`
    const directory = owner.kind === 'work_item'
      ? path.join(this.store.paths.workItemsPath, owner.id, 'attachments')
      : path.join(this.store.paths.workstackPath, 'planning-sessions', owner.id, 'attachments')
    const destination = path.join(directory, storedFilename)
    const storedRelativePath = path.relative(this.store.paths.workstackPath, destination).split(path.sep).join('/')
    mkdirSync(directory, { recursive: true })
    input.write(destination)
    const contents = readFileSync(destination)
    const attachment: Attachment = {
      id,
      workItemId: owner.kind === 'work_item' ? owner.id : null,
      planningSessionId: owner.kind === 'planning_session' ? owner.id : null,
      originalFilename,
      storedRelativePath,
      mimeType: input.mimeType,
      sizeBytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
      createdAt: new Date().toISOString()
    }

    this.store.database
      .prepare(
        `INSERT INTO attachments (
          id, work_item_id, planning_session_id, original_filename, stored_relative_path, mime_type, size_bytes, sha256, created_at
        ) VALUES (@id, @workItemId, @planningSessionId, @originalFilename, @storedRelativePath, @mimeType, @sizeBytes, @sha256, @createdAt)`
      )
      .run(attachment)
    return attachment
  }

  private resolveAttachmentPath(attachment: Attachment): string {
    const candidate = path.resolve(this.store.paths.workstackPath, attachment.storedRelativePath)
    const artifactRoot = path.resolve(this.store.paths.workstackPath)
    if (!candidate.startsWith(`${artifactRoot}${path.sep}`)) {
      throw new WorkstackError('ATTACHMENT_NOT_FOUND', 'The attachment path is outside the Workstack artifact store.')
    }
    return candidate
  }

  private requirePlanningSession(sessionId: string): void {
    const session = this.store.database
      .prepare('SELECT id FROM planning_sessions WHERE id = ? AND project_id = ?')
      .get(sessionId, this.store.project.id)
    if (!session) {
      throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The requested planning session does not exist.')
    }
  }
}

function appendMarkdown(description: string, markdown: string): string {
  return description ? `${description}\n\n${markdown}` : markdown
}

function safeFilename(filename: string): string {
  const safe = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '')
  return safe || 'attachment'
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    planningSessionId: row.planning_session_id,
    originalFilename: row.original_filename,
    storedRelativePath: row.stored_relative_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at
  }
}

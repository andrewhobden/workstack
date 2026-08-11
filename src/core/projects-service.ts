import * as fs from 'node:fs/promises'
import path from 'node:path'
import { ProjectRegistry } from './project-registry'
import { ProjectStore } from './project-store'
import { WorkItemRepository } from './work-items'
import { ArtifactStore } from './artifact-store'
import { ClaimsRepository } from './claims'
import {
  KnowledgeRepository,
  type KnowledgeSource,
  type ProjectKnowledgeRetrieval,
  type WikiArticle
} from './knowledge'
import { PlanningRepository } from './planning'
import { WorkstackError } from './errors'
import type {
  CreateWorkItemInput,
  Attachment,
  BinaryAttachmentInput,
  BlockWorkItemInput,
  ClaimWorkItemInput,
  ClaimWorkItemResult,
  CompletionInput,
  CompletionRecord,
  ForceReleaseInput,
  FileAttachmentInput,
  InitializeProjectInput,
  ProjectMetadata,
  ProjectDeletionResult,
  ProjectRegistryRecord,
  ProjectSummary,
  PlanningProposal,
  PlanningContext,
  UpdateProjectInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemFilters,
  WorkClaim
} from './types'

interface CountRow {
  backlog_count: number
  in_progress_count: number
  completed_count: number
}

interface ProjectDeletionFileSystem {
  cp: typeof fs.cp
  lstat: typeof fs.lstat
  mkdir: typeof fs.mkdir
  rm: typeof fs.rm
}

const projectDeletionFileSystem: ProjectDeletionFileSystem = {
  cp: fs.cp,
  lstat: fs.lstat,
  mkdir: fs.mkdir,
  rm: fs.rm
}

export class ProjectsService {
  constructor(
    private readonly registry: ProjectRegistry,
    private readonly deletionBackupDirectory: string = registry.deletionBackupDirectory,
    private readonly deletionFileSystem: ProjectDeletionFileSystem = projectDeletionFileSystem
  ) {}

  async createProject(input: InitializeProjectInput): Promise<ProjectSummary> {
    const store = await ProjectStore.initialize(input)
    try {
      const record = await this.registry.register(store.project)
      return toProjectSummary(record, store)
    } finally {
      store.close()
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const records = await this.registry.list()
    const summaries: ProjectSummary[] = []

    for (const record of records) {
      const store = await this.openStore(record.id)
      try {
        summaries.push(toProjectSummary(record, store))
      } finally {
        store.close()
      }
    }

    return summaries
  }

  async resolveProjectReference(reference: string): Promise<string> {
    const normalized = reference.trim()
    if (!normalized) {
      throw new WorkstackError('VALIDATION_ERROR', 'Provide a Workstack project name.')
    }
    const projectById = await this.registry.find(normalized)
    if (projectById) {
      return projectById.id
    }
    const projects = (await this.registry.list()).filter((project) => project.name.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0)
    if (projects.length === 1) {
      return projects[0].id
    }
    if (projects.length > 1) {
      throw new WorkstackError('VALIDATION_ERROR', `More than one project is named "${normalized}". Rename one project before using MCP by name.`)
    }
    throw new WorkstackError('PROJECT_NOT_FOUND', `No Workstack project is named "${normalized}".`)
  }

  async getProject(id: string): Promise<ProjectMetadata> {
    return this.withStore(id, (store) => store.project)
  }

  async updateProject(id: string, updates: UpdateProjectInput): Promise<ProjectSummary> {
    return this.withStore(id, async (store) => {
      const project = await store.updateMetadata(updates)
      const record = await this.registry.register(project)
      return toProjectSummary(record, store)
    })
  }

  async detachProject(id: string): Promise<void> {
    const detached = await this.registry.detach(id)
    if (!detached) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
    }
  }

  async deleteProject(id: string): Promise<ProjectDeletionResult> {
    const record = await this.requireRecord(id)
    const paths = await deletionPaths(record.rootPath, this.deletionFileSystem)
    const store = await ProjectStore.open(paths.rootPath)
    try {
      if (store.project.id !== record.id || path.resolve(store.project.rootPath) !== paths.rootPath) {
        throw new WorkstackError('PROJECT_NOT_FOUND', 'The project registry points to a different project.')
      }
    } finally {
      store.close()
    }

    const backupPath = await this.backupProjectData(paths.workstackPath, record.id)
    try {
      await this.deletionFileSystem.rm(paths.workstackPath, { recursive: true, force: false })
    } catch {
      throw new WorkstackError(
        'INTERNAL_ERROR',
        `Project data could not be deleted. Your backup remains at ${backupPath}.`
      )
    }

    try {
      const deleted = await this.registry.remove(id)
      if (!deleted) {
        throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
      }
    } catch {
      try {
        await this.deletionFileSystem.cp(backupPath, paths.workstackPath, { recursive: true, force: false, errorOnExist: true })
      } catch {
        throw new WorkstackError(
          'INTERNAL_ERROR',
          `The project registry could not be removed. Restore the project data from ${backupPath}.`
        )
      }
      throw new WorkstackError(
        'INTERNAL_ERROR',
        `The project registry could not be removed. Project data was restored; the backup remains at ${backupPath}.`
      )
    }

    return { backupPath }
  }

  async createWorkItem(projectId: string, input: CreateWorkItemInput): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).create(input))
  }

  async listWorkItems(projectId: string, filters?: WorkItemFilters): Promise<WorkItem[]> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).list(filters))
  }

  async getWorkItem(projectId: string, workItemId: string): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).get(workItemId))
  }

  async listActivity(projectId: string): Promise<import('./types').ActivityEvent[]> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).listActivity())
  }

  async updateWorkItem(projectId: string, workItemId: string, patch: UpdateWorkItemInput): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).update(workItemId, patch))
  }

  async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
    await this.withStore(projectId, (store) => new WorkItemRepository(store).delete(workItemId))
  }

  async listActiveClaims(projectId: string): Promise<WorkClaim[]> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).listActive())
  }

  async getActiveClaim(projectId: string, workItemId: string): Promise<WorkClaim | undefined> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).getActive(workItemId))
  }

  async forceReleaseWorkItem(projectId: string, workItemId: string, input: ForceReleaseInput): Promise<WorkClaim> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).forceRelease(workItemId, input))
  }

  async claimWorkItem(projectId: string, workItemId: string, input: ClaimWorkItemInput): Promise<ClaimWorkItemResult> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).claim(workItemId, input))
  }

  async heartbeatWorkItem(projectId: string, workItemId: string, claimToken: string): Promise<WorkClaim> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).heartbeat(workItemId, claimToken))
  }

  async releaseWorkItem(projectId: string, workItemId: string, claimToken: string, reason?: string): Promise<WorkClaim> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).release(workItemId, claimToken, reason))
  }

  async blockWorkItem(
    projectId: string,
    workItemId: string,
    claimToken: string,
    input: BlockWorkItemInput
  ): Promise<WorkClaim> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).block(workItemId, claimToken, input))
  }

  async completeWorkItem(
    projectId: string,
    workItemId: string,
    claimToken: string,
    input: CompletionInput
  ): Promise<CompletionRecord> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).complete(workItemId, claimToken, input))
  }

  async getCompletion(projectId: string, workItemId: string): Promise<CompletionRecord | undefined> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).getCompletion(workItemId))
  }

  async addKnowledgeSource(
    projectId: string,
    input: { displayName: string; filename: string; content: string }
  ): Promise<KnowledgeSource> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).addManualSource(input))
  }

  async listKnowledgeSources(projectId: string): Promise<KnowledgeSource[]> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).listSources())
  }

  async searchKnowledge(
    projectId: string,
    query: string
  ): Promise<Array<{ sourceId: string; title: string; excerpt: string; score: number }>> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).search(query))
  }

  async retrieveKnowledge(projectId: string, query: string, limit?: number): Promise<ProjectKnowledgeRetrieval> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).retrieve(query, limit))
  }

  async processKnowledgeJob(projectId: string): Promise<KnowledgeSource | undefined> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).processNextJob())
  }

  async retryKnowledgeJobs(projectId: string): Promise<number> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).retryFailedJobs())
  }

  async listWikiArticles(projectId: string): Promise<WikiArticle[]> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).listWikiArticles())
  }

  async saveWikiArticle(projectId: string, slug: string, content: string): Promise<WikiArticle> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).saveWikiArticle(slug, content))
  }

  async createPlanningSession(projectId: string): Promise<PlanningProposal> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).createSession())
  }

  async getPlanningProposal(projectId: string, sessionId: string): Promise<PlanningProposal> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).getProposal(sessionId))
  }

  async listPlanningMessages(projectId: string, sessionId: string): Promise<import('./types').PlanningMessage[]> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).listMessages(sessionId))
  }

  async addPlanningMessage(
    projectId: string,
    sessionId: string,
    role: import('./types').PlanningMessage['role'],
    contentMarkdown: string
  ): Promise<import('./types').PlanningMessage> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).addMessage(sessionId, role, contentMarkdown))
  }

  async updatePlanningProposal(
    projectId: string,
    sessionId: string,
    patch: Partial<Omit<PlanningProposal, 'planningSessionId' | 'userModifiedFields' | 'revision' | 'updatedAt'>>
  ): Promise<PlanningProposal> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).updateProposal(sessionId, patch))
  }

  async convertPlanningProposal(projectId: string, sessionId: string): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).convertToWorkItem(sessionId))
  }

  async getPlanningContext(projectId: string, sessionId: string, query: string): Promise<PlanningContext> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).assembleContext(sessionId, query))
  }

  async listPlanningAttachments(projectId: string, sessionId: string): Promise<Attachment[]> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).listPlanning(sessionId))
  }

  async attachPlanningBytes(projectId: string, sessionId: string, input: BinaryAttachmentInput): Promise<Attachment> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).attachPlanningBytes(sessionId, input))
  }

  async pastePlanningImage(projectId: string, sessionId: string, input: BinaryAttachmentInput): Promise<Attachment> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).pastePlanningImage(sessionId, input))
  }

  async readPlanningAttachment(projectId: string, sessionId: string, attachmentId: string): Promise<{ attachment: Attachment; data: Buffer }> {
    return this.withStore(projectId, (store) => {
      const artifacts = new ArtifactStore(store)
      return {
        attachment: artifacts.getPlanning(sessionId, attachmentId),
        data: artifacts.readPlanning(sessionId, attachmentId)
      }
    })
  }

  async removePlanningAttachment(projectId: string, sessionId: string, attachmentId: string): Promise<void> {
    await this.withStore(projectId, (store) => new ArtifactStore(store).removePlanning(sessionId, attachmentId))
  }

  async listAttachments(projectId: string, workItemId: string): Promise<Attachment[]> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).list(workItemId))
  }

  async attachFile(projectId: string, workItemId: string, input: FileAttachmentInput): Promise<Attachment> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).attachFile(workItemId, input))
  }

  async attachBytes(projectId: string, workItemId: string, input: BinaryAttachmentInput): Promise<Attachment> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).attachBytes(workItemId, input))
  }

  async pasteImage(projectId: string, workItemId: string, input: BinaryAttachmentInput): Promise<Attachment> {
    return this.withStore(projectId, (store) => new ArtifactStore(store).pasteImage(workItemId, input))
  }

  async readAttachment(projectId: string, workItemId: string, attachmentId: string): Promise<{ attachment: Attachment; data: Buffer }> {
    return this.withStore(projectId, (store) => {
      const artifacts = new ArtifactStore(store)
      return {
        attachment: artifacts.get(workItemId, attachmentId),
        data: artifacts.read(workItemId, attachmentId)
      }
    })
  }

  async removeAttachment(projectId: string, workItemId: string, attachmentId: string): Promise<void> {
    await this.withStore(projectId, (store) => new ArtifactStore(store).remove(workItemId, attachmentId))
  }

  async verifyProjectRoot(id: string): Promise<string> {
    const record = await this.requireRecord(id)
    await fs.stat(record.rootPath)
    return record.rootPath
  }

  private async withStore<T>(id: string, operation: (store: ProjectStore) => T | Promise<T>): Promise<T> {
    const store = await this.openStore(id)
    try {
      return await operation(store)
    } finally {
      store.close()
    }
  }

  private async openStore(id: string): Promise<ProjectStore> {
    const record = await this.requireRecord(id)
    const store = await ProjectStore.open(record.rootPath)
    if (store.project.id !== record.id) {
      store.close()
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The project registry points to a different project.')
    }
    return store
  }

  private async requireRecord(id: string) {
    const record = await this.registry.find(id)
    if (!record) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
    }
    return record
  }

  private async backupProjectData(workstackPath: string, projectId: string): Promise<string> {
    const backupBase = path.resolve(this.deletionBackupDirectory)
    const backupDirectory = path.resolve(
      backupBase,
      `${projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )

    try {
      await this.deletionFileSystem.mkdir(backupBase, { recursive: true })
      await this.deletionFileSystem.mkdir(backupDirectory)
      const backupPath = path.join(backupDirectory, '.workstack')
      await this.deletionFileSystem.cp(workstackPath, backupPath, { recursive: true, force: false, errorOnExist: true })
      const backupStore = await ProjectStore.open(backupDirectory)
      backupStore.close()
      return backupPath
    } catch {
      await this.deletionFileSystem.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw new WorkstackError('INTERNAL_ERROR', 'Project deletion was cancelled because the backup could not be completed.')
    }
  }
}

async function deletionPaths(
  rootPath: string,
  fileSystem: Pick<ProjectDeletionFileSystem, 'lstat'>
): Promise<{ rootPath: string; workstackPath: string }> {
  if (!path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath) {
    throw new WorkstackError('VALIDATION_ERROR', 'The registered project path is not safe to delete.')
  }

  const root = await fileSystem.lstat(rootPath)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new WorkstackError('VALIDATION_ERROR', 'The registered project folder is not safe to delete.')
  }

  const workstackPath = path.resolve(rootPath, '.workstack')
  const workstack = await fileSystem.lstat(workstackPath)
  if (!workstack.isDirectory() || workstack.isSymbolicLink()) {
    throw new WorkstackError('VALIDATION_ERROR', 'The Workstack data path is not safe to delete.')
  }

  return { rootPath, workstackPath }
}
function toProjectSummary(record: ProjectRegistryRecord, store: ProjectStore): ProjectSummary {
  const counts = store.database
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END), 0) AS backlog_count,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
       FROM work_items`
    )
    .get() as CountRow

  return {
    ...record,
    backlogCount: counts.backlog_count,
    inProgressCount: counts.in_progress_count,
    completedCount: counts.completed_count
  }
}

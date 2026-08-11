import { stat } from 'node:fs/promises'
import { ProjectRegistry } from './project-registry'
import { ProjectStore } from './project-store'
import { WorkItemRepository } from './work-items'
import { ArtifactStore } from './artifact-store'
import { ClaimsRepository } from './claims'
import { KnowledgeRepository, type KnowledgeSource, type WikiArticle } from './knowledge'
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
  ProjectRegistryRecord,
  ProjectSummary,
  PlanningProposal,
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

export class ProjectsService {
  constructor(private readonly registry: ProjectRegistry) {}

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
    await stat(record.rootPath)
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

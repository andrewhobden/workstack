import { SemanticIndexRepository } from './semantic-index'
import { KnowledgeRetrievalService } from './knowledge-retrieval'
import { ContextFeedbackRepository } from './context-feedback'
import type { ContextFeedbackInput, ContextFeedbackTriage } from './context-feedback-contracts'
import { KnowledgeRecordsRepository } from './knowledge-records'
import type { KnowledgeRecordInput, KnowledgeRecordUpdate, KnowledgeRecordKind } from './knowledge-record-contracts'
import { ProjectDirectoryRepository, type DirectoryMergeInput, type DirectorySplitInput } from './project-directory'
import type { ProjectEntityInput, ProjectEntityUpdate } from './project-directory-contracts'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ProjectRegistry } from './project-registry'
import { ProjectStore } from './project-store'
import { ContextPacketRepository } from './context-packets'
import type { ContextApproval, ContextCategory, ContextPolicyInput, ContextPreferencesInput } from './context-packet-contracts'
import { WorkItemRepository } from './work-items'
import { ArtifactStore } from './artifact-store'
import { ClaimsRepository } from './claims'
import { TaskDependenciesRepository } from './task-dependencies'
import type { TaskCoordination, TaskDependenciesInput, TaskReadiness } from './task-dependency-contracts'
import { EvidenceGraphRepository } from './evidence-graph'
import type { GraphNeighborhood, GraphQuery } from './evidence-graph-contracts'
import {
  KnowledgeRepository,
  type KnowledgeSource,
  type ProjectKnowledgeRetrieval,
  type WikiArticle
} from './knowledge'
import { SourceCatalogRepository, type ProjectSource, type SourceDetail, type SourcePolicy, type SourcePassage, type SourceCitation, type SourceCitationRead, type SourceRevisionRead } from './source-catalog'
import type { KnowledgeIntakeJob } from './knowledge-jobs'
import { KnowledgeDeliveryOutbox, type KnowledgeDeliveryEvent } from './knowledge-delivery'
import { PlanningRepository } from './planning'
import { KnowledgeChatAgent, KnowledgeChatRepository, type AgentChatProvider } from './knowledge-chat'
import { WikiRevisionRepository, type WikiRevision, type WikiRevisionReview } from './wiki-revisions'
import { WikiAutomationRepository } from './wiki-automation'
import { WorkstackError } from './errors'
import { atomicWriteText, beginProjectDeletion } from './project-lifecycle'
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
  WorkClaim,
  WorkCheckpoint,
  WorkCheckpointInput,
  KnowledgeChatSession,
  KnowledgeChatMessage,
  KnowledgeChatToolCall,
  KnowledgeChatTurn,
  KnowledgeChatPendingAction,
  WikiAutomationJob,
  WikiAutomationJobReport
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
    private readonly deletionFileSystem: ProjectDeletionFileSystem = projectDeletionFileSystem,
    private readonly deletionDrainTimeoutMs = 5000
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
      let store: ProjectStore | undefined
      try {
        store = await ProjectStore.openReadOnly(record.rootPath)
        if (store.project.id !== record.id || path.resolve(store.project.rootPath) !== path.resolve(record.rootPath)) {
          throw new WorkstackError('VALIDATION_ERROR', 'The registered folder contains a different or relocated project. Reconnect its correct folder.')
        }
        summaries.push(toProjectSummary(record, store))
      } catch (error) {
        summaries.push(unavailableProjectSummary(record, error))
      } finally {
        store?.close()
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
      const record = await this.registry.refresh(project)
      return toProjectSummary(record, store)
    })
  }

  async detachProject(id: string): Promise<void> {
    const detached = await this.registry.detach(id)
    if (!detached) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
    }
  }

  async reconnectProject(id: string, rootPath: string): Promise<ProjectSummary> {
    await this.requireRecord(id)
    const candidate = await ProjectStore.openReadOnly(rootPath)
    try {
      if (candidate.project.id !== id) throw new WorkstackError('VALIDATION_ERROR', 'The selected folder belongs to a different project.')
    } finally { candidate.close() }
    const store = await ProjectStore.open(rootPath)
    try {
      if (store.project.id !== id) throw new WorkstackError('VALIDATION_ERROR', 'The selected folder belongs to a different project.')
      const project = await store.reconnectRoot()
      return toProjectSummary(await this.registry.refresh(project), store)
    } finally { store.close() }
  }

  /** Keep the complete launch or provider workflow admitted until all nested operations finish. */
  async withProjectOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.withStore(id, () => operation())
  }

  async deleteProject(id: string): Promise<ProjectDeletionResult> {
    const record = await this.requireRecord(id)
    const paths = await deletionPaths(record.rootPath, this.deletionFileSystem)
    // Check the exported identity before opening can repair a stale projection.
    const document = await ProjectStore.readMetadataDocument(paths.rootPath)
    if (document.id !== id || path.resolve(document.rootPath) !== paths.rootPath) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The project registry points to a different project.')
    }
    const barrier = await beginProjectDeletion(paths.rootPath, this.deletionDrainTimeoutMs)
    let outcome: 'active' | 'deleted' | 'recovery' = 'active'
    try {
      const store = await barrier.run(() => ProjectStore.open(paths.rootPath))
      let backupPath: string
      try {
        if (store.project.id !== id || path.resolve(store.project.rootPath) !== paths.rootPath) {
          throw new WorkstackError('PROJECT_NOT_FOUND', 'The project registry points to a different project.')
        }
        if (new ClaimsRepository(store).listActive().length) {
          throw new WorkstackError('STORE_BUSY', 'Stop or release active agents before deleting this project.')
        }
        backupPath = await this.backupProjectData(store)
      } finally { store.close() }
      // Recheck paths immediately before destruction and persist recovery information first.
      await deletionPaths(record.rootPath, this.deletionFileSystem)
      barrier.removing(backupPath)
      outcome = 'recovery'
      try {
        await this.deletionFileSystem.rm(paths.workstackPath, { recursive: true, force: false })
      } catch {
        // A failed rm may be partial. Only clear the barrier after validating remaining data.
        try {
          await verifySnapshotFiles(paths.workstackPath, backupPath, true)
          await barrier.run(() => verifyProjectSnapshot(paths.rootPath, id, false))
          outcome = 'active'
        } catch { /* recovery remains required */ }
        throw new WorkstackError('INTERNAL_ERROR', `Project data could not be deleted. Your backup remains at ${backupPath}.`)
      }
      try {
        if (!(await this.registry.remove(id))) throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
      } catch {
        try {
          await this.deletionFileSystem.cp(backupPath, paths.workstackPath, { recursive: true, force: false, errorOnExist: true })
          await verifySnapshotFiles(paths.workstackPath, backupPath)
          await barrier.run(() => verifyProjectSnapshot(paths.rootPath, id, false))
          outcome = 'active'
        } catch {
          throw new WorkstackError('INTERNAL_ERROR', `The project registry could not be removed. Restore the project data from ${backupPath}.`)
        }
        throw new WorkstackError('INTERNAL_ERROR', `The project registry could not be removed. Project data was restored; the backup remains at ${backupPath}.`)
      }
      outcome = 'deleted'
      return { backupPath }
    } finally { barrier.finish(outcome) }
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

  async resolveWorkItem(projectId: string, identifier: string): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new WorkItemRepository(store).resolve(identifier))
  }

  async saveCheckpoint(projectId: string, workItemId: string, claimToken: string, input: WorkCheckpointInput): Promise<WorkCheckpoint> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).saveCheckpoint(workItemId, claimToken, input))
  }

  async listCheckpoints(projectId: string, workItemId: string, limit?: number): Promise<WorkCheckpoint[]> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).listCheckpoints(workItemId, limit))
  }

  async listCompletionHistory(projectId: string, workItemId: string): Promise<CompletionRecord[]> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).listCompletionHistory(workItemId))
  }

  async recoverWorkItem(projectId: string, workItemId: string, input: ForceReleaseInput): Promise<WorkItem> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).recover(workItemId, input))
  }

  async reconcilePullRequestWorkItem(projectId: string, workItemId: string, prUrl: string, state: 'OPEN' | 'CLOSED' | 'MERGED'): Promise<CompletionRecord> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).reconcilePullRequest(workItemId, prUrl, state))
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

  async finalizeMergedPullRequestWorkItem(projectId: string, workItemId: string): Promise<CompletionRecord> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).finalizeMergedPullRequest(workItemId))
  }

  async reconcileSubmittedPullRequest(
    projectId: string,
    workItemId: string,
    input: { branch: string; prUrl: string; merged: boolean }
  ): Promise<CompletionRecord> {
    return this.withStore(projectId, (store) => {
      const claims = new ClaimsRepository(store)
      const workItem = new WorkItemRepository(store).get(workItemId)
      if (workItem.status !== 'backlog') {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'The work item is no longer in the backlog.')
      }
      const claim = claims.claim(workItemId, {
        agentId: 'workstack-pr-reconciler',
        agentDisplayName: 'Workstack PR reconciler'
      })
      const completion = claims.complete(workItemId, claim.claimToken, {
        summaryMarkdown: `A submitted pull request was found for this work item: ${input.prUrl}`,
        branch: input.branch,
        prUrl: input.prUrl
      })
      return input.merged ? claims.finalizeMergedPullRequest(workItemId) : completion
    })
  }

  async getCompletion(projectId: string, workItemId: string): Promise<CompletionRecord | undefined> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).getCompletion(workItemId))
  }

  async updateWorkerHandoff(
    projectId: string,
    workItemId: string,
    input: { sessionSummaryMarkdown: string }
  ): Promise<CompletionRecord> {
    return this.withStore(projectId, (store) => new ClaimsRepository(store).updateWorkerHandoff(workItemId, input))
  }

  async addKnowledgeSource(
    projectId: string,
    input: { displayName: string; filename: string; content: string }
  ): Promise<KnowledgeSource> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).addManualSource(input))
  }

  async getTaskCoordination(projectId: string, workItemId: string): Promise<TaskCoordination> {
    return this.withStore(projectId, (store) => new TaskDependenciesRepository(store).get(workItemId))
  }

  async queryEvidenceGraph(projectId: string, input: GraphQuery): Promise<GraphNeighborhood> {
    return this.withStore(projectId, (store) => new EvidenceGraphRepository(store).query(input))
  }

  async updateTaskCoordination(projectId: string, workItemId: string, input: TaskDependenciesInput): Promise<TaskCoordination> {
    return this.withStore(projectId, (store) => new TaskDependenciesRepository(store).update(workItemId, input))
  }

  async getTaskReadiness(projectId: string, workItemId: string): Promise<TaskReadiness> {
    return this.withStore(projectId, (store) => new TaskDependenciesRepository(store).readiness(workItemId))
  }

  async assertTaskReady(projectId: string, workItemId: string): Promise<void> {
    return this.withStore(projectId, (store) => new TaskDependenciesRepository(store).assertReady(workItemId))
  }

  async listProjectSources(projectId: string): Promise<ProjectSource[]> {
    return this.withStore(projectId, (store) => {
      const catalog = new SourceCatalogRepository(store)
      catalog.migrateLegacySources()
      return catalog.listSources()
    })
  }

  async getProjectSource(projectId: string, sourceId: string): Promise<SourceDetail> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).getDetail(sourceId))
  }

  async updateSourcePolicy(projectId: string, sourceId: string, policy: SourcePolicy, refreshSeconds?: number): Promise<ProjectSource> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).updatePolicy(sourceId, policy, refreshSeconds))
  }

  async retrySourceIntake(projectId: string, jobId: string): Promise<KnowledgeIntakeJob> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).retryJob(jobId))
  }

  async cancelSourceIntake(projectId: string, jobId: string): Promise<void> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).cancelJob(jobId))
  }

  async searchSourcePassages(projectId: string, query: string, options?: { limit?: number; maxChars?: number; workItemId?: string }): Promise<SourcePassage[]> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).search(query, options))
  }

  async readSourceCitation(projectId: string, citation: SourceCitation, options?: { neighbors?: number; maxChars?: number }): Promise<SourceCitationRead> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).readCitation(citation, options))
  }

  async readSourceRevision(projectId: string, sourceId: string, revisionId: string, options?: { representation?: 'original' | 'normalized'; offset?: number; limit?: number }): Promise<SourceRevisionRead> {
    return this.withStore(projectId, (store) => new SourceCatalogRepository(store).readRevision(sourceId, revisionId, options))
  }

  async listKnowledgeDeliveries(projectId: string): Promise<KnowledgeDeliveryEvent[]> {
    return this.withStore(projectId, (store) => new KnowledgeDeliveryOutbox(store).list())
  }

  async retryKnowledgeDelivery(projectId: string, deliveryId: number): Promise<KnowledgeDeliveryEvent> {
    return this.withStore(projectId, (store) => new KnowledgeDeliveryOutbox(store).retry(deliveryId))
  }

  async createContextFeedback(projectId: string, input: ContextFeedbackInput) { return this.withStore(projectId, (store) => new ContextFeedbackRepository(store).create(input)) }
  async getContextFeedback(projectId: string, id: string) { return this.withStore(projectId, (store) => new ContextFeedbackRepository(store).get(id)) }
  async listContextFeedback(projectId: string, options: Parameters<ContextFeedbackRepository['list']>[0] = {}) { return this.withStore(projectId, (store) => new ContextFeedbackRepository(store).list(options)) }
  async triageContextFeedback(projectId: string, id: string, input: ContextFeedbackTriage) { return this.withStore(projectId, (store) => new ContextFeedbackRepository(store).triage(id, input)) }
  async contextFeedbackHistory(projectId: string, id: string) { return this.withStore(projectId, (store) => new ContextFeedbackRepository(store).history(id)) }

  async listKnowledgeRecords(projectId: string, options: { kind?: KnowledgeRecordKind; includeHistorical?: boolean; limit?: number } = {}) {
    return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).list(options))
  }
  async getKnowledgeRecord(projectId: string, id: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).get(id)) }
  async createKnowledgeRecord(projectId: string, input: KnowledgeRecordInput, actor = 'local-user') { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).create(input, actor)) }
  async updateKnowledgeRecord(projectId: string, id: string, input: KnowledgeRecordUpdate, actor = 'local-user', reason = 'Updated record.') { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).update(id, input, actor, reason)) }
  async checkKnowledgeRecords(projectId: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).checks()) }
  async reviewKnowledgeRecord(projectId: string, id: string, input: Parameters<KnowledgeRecordsRepository['review']>[1]) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).review(id, input)) }
  async supersedeKnowledgeRecord(projectId: string, id: string, replacementId: string, actor: string, reason: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).supersede(id, replacementId, actor, reason)) }
  async knowledgeRecordHistory(projectId: string, id: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).history(id)) }
  async knowledgeRecordReviews(projectId: string, id: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).reviews(id)) }
  async searchKnowledgeRecords(projectId: string, query: string, options: { includeHistorical?: boolean; limit?: number } = {}) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).search(query, options)) }
  async readKnowledgeRecordMarkdown(projectId: string, id: string) { return this.withStore(projectId, (store) => new KnowledgeRecordsRepository(store).readMarkdown(id)) }

  async listProjectDirectory(projectId: string, options: Parameters<ProjectDirectoryRepository['list']>[0] = {}) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).list(options)) }
  async projectDirectoryDetail(projectId: string, id: string, options: Parameters<ProjectDirectoryRepository['detail']>[1] = {}) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).detail(id, options)) }
  async lookupProjectDirectory(projectId: string, query: string) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).lookup(query)) }
  async createProjectEntity(projectId: string, input: ProjectEntityInput, actor = 'local-user') { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).create(input, actor)) }
  async updateProjectEntity(projectId: string, id: string, input: ProjectEntityUpdate, actor = 'local-user', reason = 'Updated directory entry.') { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).update(id, input, actor, reason)) }
  async mergeProjectEntities(projectId: string, sourceId: string, targetId: string, input: DirectoryMergeInput) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).merge(sourceId, targetId, input)) }
  async splitProjectEntity(projectId: string, id: string, input: DirectorySplitInput) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).split(id, input)) }
  async retireProjectEntity(projectId: string, id: string, expectedVersion: number, actor: string, reason: string) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).retire(id, expectedVersion, actor, reason)) }
  async resolveProjectMention(projectId: string, mentionId: string, entityId: string | null, actor: string, reason: string) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).resolveMention(mentionId, entityId, actor, reason)) }
  async listProjectMentions(projectId: string, entityId?: string, options: Parameters<ProjectDirectoryRepository['mentions']>[1] = {}) { return this.withStore(projectId, (store) => new ProjectDirectoryRepository(store).mentions(entityId, options)) }

  async listKnowledgeSources(projectId: string): Promise<KnowledgeSource[]> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).listSources())
  }

  async searchKnowledge(
    projectId: string,
    query: string
  ): Promise<Array<{ sourceId: string; title: string; excerpt: string; score: number }>> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).search(query))
  }

  async semanticStatus(projectId: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).status()) }
  async configureSemanticModel(projectId: string, modelPath: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).configure(modelPath)) }
  async disableSemanticModel(projectId: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).disable()) }
  async rebuildSemanticIndex(projectId: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).reindex()) }
  async cancelSemanticJob(projectId: string, jobId: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).cancel(jobId)) }
  async retrySemanticJob(projectId: string, jobId: string) { return this.withStore(projectId, (store) => new SemanticIndexRepository(store).retry(jobId)) }
  async processSemanticJobs(projectId: string): Promise<void> {
    return this.withStore(projectId, async (store) => {
      const index = new SemanticIndexRepository(store)
      index.schedule()
      for (let count = 0; count < 100; count += 1) if (!await index.processNext()) break
    })
  }

  async retrieveKnowledge(projectId: string, query: string, limit?: number): Promise<ProjectKnowledgeRetrieval> {
    return this.withStore(projectId, (store) => new KnowledgeRetrievalService(store).retrieve(query, { limit }))
  }

  async processKnowledgeJob(projectId: string): Promise<KnowledgeSource | undefined> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).processNextJob())
  }

  async retryKnowledgeJobs(projectId: string): Promise<number> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).retryFailedJobs())
  }

  async listWikiRevisions(projectId: string): Promise<WikiRevision[]> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).list())
  }

  async reviewWikiRevision(projectId: string, revisionId: string): Promise<WikiRevisionReview> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).review(revisionId))
  }

  async publishWikiRevision(projectId: string, revisionId: string, actor: string, note?: string): Promise<WikiRevisionReview> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).publish(revisionId, actor, note))
  }

  async rejectWikiRevision(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevision> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).reject(revisionId, actor, reason))
  }

  async reconcileWikiRevision(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevisionReview> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).reconcile(revisionId, actor, reason))
  }

  async restoreWikiRevision(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevisionReview> {
    return this.withStore(projectId, (store) => new WikiRevisionRepository(store).restore(revisionId, actor, reason))
  }

  async listWikiArticles(projectId: string): Promise<WikiArticle[]> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).listWikiArticles())
  }

  async saveWikiArticle(projectId: string, slug: string, content: string): Promise<WikiArticle> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).saveWikiArticle(slug, content))
  }

  async saveGeneratedWikiArticle(projectId: string, slug: string, content: string): Promise<WikiArticle> {
    return this.withStore(projectId, (store) => new KnowledgeRepository(store).saveGeneratedWikiArticle(slug, content))
  }

  async listWikiAutomationReports(projectId: string): Promise<WikiAutomationJobReport[]> {
    return this.withStore(projectId, (store) => {
      const repository = new WikiAutomationRepository(store)
      return repository.listJobs().map((job) => repository.getJobReport(job.id))
    })
  }

  async retryWikiAutomationJob(projectId: string, jobId: string): Promise<WikiAutomationJob> {
    return this.withStore(projectId, (store) => new WikiAutomationRepository(store).retryJob(jobId))
  }

  async listKnowledgeChatSessions(projectId: string): Promise<KnowledgeChatSession[]> {
    return this.withStore(projectId, (store) => new KnowledgeChatRepository(store).listSessions())
  }

  async createKnowledgeChatSession(projectId: string): Promise<KnowledgeChatSession> {
    return this.withStore(projectId, (store) => new KnowledgeChatRepository(store).createSession())
  }

  async listKnowledgeChatMessages(projectId: string, sessionId: string): Promise<KnowledgeChatMessage[]> {
    return this.withStore(projectId, (store) => new KnowledgeChatRepository(store).listMessages(sessionId))
  }

  async listKnowledgeChatToolCalls(projectId: string, sessionId: string): Promise<KnowledgeChatToolCall[]> {
    return this.withStore(projectId, (store) => new KnowledgeChatRepository(store).listToolCalls(sessionId))
  }

  async sendKnowledgeChatMessage(
    projectId: string,
    sessionId: string,
    contentMarkdown: string,
    provider: AgentChatProvider,
    options?: { signal?: AbortSignal; requestId?: string }
  ): Promise<KnowledgeChatTurn> {
    return this.withStore(projectId, (store) => new KnowledgeChatAgent(store, provider).sendMessage(sessionId, contentMarkdown, options))
  }

  async listKnowledgeChatPendingActions(projectId: string, sessionId: string): Promise<KnowledgeChatPendingAction[]> {
    return this.withStore(projectId, (store) => new KnowledgeChatRepository(store).listPendingActions(sessionId))
  }

  async approveKnowledgeChatPendingAction(projectId: string, sessionId: string, actionId: string): Promise<KnowledgeChatTurn> {
    return this.withStore(projectId, (store) => {
      const repository = new KnowledgeChatRepository(store)
      repository.approvePendingAction(sessionId, actionId)
      return repository.turn(sessionId)
    })
  }

  async rejectKnowledgeChatPendingAction(projectId: string, sessionId: string, actionId: string): Promise<KnowledgeChatTurn> {
    return this.withStore(projectId, (store) => {
      const repository = new KnowledgeChatRepository(store)
      repository.rejectPendingAction(sessionId, actionId)
      return repository.turn(sessionId)
    })
  }

  async createPlanningSession(projectId: string): Promise<PlanningProposal> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).createSession())
  }

  async listPlanningSessions(projectId: string): Promise<PlanningProposal[]> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).listSessions())
  }

  async readPlanningContext(projectId: string, sessionId: string, contextId: string): Promise<PlanningContext> {
    return this.withStore(projectId, (store) => new PlanningRepository(store).getContext(sessionId, contextId))
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
    return this.withStore(projectId, async (store) => new PlanningRepository(store).assembleContext(sessionId, query, await new KnowledgeRetrievalService(store).retrieve(query.trim().slice(0, 500))))
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

  async getContextPolicy(projectId: string) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).getPolicy()) }
  async updateContextPolicy(projectId: string, input: ContextPolicyInput) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).updatePolicy(input)) }
  async getContextPreferences(projectId: string, workItemId: string) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).getPreferences(workItemId)) }
  async updateContextPreferences(projectId: string, workItemId: string, input: ContextPreferencesInput) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).updatePreferences(workItemId, input)) }
  async previewContextPacket(projectId: string, workItemId: string, approval: ContextApproval = {}) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).preview(workItemId, approval)) }
  async listContextPackets(projectId: string, workItemId: string) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).list(workItemId)) }
  async getContextPacket(projectId: string, packetId: string) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).get(packetId)) }
  async readContextSection(projectId: string, packetId: string, category: ContextCategory, offset = 0, limit = 12000) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).readSection(packetId, category, offset, limit)) }
  async readContextArtifact(projectId: string, packetId: string, artifactId: string, offset = 0, limit = 12000) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).readArtifact(packetId, artifactId, offset, limit)) }
  async listContextPacketUsage(projectId: string, packetId: string) { return this.withStore(projectId, (store) => new ContextPacketRepository(store).listUsage(packetId)) }

  private async withStore<T>(id: string, operation: (store: ProjectStore) => T | Promise<T>): Promise<T> {
    const store = await this.openStore(id)
    try {
      return await store.runInOperation(() => operation(store))
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

  private async backupProjectData(store: ProjectStore): Promise<string> {
    const workstackPath = store.paths.workstackPath
    const projectId = store.project.id
    const backupBase = path.resolve(this.deletionBackupDirectory)
    if (isWithin(workstackPath, backupBase)) throw new WorkstackError('VALIDATION_ERROR', 'The deletion backup must be stored outside the project data directory.')
    const backupDirectory = path.resolve(
      backupBase,
      `${projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    )

    try {
      await this.deletionFileSystem.mkdir(backupBase, { recursive: true })
      await this.deletionFileSystem.mkdir(backupDirectory)
      const backupPath = path.join(backupDirectory, '.workstack')
      const databaseFiles = new Set(['workstack.db', 'workstack.db-wal', 'workstack.db-shm', 'workstack.db-journal'].map((name) => path.join(workstackPath, name)))
      await this.deletionFileSystem.cp(workstackPath, backupPath, {
        recursive: true, force: false, errorOnExist: true,
        filter: (source) => !databaseFiles.has(source)
      })
      await store.database.backup(path.join(backupPath, 'workstack.db'))
      await verifyProjectSnapshot(backupDirectory, projectId)
      await writeSnapshotManifest(backupPath)
      return backupPath
    } catch (error) {
      await this.deletionFileSystem.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw new WorkstackError('INTERNAL_ERROR', `Project deletion was cancelled because the backup could not be completed. ${error instanceof Error ? error.message : String(error)}`)
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
    name: store.project.name,
    description: store.project.description,
    rootPath: store.project.rootPath,
    availability: 'available',
    backlogCount: counts.backlog_count,
    inProgressCount: counts.in_progress_count,
    completedCount: counts.completed_count
  }
}

function unavailableProjectSummary(record: ProjectRegistryRecord, error: unknown): ProjectSummary {
  const code = (error as NodeJS.ErrnoException).code
  const message = error instanceof Error ? error.message : String(error)
  const availability = code === 'PROJECT_DELETING' ? 'deleting'
    : code === 'EACCES' || code === 'EPERM' ? 'unreadable'
      : code === 'ENOENT' || (code === 'PROJECT_NOT_FOUND' && !/inconsistent|identit|different/.test(message)) ? 'missing'
        : 'invalid'
  return { ...record, availability, availabilityError: message, backlogCount: 0, inProgressCount: 0, completedCount: 0 }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function verifyProjectSnapshot(rootPath: string, projectId: string, readonly = true): Promise<void> {
  const store = await (readonly ? ProjectStore.openReadOnly(rootPath) : ProjectStore.open(rootPath))
  try {
    if (store.project.id !== projectId) throw new Error('Backup project identity does not match.')
    const integrity = store.database.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || (store.database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup database integrity check failed.')
    const attachments = store.database.prepare('SELECT stored_relative_path, size_bytes, sha256 FROM attachments').all() as Array<{ stored_relative_path: string; size_bytes: number; sha256: string | null }>
    for (const attachment of attachments) {
      const attachmentPath = path.resolve(store.paths.workstackPath, attachment.stored_relative_path)
      if (!isWithin(store.paths.workstackPath, attachmentPath) || path.isAbsolute(attachment.stored_relative_path)) throw new Error('Backup attachment path leaves the project data directory.')
      const realPath = await fs.realpath(attachmentPath)
      if (!isWithin(await fs.realpath(store.paths.workstackPath), realPath)) throw new Error('Backup attachment symlink leaves the project data directory.')
      const data = await fs.readFile(attachmentPath)
      if (data.byteLength !== attachment.size_bytes || (attachment.sha256 && createHash('sha256').update(data).digest('hex') !== attachment.sha256)) throw new Error('Backup attachment checksum does not match.')
    }
  } finally { store.close() }
}

interface SnapshotFile { path: string; size: number; sha256: string }
const snapshotManifestName = '.deletion-manifest.json'
const snapshotTransientFiles = new Set([snapshotManifestName, 'workstack.db-wal', 'workstack.db-shm', 'workstack.db-journal'])

async function snapshotFiles(directory: string, relative = ''): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = []
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const filename = path.join(relative, entry.name)
    if (!relative && snapshotTransientFiles.has(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error('Project deletion requires self-contained artifacts; replace symbolic links with files before retrying.')
    if (entry.isDirectory()) files.push(...await snapshotFiles(directory, filename))
    else if (entry.isFile()) {
      const data = await fs.readFile(path.join(directory, filename))
      files.push({ path: filename.split(path.sep).join('/'), size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
    } else throw new Error('Project backup contains an unsupported filesystem entry.')
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function writeSnapshotManifest(directory: string): Promise<void> {
  const files = await snapshotFiles(directory)
  // Flush copied artifacts as well as SQLite before publishing a recoverable backup.
  for (const file of files) {
    const handle = await fs.open(path.join(directory, file.path), 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  const directories = new Set([directory])
  for (const file of files) {
    let parent = path.dirname(path.join(directory, file.path))
    while (parent !== directory && isWithin(directory, parent)) { directories.add(parent); parent = path.dirname(parent) }
  }
  for (const directoryPath of [...directories].sort((left, right) => right.length - left.length)) {
    const handle = await fs.open(directoryPath, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  atomicWriteText(path.join(directory, snapshotManifestName), `${JSON.stringify({ version: 1, files }, null, 2)}\n`)
  for (const parent of [path.dirname(directory), path.dirname(path.dirname(directory))]) {
    const handle = await fs.open(parent, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
}

async function verifySnapshotFiles(directory: string, manifestDirectory: string, skipDatabase = false): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(manifestDirectory, snapshotManifestName), 'utf8')) as { version: number; files: SnapshotFile[] }
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unrecognized backup manifest.')
  const actual = await snapshotFiles(directory)
  const select = (files: SnapshotFile[]) => files.filter((file) => !skipDatabase || file.path !== 'workstack.db')
  if (JSON.stringify(select(actual)) !== JSON.stringify(select(manifest.files))) throw new Error('Project files do not match the validated backup manifest.')
}

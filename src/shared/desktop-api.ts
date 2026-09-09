import type { SemanticStatus } from '../core/semantic-index-contracts'
import type {
  Attachment,
  ActivityEvent,
  CompletionRecord,
  CreateWorkItemInput,
  ProjectDeletionResult,
  ForceReleaseInput,
  ProjectMetadata,
  ProjectSummary,
  UpdateProjectInput,
  UpdateWorkItemInput,
  PlanningProposal,
  PlanningMessage,
  PlanningContext,
  WorkItem,
  WorkItemFilters,
  WorkClaim,
  WorkCheckpoint,
  KnowledgeChatSession,
  KnowledgeChatMessage,
  KnowledgeChatToolCall,
  KnowledgeChatTurn,
  KnowledgeChatPendingAction
} from '../core/types'
import type { WikiAutomationJob, WikiAutomationJobReport } from '../core/types'
import type { SourceInventory, SourceImportSelection } from '../core/source-intake-types'
import type { ProjectSource, SourceDetail, SourcePolicy, SourcePassage, SourceCitation, SourceCitationRead, SourceRevisionRead } from '../core/source-catalog'
import type { KnowledgeIntakeJob } from '../core/knowledge-jobs'
import type { WikiRevision, WikiRevisionReview } from '../core/wiki-revisions'
import type { KnowledgeDeliveryEvent } from '../core/knowledge-delivery'
import type { AgentExecutionPreflight } from '../core/execution-profiles'
import type { TaskCoordination, TaskDependenciesInput } from '../core/task-dependency-contracts'
import type { KnowledgeSource, ProjectKnowledgeRetrieval, WikiArticle } from '../core/knowledge'
import type { KnowledgeFinding, KnowledgeRecord, KnowledgeRecordHistory, KnowledgeRecordInput, KnowledgeRecordUpdate, KnowledgeReview } from '../core/knowledge-record-contracts'
import type { DirectoryLookup, ProjectEntity, ProjectEntityDetail, ProjectEntityInput, ProjectEntityUpdate, ProjectMention } from '../core/project-directory-contracts'
import type { DirectoryMergeInput, DirectorySplitInput } from '../core/project-directory'
import type { ContextApproval, ContextCategory, ContextPacket, ContextPacketUsage, ContextPolicy, ContextPolicyInput, ContextPreferences, ContextPreferencesInput, ContextSectionRead } from '../core/context-packet-contracts'
import type { ContextFeedback, ContextFeedbackEvent, ContextFeedbackInput, ContextFeedbackTriage } from '../core/context-feedback-contracts'

export interface ProjectPullRequest {
  number: number
  title: string
  url: string
  headRefName: string
  isDraft: boolean
  authorLogin: string | null
  updatedAt: string
  workItem?: { displayId: string; title: string }
}

export interface CopilotLaunchResult {
  started: boolean
  pullRequestUrl?: string
  contextPacketId?: string
}

export interface DesktopApi {
  system: {
    appVersion(): Promise<string>
  }
  ai: {
    settings(): Promise<AiProviderSettings>
    configure(input: AiProviderConfiguration): Promise<AiProviderSettings>
    listModels(input: AiModelListInput): Promise<AiModel[]>
    propose(prompt: string, requestId?: string): Promise<string>
    proposePlanning(projectId: string, sessionId: string, prompt: string, contextId?: string, requestId?: string): Promise<string>
    cancel(requestId: string): Promise<boolean>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(input: CreateProjectInput): Promise<ProjectSummary>
    get(projectId: string): Promise<ProjectMetadata>
    update(projectId: string, updates: UpdateProjectInput): Promise<ProjectSummary>
    reconnect(projectId: string, rootPath: string): Promise<ProjectSummary>
    detach(projectId: string): Promise<void>
    delete(projectId: string, input: DeleteProjectInput): Promise<ProjectDeletionResult>
    chooseFolder(): Promise<string | undefined>
    openFolder(projectId: string): Promise<void>
  }
  workItems: {
    list(projectId: string, filters?: WorkItemFilters): Promise<WorkItem[]>
    create(projectId: string, input: CreateWorkItemInput): Promise<WorkItem>
    get(projectId: string, workItemId: string): Promise<WorkItem>
    update(projectId: string, workItemId: string, patch: UpdateWorkItemInput): Promise<WorkItem>
    delete(projectId: string, workItemId: string): Promise<void>
    preflight(projectId: string, workItemId: string): Promise<AgentExecutionPreflight>
    launchCopilot(projectId: string, workItemId: string, prompt: string, approval?: ContextApproval): Promise<CopilotLaunchResult>
    restack(projectId: string, workItemId: string): Promise<void>
    restart(projectId: string, workItemId: string, approval?: ContextApproval): Promise<{ contextPacketId?: string } | void>
    recover(projectId: string, workItemId: string, input: ForceReleaseInput): Promise<WorkItem>
    checkpoints(projectId: string, workItemId: string): Promise<WorkCheckpoint[]>
    completionHistory(projectId: string, workItemId: string): Promise<CompletionRecord[]>
  }
  activity: {
    list(projectId: string): Promise<ActivityEvent[]>
  }
  pullRequests: {
    list(projectId: string): Promise<ProjectPullRequest[]>
    open(url: string): Promise<void>
    merge(projectId: string, urls: string[]): Promise<void>
  }
  claims: {
    list(projectId: string): Promise<WorkClaim[]>
    get(projectId: string, workItemId: string): Promise<WorkClaim | undefined>
    forceRelease(projectId: string, workItemId: string, input: ForceReleaseInput): Promise<WorkClaim>
    getCompletion(projectId: string, workItemId: string): Promise<CompletionRecord | undefined>
    updateWorkerHandoff(projectId: string, workItemId: string, input: { sessionSummaryMarkdown: string }): Promise<CompletionRecord>
  }
  semantic: {
    status(projectId: string): Promise<SemanticStatus>
    chooseModel(projectId: string): Promise<SemanticStatus | undefined>
    disable(projectId: string): Promise<SemanticStatus>
    reindex(projectId: string): Promise<SemanticStatus>
    cancel(projectId: string, jobId: string): Promise<SemanticStatus>
    retry(projectId: string, jobId: string): Promise<SemanticStatus>
  }
  knowledge: {
    listSources(projectId: string): Promise<KnowledgeSource[]>
    addSource(projectId: string, input: KnowledgeSourceInput): Promise<KnowledgeSource>
    search(projectId: string, query: string): Promise<KnowledgeSearchResult[]>
    retrieve(projectId: string, query: string, limit?: number): Promise<ProjectKnowledgeRetrieval>
    processNext(projectId: string): Promise<KnowledgeSource | undefined>
    retryFailed(projectId: string): Promise<number>
    listWiki(projectId: string): Promise<WikiArticle[]>
    saveWiki(projectId: string, slug: string, content: string): Promise<WikiArticle>
  }
  taskDependencies: {
    get(projectId: string, workItemId: string): Promise<TaskCoordination>
    update(projectId: string, workItemId: string, input: TaskDependenciesInput): Promise<TaskCoordination>
  }
  sourceCatalog: {
    previewRepository(projectId: string): Promise<SourceInventory>
    importSelection(projectId: string, input: SourceImportSelection): Promise<KnowledgeIntakeJob[]>
    refresh(projectId: string, sourceId: string): Promise<KnowledgeIntakeJob>
    list(projectId: string): Promise<ProjectSource[]>
    detail(projectId: string, sourceId: string): Promise<SourceDetail>
    setPolicy(projectId: string, sourceId: string, policy: SourcePolicy, refreshSeconds?: number): Promise<ProjectSource>
    retry(projectId: string, jobId: string): Promise<KnowledgeIntakeJob>
    cancel(projectId: string, jobId: string): Promise<void>
    search(projectId: string, query: string): Promise<SourcePassage[]>
    readRevision(projectId: string, sourceId: string, revisionId: string, representation?: 'original' | 'normalized', offset?: number): Promise<SourceRevisionRead>
    readCitation(projectId: string, citation: SourceCitation, neighbors?: number): Promise<SourceCitationRead>
  }
  knowledgeRecords: {
    list(projectId: string): Promise<KnowledgeRecord[]>
    get(projectId: string, recordId: string): Promise<KnowledgeRecord>
    create(projectId: string, input: KnowledgeRecordInput, actor: string): Promise<KnowledgeRecord>
    update(projectId: string, recordId: string, input: KnowledgeRecordUpdate, actor: string, reason: string): Promise<KnowledgeRecord>
    checks(projectId: string): Promise<KnowledgeFinding[]>
    review(projectId: string, recordId: string, actor: string, note: string, outcome: KnowledgeReview['outcome'], expectedVersion?: number): Promise<KnowledgeReview>
    supersede(projectId: string, recordId: string, replacementId: string, actor: string, reason: string): Promise<KnowledgeRecord>
    history(projectId: string, recordId: string): Promise<KnowledgeRecordHistory[]>
    reviews(projectId: string, recordId: string): Promise<KnowledgeReview[]>
  }
  projectDirectory: {
    list(projectId: string): Promise<ProjectEntity[]>
    detail(projectId: string, entityId: string): Promise<ProjectEntityDetail>
    lookup(projectId: string, query: string): Promise<DirectoryLookup>
    create(projectId: string, input: ProjectEntityInput, actor: string): Promise<ProjectEntity>
    update(projectId: string, entityId: string, input: ProjectEntityUpdate, actor: string, reason: string): Promise<ProjectEntity>
    merge(projectId: string, sourceId: string, targetId: string, input: DirectoryMergeInput): Promise<ProjectEntityDetail>
    split(projectId: string, entityId: string, input: DirectorySplitInput): Promise<ProjectEntityDetail>
    resolveMention(projectId: string, mentionId: string, entityId: string | null, actor: string, reason: string): Promise<ProjectMention>
  }
  knowledgeDelivery: {
    list(projectId: string): Promise<KnowledgeDeliveryEvent[]>
    retry(projectId: string, deliveryId: number): Promise<KnowledgeDeliveryEvent>
  }
  contextPackets: {
    policy(projectId: string): Promise<ContextPolicy>
    updatePolicy(projectId: string, input: ContextPolicyInput): Promise<ContextPolicy>
    preferences(projectId: string, workItemId: string): Promise<ContextPreferences>
    updatePreferences(projectId: string, workItemId: string, input: ContextPreferencesInput): Promise<ContextPreferences>
    preview(projectId: string, workItemId: string, approval?: ContextApproval): Promise<ContextPacket>
    list(projectId: string, workItemId: string): Promise<Array<Pick<ContextPacket, 'id' | 'workItemId' | 'version' | 'createdAt' | 'readiness' | 'canExecute' | 'previousPacketId' | 'fingerprint'>>>
    get(projectId: string, packetId: string): Promise<ContextPacket>
    readSection(projectId: string, packetId: string, category: ContextCategory, offset?: number): Promise<ContextSectionRead>
    usage(projectId: string, packetId: string): Promise<ContextPacketUsage[]>
  }
  contextFeedback: {
    create(projectId: string, input: ContextFeedbackInput): Promise<ContextFeedback>
    list(projectId: string, options?: { workItemId?: string; packetId?: string; status?: ContextFeedback['status']; limit?: number }): Promise<ContextFeedback[]>
    triage(projectId: string, feedbackId: string, input: ContextFeedbackTriage): Promise<ContextFeedback>
    history(projectId: string, feedbackId: string): Promise<ContextFeedbackEvent[]>
  }
  wikiRevisions: {
    list(projectId: string): Promise<WikiRevision[]>
    review(projectId: string, revisionId: string): Promise<WikiRevisionReview>
    publish(projectId: string, revisionId: string, actor: string, note?: string): Promise<WikiRevisionReview>
    reject(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevision>
    reconcile(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevisionReview>
    restore(projectId: string, revisionId: string, actor: string, reason: string): Promise<WikiRevisionReview>
  }
  wikiAutomation: {
    listReports(projectId: string): Promise<WikiAutomationJobReport[]>
    rescan(projectId: string): Promise<WikiAutomationJob>
    retry(projectId: string, jobId: string): Promise<WikiAutomationJob>
  }
  knowledgeChat: {
    listSessions(projectId: string): Promise<KnowledgeChatSession[]>
    createSession(projectId: string): Promise<KnowledgeChatSession>
    listMessages(projectId: string, sessionId: string): Promise<KnowledgeChatMessage[]>
    listToolCalls(projectId: string, sessionId: string): Promise<KnowledgeChatToolCall[]>
    sendMessage(projectId: string, sessionId: string, contentMarkdown: string, requestId?: string): Promise<KnowledgeChatTurn>
    listPendingActions(projectId: string, sessionId: string): Promise<KnowledgeChatPendingAction[]>
    approvePendingAction(projectId: string, sessionId: string, actionId: string): Promise<KnowledgeChatTurn>
    rejectPendingAction(projectId: string, sessionId: string, actionId: string): Promise<KnowledgeChatTurn>
  }
  planning: {
    listSessions(projectId: string): Promise<PlanningProposal[]>
    create(projectId: string): Promise<PlanningProposal>
    get(projectId: string, sessionId: string): Promise<PlanningProposal>
    update(projectId: string, sessionId: string, patch: PlanningProposalPatch): Promise<PlanningProposal>
    convert(projectId: string, sessionId: string): Promise<WorkItem>
    listMessages(projectId: string, sessionId: string): Promise<PlanningMessage[]>
    addMessage(projectId: string, sessionId: string, role: PlanningMessage['role'], contentMarkdown: string): Promise<PlanningMessage>
    context(projectId: string, sessionId: string, query: string): Promise<PlanningContext>
    listAttachments(projectId: string, sessionId: string): Promise<Attachment[]>
    attachBytes(projectId: string, sessionId: string, input: BinaryAttachmentPayload): Promise<Attachment>
    pasteImage(projectId: string, sessionId: string, input: BinaryAttachmentPayload): Promise<Attachment>
    removeAttachment(projectId: string, sessionId: string, attachmentId: string): Promise<void>
    previewAttachmentUrl(projectId: string, sessionId: string, attachmentId: string): Promise<string>
  }
  attachments: {
    list(projectId: string, workItemId: string): Promise<Attachment[]>
    attachBytes(projectId: string, workItemId: string, input: BinaryAttachmentPayload): Promise<Attachment>
    pasteImage(projectId: string, workItemId: string, input: BinaryAttachmentPayload): Promise<Attachment>
    remove(projectId: string, workItemId: string, attachmentId: string): Promise<void>
    previewUrl(projectId: string, workItemId: string, attachmentId: string): Promise<string>
  }
}

export interface CreateProjectInput {
  rootPath: string
  name: string
  description?: string
  workItemPrefix?: string
}

export interface DeleteProjectInput {
  confirmed: true
}

export interface AiProviderSettings {
  baseUrl: string
  model: string
  apiMode: AiApiMode
  configured: boolean
}

export interface AiProviderConfiguration {
  removeApiKey?: boolean
  baseUrl: string
  model: string
  apiMode?: AiApiMode
  apiKey?: string
}

export type AiApiMode = 'chat_completions' | 'responses' | 'messages'

export interface AiModelListInput {
  apiMode?: AiApiMode
  baseUrl: string
  apiKey?: string
}

export interface AiModel {
  id: string
  label?: string
}

export interface BinaryAttachmentPayload {
  requestId?: string
  data: Uint8Array
  originalFilename: string
  mimeType?: string
}

export interface KnowledgeSourceInput {
  displayName: string
  filename: string
  content: string
}

export interface KnowledgeSearchResult {
  sourceId: string
  title: string
  excerpt: string
  score: number
}

export interface PlanningProposalPatch {
  title?: string
  type?: WorkItem['type']
  descriptionMarkdown?: string
  requirementsMarkdown?: string
  acceptanceCriteriaMarkdown?: string
  implementationContextMarkdown?: string
  relatedReferences?: string[]
  priority?: WorkItem['priority']
}

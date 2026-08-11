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
  WorkClaim
} from '../core/types'
import type { KnowledgeSource, ProjectKnowledgeRetrieval, WikiArticle } from '../core/knowledge'

export interface DesktopApi {
  system: {
    appVersion(): Promise<string>
  }
  ai: {
    settings(): Promise<AiProviderSettings>
    configure(input: AiProviderConfiguration): Promise<AiProviderSettings>
    propose(prompt: string): Promise<string>
    proposePlanning(projectId: string, sessionId: string, prompt: string): Promise<string>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(input: CreateProjectInput): Promise<ProjectSummary>
    get(projectId: string): Promise<ProjectMetadata>
    update(projectId: string, updates: UpdateProjectInput): Promise<ProjectSummary>
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
  }
  activity: {
    list(projectId: string): Promise<ActivityEvent[]>
  }
  claims: {
    list(projectId: string): Promise<WorkClaim[]>
    get(projectId: string, workItemId: string): Promise<WorkClaim | undefined>
    forceRelease(projectId: string, workItemId: string, input: ForceReleaseInput): Promise<WorkClaim>
    getCompletion(projectId: string, workItemId: string): Promise<CompletionRecord | undefined>
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
  planning: {
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
  configured: boolean
}

export interface AiProviderConfiguration {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface BinaryAttachmentPayload {
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

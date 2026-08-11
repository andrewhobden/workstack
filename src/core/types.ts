export const WORK_ITEM_TYPES = ['feature', 'bug', 'chore'] as const
export const WORK_ITEM_PRIORITIES = ['high', 'normal', 'low'] as const
export const WORK_ITEM_STATUSES = ['backlog', 'in_progress', 'completed'] as const
export const WORK_ITEM_SOURCES = ['manual', 'ai_plan', 'mcp'] as const
export const CLAIM_STATES = ['active', 'released', 'expired', 'completed'] as const

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number]
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number]
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number]
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number]
export type ClaimState = (typeof CLAIM_STATES)[number]

export interface ProjectSettings {
  workItemPrefix: string
  defaultLeaseSeconds: number
  heartbeatSeconds: number
  autoReleaseExpiredClaims: boolean
  autoUpdateKnowledgeOnCompletion: boolean
}

export interface ProjectMetadata {
  id: string
  name: string
  description: string
  rootPath: string
  settings: ProjectSettings
  createdAt: string
  updatedAt: string
}

export interface ProjectRegistryRecord {
  id: string
  name: string
  description: string
  rootPath: string
  lastOpenedAt: string
}

export interface ProjectSummary extends ProjectRegistryRecord {
  backlogCount: number
  inProgressCount: number
  completedCount: number
}

export interface ProjectDeletionResult {
  backupPath: string
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  settings?: Partial<Omit<ProjectSettings, 'workItemPrefix'>>
}

export interface InitializeProjectInput {
  rootPath: string
  name: string
  description?: string
  workItemPrefix?: string
}

export interface WorkItem {
  id: string
  sequenceNumber: number
  displayId: string
  type: WorkItemType
  title: string
  descriptionMarkdown: string
  acceptanceCriteriaMarkdown: string
  priority: WorkItemPriority
  status: WorkItemStatus
  source: WorkItemSource
  createdBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface WorkClaim {
  id: string
  workItemId: string
  agentId: string
  agentDisplayName: string | null
  sessionId: string | null
  claimedAt: string
  lastHeartbeatAt: string
  leaseExpiresAt: string
  state: ClaimState
  releaseReason: string | null
  blockedReason: string | null
  releasedAt: string | null
  completedAt: string | null
}

export interface ClaimWorkItemInput {
  agentId: string
  agentDisplayName?: string
  sessionId?: string
  requestedLeaseSeconds?: number
}

export interface ClaimWorkItemResult {
  workItemId: string
  claimToken: string
  leaseExpiresAt: string
  recommendedHeartbeatSeconds: number
  claim: WorkClaim
}

export interface BlockWorkItemInput {
  reason: string
  retainClaim?: boolean
}

export interface ForceReleaseInput {
  actorId?: string
  reason: string
}

export interface CompletionInput {
  summaryMarkdown: string
  implementationNotesMarkdown?: string
  validationMarkdown?: string
  knownLimitationsMarkdown?: string
  filesChanged?: string[]
  componentsChanged?: string[]
  commitSha?: string
  branch?: string
  prUrl?: string | null
}

export interface CompletionRecord {
  workItemId: string
  summaryMarkdown: string
  implementationNotesMarkdown: string
  validationMarkdown: string
  knownLimitationsMarkdown: string
  filesChanged: string[]
  componentsChanged: string[]
  commitSha: string | null
  branch: string | null
  prUrl: string | null
  completedByAgentId: string | null
  completedBySessionId: string | null
  createdAt: string
}

export interface PlanningProposal {
  planningSessionId: string
  title: string
  type: WorkItemType
  descriptionMarkdown: string
  requirementsMarkdown: string
  acceptanceCriteriaMarkdown: string
  implementationContextMarkdown: string
  relatedReferences: string[]
  priority: WorkItemPriority
  userModifiedFields: string[]
  revision: number
  updatedAt: string
}

export interface PlanningMessage {
  id: string
  planningSessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  contentMarkdown: string
  createdAt: string
}

export type ClaimHealth = 'healthy' | 'attention'

export interface CreateWorkItemInput {
  type?: WorkItemType
  title: string
  descriptionMarkdown?: string
  acceptanceCriteriaMarkdown?: string
  priority?: WorkItemPriority
  source?: WorkItemSource
  createdBy?: string
}

export interface UpdateWorkItemInput {
  type?: WorkItemType
  title?: string
  descriptionMarkdown?: string
  acceptanceCriteriaMarkdown?: string
  priority?: WorkItemPriority
}

export interface WorkItemFilters {
  status?: WorkItemStatus
  type?: WorkItemType
  priority?: WorkItemPriority
  source?: WorkItemSource
  query?: string
  limit?: number
}

export interface ActivityEvent {
  id: string
  eventType: string
  actorType: 'human' | 'agent' | 'system'
  actorId: string | null
  workItemId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface Attachment {
  id: string
  workItemId: string | null
  planningSessionId: string | null
  originalFilename: string
  storedRelativePath: string
  mimeType: string | null
  sizeBytes: number
  sha256: string | null
  createdAt: string
}

export interface FileAttachmentInput {
  sourcePath: string
  originalFilename?: string
  mimeType?: string
}

export interface BinaryAttachmentInput {
  data: Buffer
  originalFilename: string
  mimeType?: string
}

export interface PastedImageInput {
  data: Buffer
  originalFilename?: string
  mimeType?: string
}

export interface PlanningContextEvidence {
  kind: 'project' | 'knowledge' | 'completed_work' | 'backlog_overlap' | 'planning_attachment'
  sourceId: string
  title: string
  excerpt: string
  metadata?: Record<string, string | number | null>
}

export interface PlanningContext {
  project: Pick<ProjectMetadata, 'id' | 'name' | 'description' | 'rootPath'>
  proposal: PlanningProposal
  knowledge: PlanningContextEvidence[]
  completedWork: PlanningContextEvidence[]
  backlogOverlap: PlanningContextEvidence[]
  planningAttachments: PlanningContextEvidence[]
}

export interface WorkstackPaths {
  rootPath: string
  workstackPath: string
  databasePath: string
  projectPath: string
  knowledgePath: string
  wikiPath: string
  rawKnowledgePath: string
  workItemsPath: string
  logsPath: string
}

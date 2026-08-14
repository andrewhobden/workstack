export const WORK_ITEM_TYPES = ['feature', 'bug', 'chore'] as const
export const WORK_ITEM_PRIORITIES = ['high', 'normal', 'low'] as const
export const WORK_ITEM_STATUSES = ['backlog', 'in_progress', 'completed'] as const
export const WORK_ITEM_SOURCES = ['manual', 'ai_plan', 'mcp'] as const
export const CLAIM_STATES = ['active', 'released', 'expired', 'completed'] as const
export const WIKI_AUTOMATION_JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const
export const WIKI_AUTOMATION_ARTIFACT_KINDS = ['dependency_graph', 'wiki_draft', 'wiki_article'] as const
export const WIKI_AUTOMATION_HANDOFF_STATUSES = ['pending', 'accepted', 'rejected'] as const

export const LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT = `Get the details of the feature/bug from workstack and claim it as active work.
When implementing the new work, create a new branch to work in using the form 'anhobden/{feature name}'.
Before doing any work on the item, in addition to the details of the feature/bug, you can do searches of the knowledge with workstack_search_completed and workstack_search_knowledge to get more context about the application.
If working on a bug, you should first implement one or more unit/UX tests to reproduce the issue. Then you should resolve the problem. Keep iterating on the problem until all the initial tests are green.
If working on a feature, before you work on the feature, you should perform some planning to break the task down into small tasks that can each be individually tested. All components should be built in a way that makes it suitable for both unit testing and UX testing with Playwright, everything you write or update MUST BE TESTED! Build the tests in parallel with writing the code. For all code with a UX component, after completion of a feature, perform a visual inspection of the running UX. Send a screenshot of the Playwright test to a multi-modal LLM to analyze and look for cut off/overlapped/clipped regions and other visual anomalies.
Keep working until all tests are green and you have code that you are proud of. Use /review or /security-review before merging when appropriate. When you have finished the implementation and everything is green, create a PR request for the work and use workstack_complete_work_item to mark the work item as complete.
If in the course of this work you discover a bug in another part of the codebase but it doesn't block your work, use workstack_create_bug to create a bug that another agent can work on.

If the feature being asked to work on is huge then it is ok that instead of working on implementation you instead work on architectural design, break down the project into phases, with each phase having a list of feature work. Use workstack_create_feature to add workitems for all the individual tasks.`

export const DEFAULT_COPILOT_LAUNCH_PROMPT = `Get the details of the feature/bug from workstack and claim it as active work.
Workstack has already created an isolated Git worktree and branch in the form 'anhobden/{feature name}' for this work item. Work only in the current worktree; do not create or check out another branch.
Before doing any work on the item, in addition to the details of the feature/bug, you can do searches of the knowledge with workstack_search_completed and workstack_search_knowledge to get more context about the application.
If working on a bug, you should first implement one or more unit/UX tests to reproduce the issue. Then you should resolve the problem. Keep iterating on the problem until all the initial tests are green.
If working on a feature, before you work on the feature, you should perform some planning to break the task down into small tasks that can each be individually tested. All components should be built in a way that makes it suitable for both unit testing and UX testing with Playwright, everything you write or update MUST BE TESTED! Build the tests in parallel with writing the code. For all code with a UX component, after completion of a feature, perform a visual inspection of the running UX. Send a screenshot of the Playwright test to a multi-modal LLM to analyze and look for cut off/overlapped/clipped regions and other visual anomalies.
Keep working until all tests are green and you have code that you are proud of. Use /review or /security-review before merging when appropriate. When you have finished the implementation and everything is green, create a PR request for the work and use workstack_complete_work_item to mark the work item as complete.
If in the course of this work you discover a bug in another part of the codebase but it doesn't block your work, use workstack_create_bug to create a bug that another agent can work on.

If the feature being asked to work on is huge then it is ok that instead of working on implementation you instead work on architectural design, break down the project into phases, with each phase having a list of feature work. Use workstack_create_feature to add workitems for all the individual tasks.`

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number]
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number]
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number]
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number]
export type ClaimState = (typeof CLAIM_STATES)[number]
export type WikiAutomationJobStatus = (typeof WIKI_AUTOMATION_JOB_STATUSES)[number]
export type WikiAutomationArtifactKind = (typeof WIKI_AUTOMATION_ARTIFACT_KINDS)[number]
export type WikiAutomationHandoffStatus = (typeof WIKI_AUTOMATION_HANDOFF_STATUSES)[number]

export interface ProjectSettings {
  workItemPrefix: string
  defaultLeaseSeconds: number
  heartbeatSeconds: number
  autoReleaseExpiredClaims: boolean
  autoUpdateKnowledgeOnCompletion: boolean
  copilotLaunchPrompt: string
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
  sessionSummaryMarkdown?: string
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
  sessionSummaryMarkdown: string
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

export interface WikiGenerationJobInput {
  title: string
  promptMarkdown: string
  sourcePaths?: string[]
  requestedBy?: string
}

export interface MergedPullRequestEvidenceInput {
  pullRequestUrl: string
  pullRequestNumber: number
  pullRequestTitle: string
  headRefName: string
  mergedAt?: string | null
  mergeCommitSha: string
  workItemId: string
  sessionSummaryMarkdown?: string
  diffMarkdown: string
}

export interface CreateMergedPullRequestJobInput extends WikiGenerationJobInput {
  mergeEvidence: MergedPullRequestEvidenceInput
}

export interface WikiAutomationJob {
  id: string
  title: string
  promptMarkdown: string
  sourcePaths: string[]
  requestedBy: string | null
  status: WikiAutomationJobStatus
  errorMessage: string | null
  mergeKey: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface WikiAutomationMergeEvidence {
  jobId: string
  pullRequestUrl: string
  pullRequestNumber: number
  pullRequestTitle: string
  headRefName: string
  mergedAt: string | null
  mergeCommitSha: string
  workItemId: string
  sessionSummaryMarkdown: string
  diffMarkdown: string
  createdAt: string
}

export interface CreateWikiAutomationArtifactInput {
  kind: WikiAutomationArtifactKind
  title: string
  contentMarkdown: string
  relativePath?: string
  metadata?: Record<string, unknown>
}

export interface WikiAutomationArtifact {
  id: string
  jobId: string
  kind: WikiAutomationArtifactKind
  title: string
  contentMarkdown: string
  relativePath: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface CreateWikiAutomationHandoffInput {
  target: string
  summaryMarkdown: string
  payload?: Record<string, unknown>
}

export interface WikiAutomationHandoff {
  id: string
  jobId: string
  target: string
  summaryMarkdown: string
  payload: Record<string, unknown>
  status: WikiAutomationHandoffStatus
  createdAt: string
  resolvedAt: string | null
}

export interface WikiAutomationJobReport {
  job: WikiAutomationJob
  mergeEvidence?: WikiAutomationMergeEvidence
  artifacts: WikiAutomationArtifact[]
  handoffs: WikiAutomationHandoff[]
}

export interface LocalDependencyGraphInput {
  entryPaths?: string[]
  maxFiles?: number
  maxEdges?: number
  maxFileBytes?: number
}

export interface LocalDependencyGraphNode {
  path: string
}

export interface LocalDependencyGraphEdge {
  from: string
  to: string
}

export interface LocalDependencyGraph {
  nodes: LocalDependencyGraphNode[]
  edges: LocalDependencyGraphEdge[]
  truncated: boolean
}

export interface LocalDependencyGraphDelta {
  addedNodes: LocalDependencyGraphNode[]
  removedNodes: LocalDependencyGraphNode[]
  addedEdges: LocalDependencyGraphEdge[]
  removedEdges: LocalDependencyGraphEdge[]
  truncated: boolean
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

export interface KnowledgeChatSession {
  id: string
  projectId: string
  title: string
  status: 'open' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface KnowledgeChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  contentMarkdown: string
  toolCallId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface KnowledgeChatToolCall {
  id: string
  sessionId: string
  toolName: string
  arguments: Record<string, unknown>
  result: Record<string, unknown> | null
  status: 'pending' | 'completed' | 'failed'
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

export interface KnowledgeChatPendingAction {
  id: string
  sessionId: string
  kind: 'create_work_item'
  payload: CreateWorkItemInput
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  resolvedAt: string | null
}

export interface KnowledgeChatTurn {
  session: KnowledgeChatSession
  messages: KnowledgeChatMessage[]
  toolCalls: KnowledgeChatToolCall[]
  pendingActions: KnowledgeChatPendingAction[]
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

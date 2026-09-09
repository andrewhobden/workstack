import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import {
  binaryAttachmentInputSchema,
  createProjectInputSchema,
  deleteProjectInputSchema,
  createWorkItemInputSchema,
  forceReleaseWorkItemInputSchema,
  launchCopilotInputSchema,
  knowledgeChatMessageInputSchema,
  knowledgeChatPendingActionReferenceSchema,
  knowledgeChatSessionReferenceSchema,
  knowledgeRetrievalInputSchema,
  knowledgeSourceInputSchema,
  sourceIdSchema,
  sourcePolicySchema,
  sourceCitationSchema,
  planningProposalInputSchema,
  planningAttachmentInputSchema,
  planningSessionReferenceSchema,
  projectIdSchema,
  updateProjectInputSchema,
  updateWorkItemInputSchema,
  updateWorkerHandoffInputSchema,
  wikiAutomationRescanInputSchema,
  wikiAutomationJobReferenceSchema,
  workItemFiltersSchema,
  workItemReferenceSchema
} from '../contracts/desktop'
import { WorkstackError } from '../core/errors'
import { taskDependenciesInputSchema } from '../core/task-dependency-contracts'
import { knowledgeRecordInputSchema } from '../core/knowledge-record-contracts'
import { projectEntityInputSchema } from '../core/project-directory-contracts'
import { contextApprovalSchema, contextCategories, contextPolicyInputSchema, contextPreferencesInputSchema } from '../core/context-packet-contracts'
import { contextFeedbackInputSchema, contextFeedbackTriageSchema } from '../core/context-feedback-contracts'
import { ProjectsService } from '../core/projects-service'
import { OpenAiCompatibleProvider } from './ai-provider'
import { SourceIntakeService } from './source-intake-service'
import { CopilotLauncher } from './copilot-launcher'
import { PullRequestService } from './pull-requests'
import type { WikiAutomationService } from './wiki-automation-service'

export function registerIpcHandlers(
  projects: ProjectsService,
  ai: OpenAiCompatibleProvider,
  copilot: CopilotLauncher,
  pullRequests: PullRequestService,
  wikiAutomation: WikiAutomationService
): void {
  const sourceIntake = new SourceIntakeService(projects)
  const activeRequests = new Map<string, AbortController>()
  async function runAiRequest<T>(requestId: unknown, operation: (options: { requestId?: string; signal: AbortSignal }) => Promise<T>): Promise<T> {
    const id = z.string().uuid().optional().parse(requestId)
    if (id && activeRequests.has(id)) throw new WorkstackError('VALIDATION_ERROR', 'This AI request is already running.')
    const controller = new AbortController()
    if (id) activeRequests.set(id, controller)
    try { return await operation({ requestId: id, signal: controller.signal }) }
    finally { if (id) activeRequests.delete(id) }
  }
  ipcMain.handle('ai:cancel', (_event, requestId) => {
    const id = z.string().uuid().parse(requestId)
    const controller = activeRequests.get(id)
    controller?.abort()
    return ai.cancelRequest(id) || Boolean(controller)
  })
  ipcMain.handle('system:app-version', () => process.env.npm_package_version ?? '0.1.0')
  ipcMain.handle('projects:list', () => projects.listProjects())
  ipcMain.handle('projects:create', (_event, input) => projects.createProject(createProjectInputSchema.parse(input)))
  ipcMain.handle('projects:get', (_event, projectId) => projects.getProject(projectIdSchema.parse(projectId)))
  ipcMain.handle('projects:update', async (_event, input) => {
    const parsed = updateProjectInputSchema.parse(input)
    return projects.updateProject(parsed.projectId, {
      name: parsed.name,
      description: parsed.description,
      settings: parsed.settings
    })
  })
  ipcMain.handle('projects:reconnect', (_event, projectId, rootPath) => projects.reconnectProject(projectIdSchema.parse(projectId), z.string().trim().min(1).parse(rootPath)))
  ipcMain.handle('projects:detach', async (_event, projectId) => {
    await projects.detachProject(projectIdSchema.parse(projectId))
  })
  ipcMain.handle('projects:delete', (_event, input) => {
    const parsed = deleteProjectInputSchema.parse(input)
    return projects.deleteProject(parsed.projectId)
  })
  ipcMain.handle('projects:choose-folder', async (event) => {
    const options: OpenDialogOptions = {
      title: 'Choose Project Folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('projects:open-folder', async (_event, projectId) => {
    const rootPath = await projects.verifyProjectRoot(projectIdSchema.parse(projectId))
    const result = await shell.openPath(rootPath)
    if (result) {
      throw new WorkstackError('INTERNAL_ERROR', `Unable to open the project folder: ${result}`)
    }
  })

  ipcMain.handle('work-items:list', (_event, projectId, filters) =>
    projects.listWorkItems(projectIdSchema.parse(projectId), workItemFiltersSchema.parse(filters ?? {}))
  )
  ipcMain.handle('work-items:create', (_event, projectId, input) => {
    const parsedProjectId = projectIdSchema.parse(projectId)
    const parsed = createWorkItemInputSchema.parse({ projectId: parsedProjectId, ...input })
    return projects.createWorkItem(parsed.projectId, parsed)
  })
  ipcMain.handle('work-items:get', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.getWorkItem(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('work-items:update', (_event, projectId, workItemId, patch) => {
    const reference = workItemReferenceSchema.parse({ projectId, workItemId })
    const updates = updateWorkItemInputSchema.omit({ projectId: true, workItemId: true }).parse(patch)
    return projects.updateWorkItem(reference.projectId, reference.workItemId, updates)
  })
  ipcMain.handle('work-items:recover', (_event, projectId, workItemId, input) => {
    const reference = workItemReferenceSchema.parse({ projectId, workItemId })
    const patch = forceReleaseWorkItemInputSchema.omit({ projectId: true, workItemId: true }).parse(input)
    return projects.recoverWorkItem(reference.projectId, reference.workItemId, patch)
  })
  ipcMain.handle('work-items:checkpoints', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.listCheckpoints(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('work-items:completion-history', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.listCompletionHistory(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('work-items:delete', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    await projects.deleteWorkItem(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('work-items:preflight', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.withProjectOperation(parsed.projectId, async () => copilot.preflight(await projects.getProject(parsed.projectId), await projects.getWorkItem(parsed.projectId, parsed.workItemId)))
  })
  ipcMain.handle('work-items:launch-copilot', async (_event, projectId, workItemId, prompt, approval) => {
    const parsed = launchCopilotInputSchema.parse({ projectId, workItemId, prompt })
    const contextApproval = contextApprovalSchema.optional().parse(approval)
    return projects.withProjectOperation(parsed.projectId, async () => {
      const [project, workItem] = await Promise.all([
        projects.getProject(parsed.projectId),
        projects.getWorkItem(parsed.projectId, parsed.workItemId),
        projects.verifyProjectRoot(parsed.projectId)
      ])
      await projects.assertTaskReady(parsed.projectId, parsed.workItemId)
      const result = await copilot.launch(project, workItem, parsed.prompt, contextApproval)
      await projects.updateProject(parsed.projectId, { settings: { copilotLaunchPrompt: parsed.prompt } })
      if (!result.pullRequest) {
        return { started: true, contextPacketId: result.contextPacketId }
      }
      await projects.reconcileSubmittedPullRequest(parsed.projectId, parsed.workItemId, {
        branch: result.branch,
        prUrl: result.pullRequest.url,
        merged: result.pullRequest.state === 'MERGED'
      })
      return { started: false, pullRequestUrl: result.pullRequest.url, contextPacketId: result.contextPacketId }
    })
  })
  ipcMain.handle('work-items:restack', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.withProjectOperation(parsed.projectId, async () => {
      const [project, workItem] = await Promise.all([
        projects.getProject(parsed.projectId),
        projects.getWorkItem(parsed.projectId, parsed.workItemId)
      ])
      if (workItem.status === 'completed' || workItem.deliveryState === 'awaiting_review') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Completed work and open pull requests cannot be restacked.')
      await copilot.restack(project, workItem)
      const input = { reason: 'Restacked by Workstack after stopping the Copilot session.' }
      if (await projects.getActiveClaim(parsed.projectId, parsed.workItemId)) await projects.forceReleaseWorkItem(parsed.projectId, parsed.workItemId, input)
      else await projects.recoverWorkItem(parsed.projectId, parsed.workItemId, input)
    })
  })
  ipcMain.handle('work-items:restart', async (_event, projectId, workItemId, approval) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    const contextApproval = contextApprovalSchema.optional().parse(approval)
    return projects.withProjectOperation(parsed.projectId, async () => {
      const [project, workItem] = await Promise.all([
        projects.getProject(parsed.projectId),
        projects.getWorkItem(parsed.projectId, parsed.workItemId)
      ])
      if (workItem.status === 'completed' || workItem.deliveryState === 'awaiting_review') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Completed work and open pull requests cannot be restarted.')
      await projects.assertTaskReady(parsed.projectId, parsed.workItemId)
      const preflight = await copilot.preflight(project, workItem)
      if (!preflight.supported) throw new WorkstackError('VALIDATION_ERROR', preflight.reason ?? 'The selected execution profile is unavailable.')
      return copilot.restart(project, workItem, async () => {
        const input = { reason: 'Restarting the Copilot session from the existing worktree.' }
        if (await projects.getActiveClaim(parsed.projectId, parsed.workItemId)) await projects.forceReleaseWorkItem(parsed.projectId, parsed.workItemId, input)
        else await projects.recoverWorkItem(parsed.projectId, parsed.workItemId, input)
      }, contextApproval)
    })
  })
  ipcMain.handle('activity:list', (_event, projectId) => projects.listActivity(projectIdSchema.parse(projectId)))
  ipcMain.handle('pull-requests:list', (_event, projectId) => pullRequests.list(projectIdSchema.parse(projectId)))
  ipcMain.handle('pull-requests:open', async (_event, url) => {
    await shell.openExternal(z.string().url().parse(url))
  })
  ipcMain.handle('pull-requests:merge', (_event, projectId, urls) =>
    pullRequests.merge(projectIdSchema.parse(projectId), z.array(z.string().url()).min(1).parse(urls))
  )
  ipcMain.handle('claims:list', (_event, projectId) => projects.listActiveClaims(projectIdSchema.parse(projectId)))
  ipcMain.handle('claims:get', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.getActiveClaim(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('claims:force-release', (_event, projectId, workItemId, input) => {
    const parsed = forceReleaseWorkItemInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.forceReleaseWorkItem(parsed.projectId, parsed.workItemId, { reason: parsed.reason })
  })
  ipcMain.handle('claims:get-completion', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.getCompletion(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('claims:update-worker-handoff', (_event, projectId, workItemId, input) => {
    const parsed = updateWorkerHandoffInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.updateWorkerHandoff(parsed.projectId, parsed.workItemId, {
      sessionSummaryMarkdown: parsed.sessionSummaryMarkdown
    })
  })
  ipcMain.handle('source-catalog:preview-repository', (_event, projectId) => sourceIntake.previewRepository(projectIdSchema.parse(projectId)))
  ipcMain.handle('source-catalog:import-selection', (_event, projectId, input) => sourceIntake.importSelection(projectIdSchema.parse(projectId), z.object({
    paths: z.array(z.string().min(1).max(2000)).max(1000), githubUrls: z.array(z.string().url().max(4000)).max(100).optional(), policy: sourcePolicySchema.optional(), workItemId: z.string().uuid().optional()
  }).strict().parse(input)))
  ipcMain.handle('source-catalog:refresh', (_event, projectId, sourceId) => sourceIntake.refresh(projectIdSchema.parse(projectId), sourceIdSchema.parse(sourceId)))
  ipcMain.handle('task-dependencies:get', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.getTaskCoordination(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('task-dependencies:update', (_event, projectId, workItemId, input) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.updateTaskCoordination(parsed.projectId, parsed.workItemId, taskDependenciesInputSchema.parse(input))
  })
  ipcMain.handle('source-catalog:list', (_event, projectId) => projects.listProjectSources(projectIdSchema.parse(projectId)))
  ipcMain.handle('source-catalog:detail', (_event, projectId, sourceId) => projects.getProjectSource(projectIdSchema.parse(projectId), sourceIdSchema.parse(sourceId)))
  ipcMain.handle('source-catalog:set-policy', (_event, projectId, sourceId, policy, refreshSeconds) =>
    projects.updateSourcePolicy(projectIdSchema.parse(projectId), sourceIdSchema.parse(sourceId), sourcePolicySchema.parse(policy), z.number().int().min(60).max(30 * 86400).optional().parse(refreshSeconds))
  )
  ipcMain.handle('source-catalog:retry', (_event, projectId, jobId) => projects.retrySourceIntake(projectIdSchema.parse(projectId), z.string().uuid().parse(jobId)))
  ipcMain.handle('source-catalog:cancel', (_event, projectId, jobId) => projects.cancelSourceIntake(projectIdSchema.parse(projectId), z.string().uuid().parse(jobId)))
  ipcMain.handle('source-catalog:search', (_event, projectId, query) => projects.searchSourcePassages(projectIdSchema.parse(projectId), z.string().trim().min(1).max(500).parse(query)))
  ipcMain.handle('source-catalog:read-revision', (_event, projectId, sourceId, revisionId, representation, offset) =>
    projects.readSourceRevision(projectIdSchema.parse(projectId), sourceIdSchema.parse(sourceId), z.string().uuid().parse(revisionId), {
      representation: z.enum(['original', 'normalized']).optional().parse(representation), offset: z.number().int().nonnegative().optional().parse(offset), limit: 16_000
    })
  )
  ipcMain.handle('source-catalog:read-citation', (_event, projectId, citation, neighbors) =>
    projects.readSourceCitation(projectIdSchema.parse(projectId), sourceCitationSchema.parse(citation), { neighbors: z.number().int().min(0).max(3).optional().parse(neighbors) })
  )
  const identity = z.string().trim().min(1).max(200)
  const changeReason = z.string().trim().min(1).max(20_000)
  const recordId = z.string().trim().min(1).max(200)
  const version = z.number().int().positive()
  const recordUpdate = knowledgeRecordInputSchema.omit({ kind: true }).partial().extend({ expectedVersion: version, confidence: z.number().min(0).max(1).nullable().optional(), reviewDueAt: z.string().datetime().nullable().optional() }).strict()
  const directoryUpdate = projectEntityInputSchema.omit({ kind: true }).partial().extend({ expectedVersion: version }).strict()
  ipcMain.handle('knowledge-records:list', (_event, projectId) => projects.listKnowledgeRecords(projectIdSchema.parse(projectId), { includeHistorical: true }))
  ipcMain.handle('knowledge-records:get', (_event, projectId, id) => projects.getKnowledgeRecord(projectIdSchema.parse(projectId), recordId.parse(id)))
  ipcMain.handle('knowledge-records:create', (_event, projectId, input, actor) => projects.createKnowledgeRecord(projectIdSchema.parse(projectId), knowledgeRecordInputSchema.strict().parse(input), identity.parse(actor)))
  ipcMain.handle('knowledge-records:update', (_event, projectId, id, input, actor, reason) => projects.updateKnowledgeRecord(projectIdSchema.parse(projectId), recordId.parse(id), recordUpdate.parse(input), identity.parse(actor), changeReason.parse(reason)))
  ipcMain.handle('knowledge-records:checks', (_event, projectId) => projects.checkKnowledgeRecords(projectIdSchema.parse(projectId)))
  ipcMain.handle('knowledge-records:review', (_event, projectId, id, actor, note, outcome, expectedVersion) => projects.reviewKnowledgeRecord(projectIdSchema.parse(projectId), recordId.parse(id), { actor: identity.parse(actor), note: changeReason.parse(note), outcome: z.enum(['confirmed', 'needs_changes']).parse(outcome), expectedVersion: version.optional().parse(expectedVersion) }))
  ipcMain.handle('knowledge-records:supersede', (_event, projectId, id, replacementId, actor, reason) => projects.supersedeKnowledgeRecord(projectIdSchema.parse(projectId), recordId.parse(id), recordId.parse(replacementId), identity.parse(actor), changeReason.parse(reason)))
  ipcMain.handle('knowledge-records:history', (_event, projectId, id) => projects.knowledgeRecordHistory(projectIdSchema.parse(projectId), recordId.parse(id)))
  ipcMain.handle('knowledge-records:reviews', (_event, projectId, id) => projects.knowledgeRecordReviews(projectIdSchema.parse(projectId), recordId.parse(id)))
  ipcMain.handle('project-directory:list', (_event, projectId) => projects.listProjectDirectory(projectIdSchema.parse(projectId), { includeHistorical: true }))
  ipcMain.handle('project-directory:detail', (_event, projectId, id) => projects.projectDirectoryDetail(projectIdSchema.parse(projectId), recordId.parse(id), { includeHistoricalMentions: true }))
  ipcMain.handle('project-directory:lookup', (_event, projectId, query) => projects.lookupProjectDirectory(projectIdSchema.parse(projectId), z.string().trim().min(1).max(500).parse(query)))
  ipcMain.handle('project-directory:create', (_event, projectId, input, actor) => projects.createProjectEntity(projectIdSchema.parse(projectId), projectEntityInputSchema.strict().parse(input), identity.parse(actor)))
  ipcMain.handle('project-directory:update', (_event, projectId, id, input, actor, reason) => projects.updateProjectEntity(projectIdSchema.parse(projectId), recordId.parse(id), directoryUpdate.parse(input), identity.parse(actor), changeReason.parse(reason)))
  ipcMain.handle('project-directory:merge', (_event, projectId, sourceId, targetId, input) => projects.mergeProjectEntities(projectIdSchema.parse(projectId), recordId.parse(sourceId), recordId.parse(targetId), z.object({ actor: identity, reason: changeReason, expectedSourceVersion: version, expectedTargetVersion: version }).strict().parse(input)))
  ipcMain.handle('project-directory:split', (_event, projectId, id, input) => projects.splitProjectEntity(projectIdSchema.parse(projectId), recordId.parse(id), z.object({ actor: identity, reason: changeReason, expectedVersion: version, entry: projectEntityInputSchema.strict(), aliases: z.array(z.string().min(1).max(200)).max(100), mentionIds: z.array(recordId).max(1000) }).strict().parse(input)))
  ipcMain.handle('project-directory:resolve-mention', (_event, projectId, mentionId, entityId, actor, reason) => projects.resolveProjectMention(projectIdSchema.parse(projectId), recordId.parse(mentionId), recordId.nullable().parse(entityId), identity.parse(actor), changeReason.parse(reason)))
  ipcMain.handle('context-packets:policy', (_event, projectId) => projects.getContextPolicy(projectIdSchema.parse(projectId)))
  ipcMain.handle('context-packets:update-policy', (_event, projectId, input) => projects.updateContextPolicy(projectIdSchema.parse(projectId), contextPolicyInputSchema.parse(input)))
  ipcMain.handle('context-packets:preferences', (_event, projectId, workItemId) => { const parsed = workItemReferenceSchema.parse({ projectId, workItemId }); return projects.getContextPreferences(parsed.projectId, parsed.workItemId) })
  ipcMain.handle('context-packets:update-preferences', (_event, projectId, workItemId, input) => { const parsed = workItemReferenceSchema.parse({ projectId, workItemId }); return projects.updateContextPreferences(parsed.projectId, parsed.workItemId, contextPreferencesInputSchema.parse(input)) })
  ipcMain.handle('context-packets:preview', (_event, projectId, workItemId, approval) => { const parsed = workItemReferenceSchema.parse({ projectId, workItemId }); return projects.previewContextPacket(parsed.projectId, parsed.workItemId, contextApprovalSchema.optional().parse(approval)) })
  ipcMain.handle('context-packets:list', (_event, projectId, workItemId) => { const parsed = workItemReferenceSchema.parse({ projectId, workItemId }); return projects.listContextPackets(parsed.projectId, parsed.workItemId) })
  ipcMain.handle('context-packets:get', (_event, projectId, packetId) => projects.getContextPacket(projectIdSchema.parse(projectId), identity.parse(packetId)))
  ipcMain.handle('context-packets:read-section', (_event, projectId, packetId, category, offset) => projects.readContextSection(projectIdSchema.parse(projectId), identity.parse(packetId), z.enum(contextCategories).parse(category), z.number().int().nonnegative().default(0).parse(offset), 12_000))
  ipcMain.handle('context-packets:usage', (_event, projectId, packetId) => projects.listContextPacketUsage(projectIdSchema.parse(projectId), identity.parse(packetId)))
  ipcMain.handle('context-feedback:create', (_event, projectId, input) => projects.createContextFeedback(projectIdSchema.parse(projectId), { ...contextFeedbackInputSchema.parse(input), authorKind: 'human' }))
  ipcMain.handle('context-feedback:list', (_event, projectId, options) => projects.listContextFeedback(projectIdSchema.parse(projectId), z.object({ workItemId: recordId.optional(), packetId: identity.optional(), status: z.enum(['proposed', 'triaged', 'resolved', 'dismissed']).optional(), limit: z.number().int().min(1).max(500).optional() }).strict().default({}).parse(options)))
  ipcMain.handle('context-feedback:triage', (_event, projectId, feedbackId, input) => projects.triageContextFeedback(projectIdSchema.parse(projectId), identity.parse(feedbackId), contextFeedbackTriageSchema.parse(input)))
  ipcMain.handle('context-feedback:history', (_event, projectId, feedbackId) => projects.contextFeedbackHistory(projectIdSchema.parse(projectId), identity.parse(feedbackId)))
  ipcMain.handle('knowledge-delivery:list', (_event, projectId) => projects.listKnowledgeDeliveries(projectIdSchema.parse(projectId)))
  ipcMain.handle('knowledge-delivery:retry', (_event, projectId, deliveryId) =>
    projects.retryKnowledgeDelivery(projectIdSchema.parse(projectId), z.number().int().positive().parse(deliveryId))
  )
  const processSemantic = (projectId: string): void => { void projects.processSemanticJobs(projectId).catch((error) => console.error('Local semantic indexing failed:', error)) }
  ipcMain.handle('semantic:status', (_event, projectId) => projects.semanticStatus(projectIdSchema.parse(projectId)))
  ipcMain.handle('semantic:choose-model', async (_event, projectId) => {
    const id = projectIdSchema.parse(projectId)
    await projects.getProject(id)
    const selected = await dialog.showOpenDialog({ title: 'Choose a local word-vector pack', properties: ['openFile'], filters: [{ name: 'Local word-vector pack', extensions: ['json'] }] })
    if (selected.canceled || !selected.filePaths[0]) return undefined
    const status = await projects.configureSemanticModel(id, selected.filePaths[0])
    processSemantic(id)
    return status
  })
  ipcMain.handle('semantic:disable', (_event, projectId) => projects.disableSemanticModel(projectIdSchema.parse(projectId)))
  ipcMain.handle('semantic:reindex', async (_event, projectId) => { const id = projectIdSchema.parse(projectId); const status = await projects.rebuildSemanticIndex(id); processSemantic(id); return status })
  ipcMain.handle('semantic:cancel', (_event, projectId, jobId) => projects.cancelSemanticJob(projectIdSchema.parse(projectId), z.string().uuid().parse(jobId)))
  ipcMain.handle('semantic:retry', async (_event, projectId, jobId) => { const id = projectIdSchema.parse(projectId); const status = await projects.retrySemanticJob(id, z.string().uuid().parse(jobId)); processSemantic(id); return status })
  ipcMain.handle('knowledge:list-sources', (_event, projectId) => projects.listKnowledgeSources(projectIdSchema.parse(projectId)))
  ipcMain.handle('knowledge:add-source', (_event, projectId, input) => {
    const parsed = knowledgeSourceInputSchema.parse({ projectId, ...(input ?? {}) })
    return projects.addKnowledgeSource(parsed.projectId, parsed)
  })
  ipcMain.handle('knowledge:search', (_event, projectId, query) =>
    projects.searchKnowledge(projectIdSchema.parse(projectId), z.string().trim().min(1).parse(query))
  )
  ipcMain.handle('knowledge:retrieve', (_event, projectId, query, limit) => {
    const parsed = knowledgeRetrievalInputSchema.parse({ projectId, query, limit })
    return projects.retrieveKnowledge(parsed.projectId, parsed.query, parsed.limit)
  })
  ipcMain.handle('knowledge:process-next', (_event, projectId) =>
    projects.processKnowledgeJob(projectIdSchema.parse(projectId))
  )
  ipcMain.handle('knowledge:retry-failed', (_event, projectId) =>
    projects.retryKnowledgeJobs(projectIdSchema.parse(projectId))
  )
  ipcMain.handle('wiki-revisions:list', (_event, projectId) => projects.listWikiRevisions(projectIdSchema.parse(projectId)))
  ipcMain.handle('wiki-revisions:review', (_event, projectId, revisionId) => projects.reviewWikiRevision(projectIdSchema.parse(projectId), z.string().uuid().parse(revisionId)))
  ipcMain.handle('wiki-revisions:publish', (_event, projectId, revisionId, actor, note) => projects.publishWikiRevision(projectIdSchema.parse(projectId), z.string().uuid().parse(revisionId), z.string().trim().min(1).max(200).parse(actor), z.string().max(20_000).optional().parse(note)))
  ipcMain.handle('wiki-revisions:reject', (_event, projectId, revisionId, actor, reason) => projects.rejectWikiRevision(projectIdSchema.parse(projectId), z.string().uuid().parse(revisionId), z.string().trim().min(1).max(200).parse(actor), z.string().trim().min(1).max(20_000).parse(reason)))
  ipcMain.handle('wiki-revisions:reconcile', (_event, projectId, revisionId, actor, reason) => projects.reconcileWikiRevision(projectIdSchema.parse(projectId), z.string().uuid().parse(revisionId), z.string().trim().min(1).max(200).parse(actor), z.string().trim().min(1).max(20_000).parse(reason)))
  ipcMain.handle('wiki-revisions:restore', (_event, projectId, revisionId, actor, reason) => projects.restoreWikiRevision(projectIdSchema.parse(projectId), z.string().uuid().parse(revisionId), z.string().trim().min(1).max(200).parse(actor), z.string().trim().min(1).max(20_000).parse(reason)))
  ipcMain.handle('knowledge:list-wiki', (_event, projectId) => projects.listWikiArticles(projectIdSchema.parse(projectId)))
  ipcMain.handle('knowledge:save-wiki', (_event, projectId, slug, content) =>
    projects.saveWikiArticle(projectIdSchema.parse(projectId), z.string().trim().min(1).parse(slug), z.string().parse(content))
  )
  ipcMain.handle('wiki-automation:list-reports', (_event, projectId) =>
    projects.listWikiAutomationReports(projectIdSchema.parse(projectId))
  )
  ipcMain.handle('wiki-automation:rescan', (_event, projectId) =>
    wikiAutomation.requestFullCodebaseRescan(wikiAutomationRescanInputSchema.parse({ projectId }).projectId)
  )
  ipcMain.handle('wiki-automation:retry', (_event, projectId, jobId) => {
    const parsed = wikiAutomationJobReferenceSchema.parse({ projectId, jobId })
    return projects.retryWikiAutomationJob(parsed.projectId, parsed.jobId)
  })
  ipcMain.handle('knowledge-chat:list-sessions', (_event, projectId) =>
    projects.listKnowledgeChatSessions(projectIdSchema.parse(projectId))
  )
  ipcMain.handle('knowledge-chat:create-session', (_event, projectId) =>
    projects.createKnowledgeChatSession(projectIdSchema.parse(projectId))
  )
  ipcMain.handle('knowledge-chat:list-messages', (_event, projectId, sessionId) => {
    const parsed = knowledgeChatSessionReferenceSchema.parse({ projectId, sessionId })
    return projects.listKnowledgeChatMessages(parsed.projectId, parsed.sessionId)
  })
  ipcMain.handle('knowledge-chat:list-tool-calls', (_event, projectId, sessionId) => {
    const parsed = knowledgeChatSessionReferenceSchema.parse({ projectId, sessionId })
    return projects.listKnowledgeChatToolCalls(parsed.projectId, parsed.sessionId)
  })
  ipcMain.handle('knowledge-chat:send-message', (_event, projectId, sessionId, contentMarkdown, requestId) => {
    const parsed = knowledgeChatMessageInputSchema.parse({ projectId, sessionId, contentMarkdown })
    return runAiRequest(requestId, (options) => projects.sendKnowledgeChatMessage(parsed.projectId, parsed.sessionId, parsed.contentMarkdown, ai, options))
  })
  ipcMain.handle('knowledge-chat:list-pending-actions', (_event, projectId, sessionId) => {
    const parsed = knowledgeChatSessionReferenceSchema.parse({ projectId, sessionId })
    return projects.listKnowledgeChatPendingActions(parsed.projectId, parsed.sessionId)
  })
  ipcMain.handle('knowledge-chat:approve-pending-action', (_event, projectId, sessionId, actionId) => {
    const parsed = knowledgeChatPendingActionReferenceSchema.parse({ projectId, sessionId, actionId })
    return projects.approveKnowledgeChatPendingAction(parsed.projectId, parsed.sessionId, parsed.actionId)
  })
  ipcMain.handle('knowledge-chat:reject-pending-action', (_event, projectId, sessionId, actionId) => {
    const parsed = knowledgeChatPendingActionReferenceSchema.parse({ projectId, sessionId, actionId })
    return projects.rejectKnowledgeChatPendingAction(parsed.projectId, parsed.sessionId, parsed.actionId)
  })
  ipcMain.handle('planning:list-sessions', (_event, projectId) => projects.listPlanningSessions(projectIdSchema.parse(projectId)))
  ipcMain.handle('planning:create', (_event, projectId) => projects.createPlanningSession(projectIdSchema.parse(projectId)))
  ipcMain.handle('planning:get', (_event, projectId, sessionId) =>
    projects.getPlanningProposal(projectIdSchema.parse(projectId), z.string().uuid().parse(sessionId))
  )
  ipcMain.handle('planning:update', (_event, projectId, sessionId, patch) => {
    const reference = planningSessionReferenceSchema.parse({ projectId, sessionId })
    const updates = planningProposalInputSchema.omit({ projectId: true, sessionId: true }).parse(patch ?? {})
    return projects.updatePlanningProposal(reference.projectId, reference.sessionId, updates)
  })
  ipcMain.handle('planning:convert', (_event, projectId, sessionId) =>
    projects.convertPlanningProposal(projectIdSchema.parse(projectId), z.string().uuid().parse(sessionId))
  )
  ipcMain.handle('planning:list-messages', (_event, projectId, sessionId) =>
    projects.listPlanningMessages(projectIdSchema.parse(projectId), z.string().uuid().parse(sessionId))
  )
  ipcMain.handle('planning:add-message', (_event, projectId, sessionId, role, content) =>
    projects.addPlanningMessage(projectIdSchema.parse(projectId), z.string().uuid().parse(sessionId), z.enum(['user', 'assistant', 'system', 'tool']).parse(role), z.string().trim().min(1).parse(content))
  )
  ipcMain.handle('planning:context', (_event, projectId, sessionId, query) => {
    const parsed = planningSessionReferenceSchema.parse({ projectId, sessionId })
    return projects.getPlanningContext(parsed.projectId, parsed.sessionId, z.string().trim().max(500).parse(query))
  })
  ipcMain.handle('planning:list-attachments', (_event, projectId, sessionId) => {
    const parsed = planningSessionReferenceSchema.parse({ projectId, sessionId })
    return projects.listPlanningAttachments(parsed.projectId, parsed.sessionId)
  })
  ipcMain.handle('planning:attach-bytes', (_event, projectId, sessionId, input) => {
    const parsed = planningAttachmentInputSchema.parse({ projectId, sessionId, ...(input ?? {}) })
    return projects.attachPlanningBytes(parsed.projectId, parsed.sessionId, {
      requestId: parsed.requestId,
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('planning:paste-image', (_event, projectId, sessionId, input) => {
    const parsed = planningAttachmentInputSchema.parse({ projectId, sessionId, ...(input ?? {}) })
    return projects.pastePlanningImage(parsed.projectId, parsed.sessionId, {
      requestId: parsed.requestId,
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('planning:remove-attachment', async (_event, projectId, sessionId, attachmentId) => {
    const parsed = planningSessionReferenceSchema.extend({ attachmentId: z.string().uuid() }).parse({ projectId, sessionId, attachmentId })
    await projects.removePlanningAttachment(parsed.projectId, parsed.sessionId, parsed.attachmentId)
  })
  ipcMain.handle('planning:preview-attachment-url', async (_event, projectId, sessionId, attachmentId) => {
    const parsed = planningSessionReferenceSchema.extend({ attachmentId: z.string().uuid() }).parse({ projectId, sessionId, attachmentId })
    const { attachment, data } = await projects.readPlanningAttachment(parsed.projectId, parsed.sessionId, parsed.attachmentId)
    return `data:${attachment.mimeType ?? 'application/octet-stream'};base64,${data.toString('base64')}`
  })
  ipcMain.handle('ai:settings', () => ai.settings())
  ipcMain.handle('ai:configure', (_event, input) => ai.configure(z.object({
    baseUrl: z.string().url(),
    model: z.string().trim().min(1),
    apiMode: z.enum(['chat_completions', 'responses', 'messages']).optional(),
    apiKey: z.string().trim().min(1).optional(),
    removeApiKey: z.boolean().optional()
  }).strict().parse(input)))
  ipcMain.handle('ai:list-models', (_event, input) => ai.listModels(z.object({
    baseUrl: z.string().url(),
    apiMode: z.enum(['chat_completions', 'responses', 'messages']).optional(),
    apiKey: z.string().trim().min(1).optional()
  }).strict().parse(input)))
  ipcMain.handle('ai:propose', (_event, prompt, requestId) => runAiRequest(requestId, (options) => ai.propose(z.string().trim().min(1).parse(prompt), options)))
  ipcMain.handle('ai:propose-planning', async (_event, projectId, sessionId, prompt, contextId, requestId) => {
    const parsed = planningSessionReferenceSchema.parse({ projectId, sessionId })
    const parsedPrompt = z.string().trim().min(1).parse(prompt)
    const context = contextId
      ? await projects.readPlanningContext(parsed.projectId, parsed.sessionId, z.string().uuid().parse(contextId))
      : await projects.getPlanningContext(parsed.projectId, parsed.sessionId, parsedPrompt)
    return runAiRequest(requestId, (options) => ai.proposePlanning(parsedPrompt, context, options))
  })

  ipcMain.handle('attachments:list', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.listAttachments(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('attachments:attach-bytes', (_event, projectId, workItemId, input) => {
    const parsed = binaryAttachmentInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.attachBytes(parsed.projectId, parsed.workItemId, {
      requestId: parsed.requestId,
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('attachments:paste-image', (_event, projectId, workItemId, input) => {
    const parsed = binaryAttachmentInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.pasteImage(parsed.projectId, parsed.workItemId, {
      requestId: parsed.requestId,
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('attachments:remove', async (_event, projectId, workItemId, attachmentId) => {
    const parsed = binaryAttachmentInputSchema.pick({ projectId: true, workItemId: true }).extend({
      attachmentId: z.string().uuid()
    }).parse({ projectId, workItemId, attachmentId })
    await projects.removeAttachment(parsed.projectId, parsed.workItemId, parsed.attachmentId)
  })
  ipcMain.handle('attachments:preview-url', async (_event, projectId, workItemId, attachmentId) => {
    const parsed = binaryAttachmentInputSchema.pick({ projectId: true, workItemId: true }).extend({
      attachmentId: z.string().uuid()
    }).parse({ projectId, workItemId, attachmentId })
    const { attachment, data } = await projects.readAttachment(parsed.projectId, parsed.workItemId, parsed.attachmentId)
    return `data:${attachment.mimeType ?? 'application/octet-stream'};base64,${data.toString('base64')}`
  })
}

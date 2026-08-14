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
import { ProjectsService } from '../core/projects-service'
import { OpenAiCompatibleProvider } from './ai-provider'
import { CopilotLauncher, worktreeSlug } from './copilot-launcher'
import { PullRequestService } from './pull-requests'
import type { WikiAutomationService } from './wiki-automation-service'

export function registerIpcHandlers(
  projects: ProjectsService,
  ai: OpenAiCompatibleProvider,
  copilot: CopilotLauncher,
  pullRequests: PullRequestService,
  wikiAutomation: WikiAutomationService
): void {
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
    const parsed = updateWorkItemInputSchema.parse({ projectId, workItemId, ...patch })
    return projects.updateWorkItem(parsed.projectId, parsed.workItemId, parsed)
  })
  ipcMain.handle('work-items:delete', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    await projects.deleteWorkItem(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('work-items:launch-copilot', async (_event, projectId, workItemId, prompt) => {
    const parsed = launchCopilotInputSchema.parse({ projectId, workItemId, prompt })
    const [project, workItem] = await Promise.all([
      projects.getProject(parsed.projectId),
      projects.getWorkItem(parsed.projectId, parsed.workItemId),
      projects.verifyProjectRoot(parsed.projectId)
    ])
    await projects.updateProject(parsed.projectId, { settings: { copilotLaunchPrompt: parsed.prompt } })
    const result = await copilot.launch(project, workItem, parsed.prompt)
    if (!result.pullRequest) {
      return { started: true }
    }
    await projects.reconcileSubmittedPullRequest(parsed.projectId, parsed.workItemId, {
      branch: `anhobden/${worktreeSlug(workItem.title, workItem.displayId)}`,
      prUrl: result.pullRequest.url,
      merged: result.pullRequest.state === 'MERGED'
    })
    return { started: false, pullRequestUrl: result.pullRequest.url }
  })
  ipcMain.handle('work-items:restack', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    const [project, workItem] = await Promise.all([
      projects.getProject(parsed.projectId),
      projects.getWorkItem(parsed.projectId, parsed.workItemId)
    ])
    await copilot.restack(project, workItem)
    await projects.forceReleaseWorkItem(parsed.projectId, parsed.workItemId, {
      reason: 'Restacked by Workstack after stopping the Copilot session.'
    })
  })
  ipcMain.handle('work-items:restart', async (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    const [project, workItem] = await Promise.all([
      projects.getProject(parsed.projectId),
      projects.getWorkItem(parsed.projectId, parsed.workItemId)
    ])
    await projects.forceReleaseWorkItem(parsed.projectId, parsed.workItemId, {
      reason: 'Restarting the Copilot session from the existing worktree.'
    })
    await copilot.restart(project, workItem)
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
  ipcMain.handle('knowledge-chat:send-message', (_event, projectId, sessionId, contentMarkdown) => {
    const parsed = knowledgeChatMessageInputSchema.parse({ projectId, sessionId, contentMarkdown })
    return projects.sendKnowledgeChatMessage(parsed.projectId, parsed.sessionId, parsed.contentMarkdown, ai)
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
  ipcMain.handle('planning:create', (_event, projectId) => projects.createPlanningSession(projectIdSchema.parse(projectId)))
  ipcMain.handle('planning:get', (_event, projectId, sessionId) =>
    projects.getPlanningProposal(projectIdSchema.parse(projectId), z.string().uuid().parse(sessionId))
  )
  ipcMain.handle('planning:update', (_event, projectId, sessionId, patch) => {
    const parsed = planningProposalInputSchema.parse({ projectId, sessionId, ...(patch ?? {}) })
    return projects.updatePlanningProposal(parsed.projectId, parsed.sessionId, parsed)
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
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('planning:paste-image', (_event, projectId, sessionId, input) => {
    const parsed = planningAttachmentInputSchema.parse({ projectId, sessionId, ...(input ?? {}) })
    return projects.pastePlanningImage(parsed.projectId, parsed.sessionId, {
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
    apiKey: z.string().trim().min(1).optional()
  }).strict().parse(input)))
  ipcMain.handle('ai:list-models', (_event, input) => ai.listModels(z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().trim().min(1).optional()
  }).strict().parse(input)))
  ipcMain.handle('ai:propose', (_event, prompt) => ai.propose(z.string().trim().min(1).parse(prompt)))
  ipcMain.handle('ai:propose-planning', async (_event, projectId, sessionId, prompt) => {
    const parsed = planningSessionReferenceSchema.parse({ projectId, sessionId })
    const parsedPrompt = z.string().trim().min(1).parse(prompt)
    return ai.proposePlanning(parsedPrompt, await projects.getPlanningContext(parsed.projectId, parsed.sessionId, parsedPrompt))
  })

  ipcMain.handle('attachments:list', (_event, projectId, workItemId) => {
    const parsed = workItemReferenceSchema.parse({ projectId, workItemId })
    return projects.listAttachments(parsed.projectId, parsed.workItemId)
  })
  ipcMain.handle('attachments:attach-bytes', (_event, projectId, workItemId, input) => {
    const parsed = binaryAttachmentInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.attachBytes(parsed.projectId, parsed.workItemId, {
      data: Buffer.from(parsed.data),
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType
    })
  })
  ipcMain.handle('attachments:paste-image', (_event, projectId, workItemId, input) => {
    const parsed = binaryAttachmentInputSchema.parse({ projectId, workItemId, ...(input ?? {}) })
    return projects.pasteImage(parsed.projectId, parsed.workItemId, {
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

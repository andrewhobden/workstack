import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/desktop-api'

const workstack: DesktopApi = {
  system: {
    appVersion: (): Promise<string> => ipcRenderer.invoke('system:app-version')
  },
  ai: {
    settings: () => ipcRenderer.invoke('ai:settings'),
    configure: (input) => ipcRenderer.invoke('ai:configure', input),
    listModels: (input) => ipcRenderer.invoke('ai:list-models', input),
    propose: (prompt) => ipcRenderer.invoke('ai:propose', prompt),
    proposePlanning: (projectId, sessionId, prompt) => ipcRenderer.invoke('ai:propose-planning', projectId, sessionId, prompt)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    get: (projectId) => ipcRenderer.invoke('projects:get', projectId),
    update: (projectId, updates) => ipcRenderer.invoke('projects:update', { projectId, ...updates }),
    detach: (projectId) => ipcRenderer.invoke('projects:detach', projectId),
    delete: (projectId, input) => ipcRenderer.invoke('projects:delete', { projectId, ...input }),
    chooseFolder: () => ipcRenderer.invoke('projects:choose-folder'),
    openFolder: (projectId) => ipcRenderer.invoke('projects:open-folder', projectId)
  },
  workItems: {
    list: (projectId, filters) => ipcRenderer.invoke('work-items:list', projectId, filters),
    create: (projectId, input) => ipcRenderer.invoke('work-items:create', projectId, input),
    get: (projectId, workItemId) => ipcRenderer.invoke('work-items:get', projectId, workItemId),
    update: (projectId, workItemId, patch) => ipcRenderer.invoke('work-items:update', projectId, workItemId, patch),
    delete: (projectId, workItemId) => ipcRenderer.invoke('work-items:delete', projectId, workItemId),
    launchCopilot: (projectId, workItemId, prompt) => ipcRenderer.invoke('work-items:launch-copilot', projectId, workItemId, prompt),
    restack: (projectId, workItemId) => ipcRenderer.invoke('work-items:restack', projectId, workItemId),
    restart: (projectId, workItemId) => ipcRenderer.invoke('work-items:restart', projectId, workItemId)
  },
  activity: {
    list: (projectId) => ipcRenderer.invoke('activity:list', projectId)
  },
  pullRequests: {
    list: (projectId) => ipcRenderer.invoke('pull-requests:list', projectId),
    open: (url) => ipcRenderer.invoke('pull-requests:open', url),
    merge: (projectId, urls) => ipcRenderer.invoke('pull-requests:merge', projectId, urls)
  },
  claims: {
    list: (projectId) => ipcRenderer.invoke('claims:list', projectId),
    get: (projectId, workItemId) => ipcRenderer.invoke('claims:get', projectId, workItemId),
    forceRelease: (projectId, workItemId, input) =>
      ipcRenderer.invoke('claims:force-release', projectId, workItemId, input),
    getCompletion: (projectId, workItemId) => ipcRenderer.invoke('claims:get-completion', projectId, workItemId),
    updateWorkerHandoff: (projectId, workItemId, input) =>
      ipcRenderer.invoke('claims:update-worker-handoff', projectId, workItemId, input)
  },
  knowledge: {
    listSources: (projectId) => ipcRenderer.invoke('knowledge:list-sources', projectId),
    addSource: (projectId, input) => ipcRenderer.invoke('knowledge:add-source', projectId, input),
    search: (projectId, query) => ipcRenderer.invoke('knowledge:search', projectId, query),
    retrieve: (projectId, query, limit) => ipcRenderer.invoke('knowledge:retrieve', projectId, query, limit),
    processNext: (projectId) => ipcRenderer.invoke('knowledge:process-next', projectId),
    retryFailed: (projectId) => ipcRenderer.invoke('knowledge:retry-failed', projectId),
    listWiki: (projectId) => ipcRenderer.invoke('knowledge:list-wiki', projectId),
    saveWiki: (projectId, slug, content) => ipcRenderer.invoke('knowledge:save-wiki', projectId, slug, content)
  },
  wikiAutomation: {
    listReports: (projectId) => ipcRenderer.invoke('wiki-automation:list-reports', projectId),
    rescan: (projectId) => ipcRenderer.invoke('wiki-automation:rescan', projectId),
    retry: (projectId, jobId) => ipcRenderer.invoke('wiki-automation:retry', projectId, jobId)
  },
  knowledgeChat: {
    listSessions: (projectId) => ipcRenderer.invoke('knowledge-chat:list-sessions', projectId),
    createSession: (projectId) => ipcRenderer.invoke('knowledge-chat:create-session', projectId),
    listMessages: (projectId, sessionId) => ipcRenderer.invoke('knowledge-chat:list-messages', projectId, sessionId),
    listToolCalls: (projectId, sessionId) => ipcRenderer.invoke('knowledge-chat:list-tool-calls', projectId, sessionId),
    sendMessage: (projectId, sessionId, contentMarkdown) =>
      ipcRenderer.invoke('knowledge-chat:send-message', projectId, sessionId, contentMarkdown),
    listPendingActions: (projectId, sessionId) => ipcRenderer.invoke('knowledge-chat:list-pending-actions', projectId, sessionId),
    approvePendingAction: (projectId, sessionId, actionId) =>
      ipcRenderer.invoke('knowledge-chat:approve-pending-action', projectId, sessionId, actionId),
    rejectPendingAction: (projectId, sessionId, actionId) =>
      ipcRenderer.invoke('knowledge-chat:reject-pending-action', projectId, sessionId, actionId)
  },
  planning: {
    create: (projectId) => ipcRenderer.invoke('planning:create', projectId),
    get: (projectId, sessionId) => ipcRenderer.invoke('planning:get', projectId, sessionId),
    update: (projectId, sessionId, patch) => ipcRenderer.invoke('planning:update', projectId, sessionId, patch),
    convert: (projectId, sessionId) => ipcRenderer.invoke('planning:convert', projectId, sessionId),
    listMessages: (projectId, sessionId) => ipcRenderer.invoke('planning:list-messages', projectId, sessionId),
    addMessage: (projectId, sessionId, role, contentMarkdown) => ipcRenderer.invoke('planning:add-message', projectId, sessionId, role, contentMarkdown),
    context: (projectId, sessionId, query) => ipcRenderer.invoke('planning:context', projectId, sessionId, query),
    listAttachments: (projectId, sessionId) => ipcRenderer.invoke('planning:list-attachments', projectId, sessionId),
    attachBytes: (projectId, sessionId, input) => ipcRenderer.invoke('planning:attach-bytes', projectId, sessionId, input),
    pasteImage: (projectId, sessionId, input) => ipcRenderer.invoke('planning:paste-image', projectId, sessionId, input),
    removeAttachment: (projectId, sessionId, attachmentId) =>
      ipcRenderer.invoke('planning:remove-attachment', projectId, sessionId, attachmentId),
    previewAttachmentUrl: (projectId, sessionId, attachmentId) =>
      ipcRenderer.invoke('planning:preview-attachment-url', projectId, sessionId, attachmentId)
  },
  attachments: {
    list: (projectId, workItemId) => ipcRenderer.invoke('attachments:list', projectId, workItemId),
    attachBytes: (projectId, workItemId, input) =>
      ipcRenderer.invoke('attachments:attach-bytes', projectId, workItemId, input),
    pasteImage: (projectId, workItemId, input) =>
      ipcRenderer.invoke('attachments:paste-image', projectId, workItemId, input),
    remove: (projectId, workItemId, attachmentId) =>
      ipcRenderer.invoke('attachments:remove', projectId, workItemId, attachmentId),
    previewUrl: (projectId, workItemId, attachmentId) =>
      ipcRenderer.invoke('attachments:preview-url', projectId, workItemId, attachmentId)
  }
}

contextBridge.exposeInMainWorld('workstack', workstack)

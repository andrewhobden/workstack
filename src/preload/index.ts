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
    propose: (prompt, requestId) => ipcRenderer.invoke('ai:propose', prompt, requestId),
    proposePlanning: (projectId, sessionId, prompt, contextId, requestId) => ipcRenderer.invoke('ai:propose-planning', projectId, sessionId, prompt, contextId, requestId),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    get: (projectId) => ipcRenderer.invoke('projects:get', projectId),
    update: (projectId, updates) => ipcRenderer.invoke('projects:update', { projectId, ...updates }),
    reconnect: (projectId, rootPath) => ipcRenderer.invoke('projects:reconnect', projectId, rootPath),
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
    preflight: (projectId, workItemId) => ipcRenderer.invoke('work-items:preflight', projectId, workItemId),
    launchCopilot: (projectId, workItemId, prompt, approval) => ipcRenderer.invoke('work-items:launch-copilot', projectId, workItemId, prompt, approval),
    restack: (projectId, workItemId) => ipcRenderer.invoke('work-items:restack', projectId, workItemId),
    restart: (projectId, workItemId, approval) => ipcRenderer.invoke('work-items:restart', projectId, workItemId, approval),
    recover: (projectId, workItemId, input) => ipcRenderer.invoke('work-items:recover', projectId, workItemId, input),
    checkpoints: (projectId, workItemId) => ipcRenderer.invoke('work-items:checkpoints', projectId, workItemId),
    completionHistory: (projectId, workItemId) => ipcRenderer.invoke('work-items:completion-history', projectId, workItemId)
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
  semantic: {
    status: (projectId) => ipcRenderer.invoke('semantic:status', projectId),
    chooseModel: (projectId) => ipcRenderer.invoke('semantic:choose-model', projectId),
    disable: (projectId) => ipcRenderer.invoke('semantic:disable', projectId),
    reindex: (projectId) => ipcRenderer.invoke('semantic:reindex', projectId),
    cancel: (projectId, jobId) => ipcRenderer.invoke('semantic:cancel', projectId, jobId),
    retry: (projectId, jobId) => ipcRenderer.invoke('semantic:retry', projectId, jobId)
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
  taskDependencies: {
    get: (projectId, workItemId) => ipcRenderer.invoke('task-dependencies:get', projectId, workItemId),
    update: (projectId, workItemId, input) => ipcRenderer.invoke('task-dependencies:update', projectId, workItemId, input)
  },
  sourceCatalog: {
    previewRepository: (projectId) => ipcRenderer.invoke('source-catalog:preview-repository', projectId),
    importSelection: (projectId, input) => ipcRenderer.invoke('source-catalog:import-selection', projectId, input),
    refresh: (projectId, sourceId) => ipcRenderer.invoke('source-catalog:refresh', projectId, sourceId),
    list: (projectId) => ipcRenderer.invoke('source-catalog:list', projectId),
    detail: (projectId, sourceId) => ipcRenderer.invoke('source-catalog:detail', projectId, sourceId),
    setPolicy: (projectId, sourceId, policy, refreshSeconds) => ipcRenderer.invoke('source-catalog:set-policy', projectId, sourceId, policy, refreshSeconds),
    retry: (projectId, jobId) => ipcRenderer.invoke('source-catalog:retry', projectId, jobId),
    cancel: (projectId, jobId) => ipcRenderer.invoke('source-catalog:cancel', projectId, jobId),
    search: (projectId, query) => ipcRenderer.invoke('source-catalog:search', projectId, query),
    readRevision: (projectId, sourceId, revisionId, representation, offset) => ipcRenderer.invoke('source-catalog:read-revision', projectId, sourceId, revisionId, representation, offset),
    readCitation: (projectId, citation, neighbors) => ipcRenderer.invoke('source-catalog:read-citation', projectId, citation, neighbors)
  },
  knowledgeRecords: {
    list: (projectId) => ipcRenderer.invoke('knowledge-records:list', projectId),
    get: (projectId, recordId) => ipcRenderer.invoke('knowledge-records:get', projectId, recordId),
    create: (projectId, input, actor) => ipcRenderer.invoke('knowledge-records:create', projectId, input, actor),
    update: (projectId, recordId, input, actor, reason) => ipcRenderer.invoke('knowledge-records:update', projectId, recordId, input, actor, reason),
    checks: (projectId) => ipcRenderer.invoke('knowledge-records:checks', projectId),
    review: (projectId, recordId, actor, note, outcome, expectedVersion) => ipcRenderer.invoke('knowledge-records:review', projectId, recordId, actor, note, outcome, expectedVersion),
    supersede: (projectId, recordId, replacementId, actor, reason) => ipcRenderer.invoke('knowledge-records:supersede', projectId, recordId, replacementId, actor, reason),
    history: (projectId, recordId) => ipcRenderer.invoke('knowledge-records:history', projectId, recordId),
    reviews: (projectId, recordId) => ipcRenderer.invoke('knowledge-records:reviews', projectId, recordId)
  },
  projectDirectory: {
    list: (projectId) => ipcRenderer.invoke('project-directory:list', projectId),
    detail: (projectId, entityId) => ipcRenderer.invoke('project-directory:detail', projectId, entityId),
    lookup: (projectId, query) => ipcRenderer.invoke('project-directory:lookup', projectId, query),
    create: (projectId, input, actor) => ipcRenderer.invoke('project-directory:create', projectId, input, actor),
    update: (projectId, entityId, input, actor, reason) => ipcRenderer.invoke('project-directory:update', projectId, entityId, input, actor, reason),
    merge: (projectId, sourceId, targetId, input) => ipcRenderer.invoke('project-directory:merge', projectId, sourceId, targetId, input),
    split: (projectId, entityId, input) => ipcRenderer.invoke('project-directory:split', projectId, entityId, input),
    resolveMention: (projectId, mentionId, entityId, actor, reason) => ipcRenderer.invoke('project-directory:resolve-mention', projectId, mentionId, entityId, actor, reason)
  },
  contextPackets: {
    policy: (projectId) => ipcRenderer.invoke('context-packets:policy', projectId),
    updatePolicy: (projectId, input) => ipcRenderer.invoke('context-packets:update-policy', projectId, input),
    preferences: (projectId, workItemId) => ipcRenderer.invoke('context-packets:preferences', projectId, workItemId),
    updatePreferences: (projectId, workItemId, input) => ipcRenderer.invoke('context-packets:update-preferences', projectId, workItemId, input),
    preview: (projectId, workItemId, approval) => ipcRenderer.invoke('context-packets:preview', projectId, workItemId, approval),
    list: (projectId, workItemId) => ipcRenderer.invoke('context-packets:list', projectId, workItemId),
    get: (projectId, packetId) => ipcRenderer.invoke('context-packets:get', projectId, packetId),
    readSection: (projectId, packetId, category, offset) => ipcRenderer.invoke('context-packets:read-section', projectId, packetId, category, offset),
    usage: (projectId, packetId) => ipcRenderer.invoke('context-packets:usage', projectId, packetId)
  },
  contextFeedback: {
    create: (projectId, input) => ipcRenderer.invoke('context-feedback:create', projectId, input),
    list: (projectId, options) => ipcRenderer.invoke('context-feedback:list', projectId, options),
    triage: (projectId, feedbackId, input) => ipcRenderer.invoke('context-feedback:triage', projectId, feedbackId, input),
    history: (projectId, feedbackId) => ipcRenderer.invoke('context-feedback:history', projectId, feedbackId)
  },
  knowledgeDelivery: {
    list: (projectId) => ipcRenderer.invoke('knowledge-delivery:list', projectId),
    retry: (projectId, deliveryId) => ipcRenderer.invoke('knowledge-delivery:retry', projectId, deliveryId)
  },
  wikiRevisions: {
    list: (projectId) => ipcRenderer.invoke('wiki-revisions:list', projectId),
    review: (projectId, revisionId) => ipcRenderer.invoke('wiki-revisions:review', projectId, revisionId),
    publish: (projectId, revisionId, actor, note) => ipcRenderer.invoke('wiki-revisions:publish', projectId, revisionId, actor, note),
    reject: (projectId, revisionId, actor, reason) => ipcRenderer.invoke('wiki-revisions:reject', projectId, revisionId, actor, reason),
    reconcile: (projectId, revisionId, actor, reason) => ipcRenderer.invoke('wiki-revisions:reconcile', projectId, revisionId, actor, reason),
    restore: (projectId, revisionId, actor, reason) => ipcRenderer.invoke('wiki-revisions:restore', projectId, revisionId, actor, reason)
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
    sendMessage: (projectId, sessionId, contentMarkdown, requestId) =>
      ipcRenderer.invoke('knowledge-chat:send-message', projectId, sessionId, contentMarkdown, requestId),
    listPendingActions: (projectId, sessionId) => ipcRenderer.invoke('knowledge-chat:list-pending-actions', projectId, sessionId),
    approvePendingAction: (projectId, sessionId, actionId) =>
      ipcRenderer.invoke('knowledge-chat:approve-pending-action', projectId, sessionId, actionId),
    rejectPendingAction: (projectId, sessionId, actionId) =>
      ipcRenderer.invoke('knowledge-chat:reject-pending-action', projectId, sessionId, actionId)
  },
  planning: {
    listSessions: (projectId) => ipcRenderer.invoke('planning:list-sessions', projectId),
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

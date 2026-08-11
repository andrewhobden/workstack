import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/desktop-api'

const workstack: DesktopApi = {
  system: {
    appVersion: (): Promise<string> => ipcRenderer.invoke('system:app-version')
  },
  ai: {
    settings: () => ipcRenderer.invoke('ai:settings'),
    configure: (input) => ipcRenderer.invoke('ai:configure', input),
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
    delete: (projectId, workItemId) => ipcRenderer.invoke('work-items:delete', projectId, workItemId)
  },
  activity: {
    list: (projectId) => ipcRenderer.invoke('activity:list', projectId)
  },
  claims: {
    list: (projectId) => ipcRenderer.invoke('claims:list', projectId),
    get: (projectId, workItemId) => ipcRenderer.invoke('claims:get', projectId, workItemId),
    forceRelease: (projectId, workItemId, input) =>
      ipcRenderer.invoke('claims:force-release', projectId, workItemId, input),
    getCompletion: (projectId, workItemId) => ipcRenderer.invoke('claims:get-completion', projectId, workItemId)
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

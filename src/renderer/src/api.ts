import type { BinaryAttachmentPayload, DesktopApi, CreateProjectInput } from '../../shared/desktop-api'
import type { KnowledgeSearchResult, KnowledgeSourceInput } from '../../shared/desktop-api'
import type { KnowledgeSource, WikiArticle } from '../../core/knowledge'
import type {
  Attachment,
  ActivityEvent,
  CompletionRecord,
  CreateWorkItemInput,
  ProjectMetadata,
  ProjectSettings,
  ProjectSummary,
  UpdateProjectInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemFilters,
  WorkClaim
} from '../../core/types'
import type { PlanningMessage, PlanningProposal } from '../../core/types'

interface BrowserState {
  projects: ProjectMetadata[]
  workItemsByProject: Record<string, WorkItem[]>
  claimsByWorkItem: Record<string, WorkClaim[]>
  knowledgeByProject: Record<string, BrowserKnowledgeSource[]>
  planningByProject: Record<string, Record<string, PlanningProposal>>
  planningMessagesBySession: Record<string, PlanningMessage[]>
  wikiByProject: Record<string, WikiArticle[]>
  attachmentsByWorkItem: Record<string, BrowserAttachment[]>
  completionsByWorkItem: Record<string, CompletionRecord>
  activityByProject: Record<string, ActivityEvent[]>
}

interface BrowserAttachment extends Attachment {
  previewUrl: string
}

interface BrowserKnowledgeSource extends KnowledgeSource {
  content: string
}

const browserStorageKey = 'workstack-browser-state'

export function getDesktopApi(): DesktopApi {
  return window.workstack ?? browserDesktopApi
}

const browserDesktopApi: DesktopApi = {
  system: {
    appVersion: async () => '0.1.0'
  },
  ai: {
    settings: async () => ({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', configured: false }),
    configure: async (input) => ({ baseUrl: input.baseUrl, model: input.model, configured: Boolean(input.apiKey) }),
    propose: async (prompt) => `Suggested planning notes for: ${prompt}`
  },
  projects: {
    list: async () => summaries(loadState()),
    create: async (input) => {
      const state = loadState()
      const now = new Date().toISOString()
      const project: ProjectMetadata = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        rootPath: input.rootPath,
        settings: defaultSettings(input.workItemPrefix ?? derivePrefix(input.name)),
        createdAt: now,
        updatedAt: now
      }
      state.projects.push(project)
      state.workItemsByProject[project.id] = []
      state.knowledgeByProject[project.id] = []
      state.planningByProject[project.id] = {}
      state.planningMessagesBySession[project.id] = []
      state.wikiByProject[project.id] = []
      state.activityByProject[project.id] = []
      saveState(state)
      return toSummary(project, [])
    },
    get: async (projectId) => clone(requireProject(loadState(), projectId)),
    update: async (projectId, updates) => {
      const state = loadState()
      const project = requireProject(state, projectId)
      applyProjectUpdate(project, updates)
      saveState(state)
      return toSummary(project, state.workItemsByProject[projectId] ?? [])
    },
    detach: async (projectId) => {
      const state = loadState()
      const index = state.projects.findIndex((project) => project.id === projectId)
      if (index === -1) {
        throw new Error('Project not found.')
      }
      state.projects.splice(index, 1)
      for (const item of state.workItemsByProject[projectId] ?? []) {
        delete state.claimsByWorkItem[item.id]
      }
      delete state.workItemsByProject[projectId]
      delete state.knowledgeByProject[projectId]
      delete state.planningByProject[projectId]
      saveState(state)
    },
    chooseFolder: async () => '/tmp/workstack-project',
    openFolder: async (projectId) => {
      requireProject(loadState(), projectId)
    }
  },
  workItems: {
    list: async (projectId, filters = {}) => {
      const state = loadState()
      requireProject(state, projectId)
      return filterWorkItems(state.workItemsByProject[projectId] ?? [], filters)
    },
    create: async (projectId, input) => {
      const state = loadState()
      const project = requireProject(state, projectId)
      const items = state.workItemsByProject[projectId] ?? []
      const now = new Date().toISOString()
      const workItem: WorkItem = {
        id: crypto.randomUUID(),
        sequenceNumber: items.length + 1,
        displayId: `${project.settings.workItemPrefix}-${items.length + 1}`,
        type: input.type ?? 'feature',
        title: input.title.trim(),
        descriptionMarkdown: input.descriptionMarkdown ?? '',
        acceptanceCriteriaMarkdown: input.acceptanceCriteriaMarkdown ?? '',
        priority: input.priority ?? 'normal',
        status: 'backlog',
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      }
      items.push(workItem)
      state.workItemsByProject[projectId] = items
      state.activityByProject[projectId] ??= []
      state.activityByProject[projectId].unshift({
        id: crypto.randomUUID(), eventType: 'work_item_created', actorType: 'human', actorId: workItem.createdBy,
        workItemId: workItem.id, payload: { displayId: workItem.displayId }, createdAt: now
      })
      saveState(state)
      return clone(workItem)
    },
    get: async (projectId, workItemId) => clone(requireWorkItem(loadState(), projectId, workItemId)),
    update: async (projectId, workItemId, patch) => {
      const state = loadState()
      const workItem = requireWorkItem(state, projectId, workItemId)
      applyWorkItemUpdate(workItem, patch)
      saveState(state)
      return clone(workItem)
    },
    delete: async (projectId, workItemId) => {
      const state = loadState()
      const items = state.workItemsByProject[projectId] ?? []
      const index = items.findIndex((item) => item.id === workItemId)
      if (index === -1) {
        throw new Error('Work item not found.')
      }
      items.splice(index, 1)
      saveState(state)
    }
  },
  activity: {
    list: async (projectId) => {
      const state = loadState()
      requireProject(state, projectId)
      return clone(state.activityByProject[projectId] ?? [])
    }
  },
  claims: {
    list: async (projectId) => {
      const state = loadState()
      const items = state.workItemsByProject[projectId] ?? []
      requireProject(state, projectId)
      normalizeExpiredBrowserClaims(state, items)
      saveState(state)
      return items.flatMap((item) => (state.claimsByWorkItem[item.id] ?? []).filter((claim) => claim.state === 'active')).map(clone)
    },
    get: async (projectId, workItemId) => {
      const state = loadState()
      const item = requireWorkItem(state, projectId, workItemId)
      normalizeExpiredBrowserClaims(state, [item])
      saveState(state)
      return clone((state.claimsByWorkItem[workItemId] ?? []).find((claim) => claim.state === 'active'))
    },
    getCompletion: async (projectId, workItemId) => {
      const state = loadState()
      requireWorkItem(state, projectId, workItemId)
      return clone(state.completionsByWorkItem[workItemId])
    },
    forceRelease: async (projectId, workItemId, input) => {
      const state = loadState()
      const item = requireWorkItem(state, projectId, workItemId)
      normalizeExpiredBrowserClaims(state, [item])
      const claim = (state.claimsByWorkItem[workItemId] ?? []).find((candidate) => candidate.state === 'active')
      const reason = input.reason.trim()
      if (!claim || !reason) {
        throw new Error('There is no active claim to release.')
      }
      const now = new Date().toISOString()
      claim.state = 'released'
      claim.releaseReason = reason
      claim.releasedAt = now
      item.status = 'backlog'
      item.updatedAt = now
      saveState(state)
      return clone(claim)
    }
  },
  knowledge: {
    listSources: async (projectId) => {
      const state = loadState()
      requireProject(state, projectId)
      return (state.knowledgeByProject[projectId] ?? []).map(toKnowledgeSource)
    },
    addSource: async (projectId, input) => createBrowserKnowledgeSource(projectId, input),
    search: async (projectId, query) => {
      const state = loadState()
      requireProject(state, projectId)
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      return [
        ...(state.knowledgeByProject[projectId] ?? []),
        ...(state.wikiByProject[projectId] ?? []).map((article) => ({
          id: `wiki:${article.slug}`,
          displayName: `Wiki: ${article.slug}`,
          content: article.content
        }))
      ]
        .filter((source) => terms.some((term) => `${source.displayName}\n${source.content}`.toLowerCase().includes(term)))
        .map((source, index): KnowledgeSearchResult => ({
          sourceId: source.id,
          title: source.displayName,
          excerpt: source.content.slice(0, 180),
          score: 1 / (index + 1)
        }))
    },
    processNext: async (projectId) => {
      requireProject(loadState(), projectId)
      return undefined
    },
    retryFailed: async (projectId) => {
      requireProject(loadState(), projectId)
      return 0
    },
    listWiki: async (projectId) => {
      const state = loadState()
      requireProject(state, projectId)
      return clone(state.wikiByProject[projectId] ?? [])
    },
    saveWiki: async (projectId, slug, content) => {
      const state = loadState()
      requireProject(state, projectId)
      const article = { slug: slug.trim().toLowerCase(), content }
      const articles = state.wikiByProject[projectId] ?? []
      const index = articles.findIndex((candidate) => candidate.slug === article.slug)
      if (index === -1) articles.push(article)
      else articles[index] = article
      state.wikiByProject[projectId] = articles
      saveState(state)
      return clone(article)
    }
  },
  planning: {
    create: async (projectId) => {
      const state = loadState()
      requireProject(state, projectId)
      const now = new Date().toISOString()
      const proposal: PlanningProposal = {
        planningSessionId: crypto.randomUUID(), title: '', type: 'feature', descriptionMarkdown: '',
        requirementsMarkdown: '', acceptanceCriteriaMarkdown: '', implementationContextMarkdown: '',
        relatedReferences: [], priority: 'normal', userModifiedFields: [], revision: 0, updatedAt: now
      }
      state.planningByProject[projectId] ??= {}
      state.planningByProject[projectId][proposal.planningSessionId] = proposal
      saveState(state)
      return clone(proposal)
    },
    get: async (projectId, sessionId) => clone(requirePlanningProposal(loadState(), projectId, sessionId)),
    update: async (projectId, sessionId, patch) => {
      const state = loadState()
      const proposal = requirePlanningProposal(state, projectId, sessionId)
      Object.assign(proposal, patch)
      proposal.userModifiedFields = [...new Set([...proposal.userModifiedFields, ...Object.keys(patch)])]
      proposal.revision += 1
      proposal.updatedAt = new Date().toISOString()
      saveState(state)
      return clone(proposal)
    },
    convert: async (projectId, sessionId) => {
      const state = loadState()
      const proposal = requirePlanningProposal(state, projectId, sessionId)
      if (!proposal.title.trim()) throw new Error('A proposal title is required before adding it to the backlog.')
      delete state.planningByProject[projectId][sessionId]
      saveState(state)
      const item = await browserDesktopApi.workItems.create(projectId, {
        title: proposal.title, type: proposal.type, descriptionMarkdown: proposal.descriptionMarkdown,
        acceptanceCriteriaMarkdown: proposal.acceptanceCriteriaMarkdown, priority: proposal.priority, source: 'ai_plan'
      })
      return item
    },
    listMessages: async (projectId, sessionId) => {
      const state = loadState()
      requirePlanningProposal(state, projectId, sessionId)
      return clone(state.planningMessagesBySession[sessionId] ?? [])
    },
    addMessage: async (projectId, sessionId, role, contentMarkdown) => {
      const state = loadState()
      requirePlanningProposal(state, projectId, sessionId)
      const content = contentMarkdown.trim()
      if (!content) throw new Error('A planning message cannot be empty.')
      const message: PlanningMessage = { id: crypto.randomUUID(), planningSessionId: sessionId, role, contentMarkdown: content, createdAt: new Date().toISOString() }
      state.planningMessagesBySession[sessionId] ??= []
      state.planningMessagesBySession[sessionId].push(message)
      saveState(state)
      return clone(message)
    }
  },
  attachments: {
    list: async (projectId, workItemId) => {
      const state = loadState()
      requireWorkItem(state, projectId, workItemId)
      return (state.attachmentsByWorkItem[workItemId] ?? []).map(toAttachment)
    },
    attachBytes: async (projectId, workItemId, input) => createBrowserAttachment(projectId, workItemId, input),
    pasteImage: async (projectId, workItemId, input) => {
      const attachment = await createBrowserAttachment(projectId, workItemId, input)
      const state = loadState()
      const workItem = requireWorkItem(state, projectId, workItemId)
      const markdown = `![${attachment.originalFilename}](attachments/${attachment.storedRelativePath.split('/').at(-1)})`
      workItem.descriptionMarkdown = workItem.descriptionMarkdown
        ? `${workItem.descriptionMarkdown}\n\n${markdown}`
        : markdown
      workItem.updatedAt = new Date().toISOString()
      saveState(state)
      return attachment
    },
    remove: async (projectId, workItemId, attachmentId) => {
      const state = loadState()
      requireWorkItem(state, projectId, workItemId)
      const attachments = state.attachmentsByWorkItem[workItemId] ?? []
      const index = attachments.findIndex((attachment) => attachment.id === attachmentId)
      if (index === -1) {
        throw new Error('Attachment not found.')
      }
      attachments.splice(index, 1)
      saveState(state)
    },
    previewUrl: async (projectId, workItemId, attachmentId) => {
      const state = loadState()
      requireWorkItem(state, projectId, workItemId)
      const attachment = (state.attachmentsByWorkItem[workItemId] ?? []).find(
        (candidate) => candidate.id === attachmentId
      )
      if (!attachment) {
        throw new Error('Attachment not found.')
      }
      return attachment.previewUrl
    }
  }
}

function loadState(): BrowserState {
  const stored = window.localStorage.getItem(browserStorageKey)
  if (!stored) {
    return { projects: [], workItemsByProject: {}, claimsByWorkItem: {}, knowledgeByProject: {}, planningByProject: {}, planningMessagesBySession: {}, wikiByProject: {}, attachmentsByWorkItem: {}, completionsByWorkItem: {}, activityByProject: {} }
  }
  const state = JSON.parse(stored) as BrowserState
  state.claimsByWorkItem ??= {}
  state.knowledgeByProject ??= {}
  state.planningByProject ??= {}
  state.planningMessagesBySession ??= {}
  state.wikiByProject ??= {}
  state.attachmentsByWorkItem ??= {}
  state.completionsByWorkItem ??= {}
  state.activityByProject ??= {}
  return state
}

function saveState(state: BrowserState): void {
  window.localStorage.setItem(browserStorageKey, JSON.stringify(state))
}

function summaries(state: BrowserState): ProjectSummary[] {
  return state.projects
    .map((project) => toSummary(project, state.workItemsByProject[project.id] ?? []))
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
}

function toSummary(project: ProjectMetadata, items: WorkItem[]): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    rootPath: project.rootPath,
    lastOpenedAt: project.updatedAt,
    backlogCount: items.filter((item) => item.status === 'backlog').length,
    inProgressCount: items.filter((item) => item.status === 'in_progress').length,
    completedCount: items.filter((item) => item.status === 'completed').length
  }
}

function requireProject(state: BrowserState, projectId: string): ProjectMetadata {
  const project = state.projects.find((candidate) => candidate.id === projectId)
  if (!project) {
    throw new Error('Project not found.')
  }
  return project
}

function requireWorkItem(state: BrowserState, projectId: string, workItemId: string): WorkItem {
  requireProject(state, projectId)
  const workItem = (state.workItemsByProject[projectId] ?? []).find((candidate) => candidate.id === workItemId)
  if (!workItem) {
    throw new Error('Work item not found.')
  }

  return workItem
}

function requirePlanningProposal(state: BrowserState, projectId: string, sessionId: string): PlanningProposal {
  requireProject(state, projectId)
  const proposal = state.planningByProject[projectId]?.[sessionId]
  if (!proposal) throw new Error('Planning proposal not found.')
  return proposal
}

async function createBrowserAttachment(
  projectId: string,
  workItemId: string,
  input: BinaryAttachmentPayload
): Promise<Attachment> {
  const state = loadState()
  requireWorkItem(state, projectId, workItemId)
  if (input.data.byteLength === 0) {
    throw new Error('Attachment data cannot be empty.')
  }
  const id = crypto.randomUUID()
  const storedFilename = `${id}-${safeFilename(input.originalFilename)}`
  const attachment: BrowserAttachment = {
    id,
    workItemId,
    originalFilename: input.originalFilename,
    storedRelativePath: `work-items/${workItemId}/attachments/${storedFilename}`,
    mimeType: input.mimeType ?? 'application/octet-stream',
    sizeBytes: input.data.byteLength,
    sha256: null,
    createdAt: new Date().toISOString(),
    previewUrl: `data:${input.mimeType ?? 'application/octet-stream'};base64,${toBase64(input.data)}`
  }
  const attachments = state.attachmentsByWorkItem[workItemId] ?? []
  attachments.push(attachment)
  state.attachmentsByWorkItem[workItemId] = attachments
  saveState(state)
  return toAttachment(attachment)
}

function applyProjectUpdate(project: ProjectMetadata, updates: UpdateProjectInput): void {
  if (updates.name !== undefined) {
    project.name = updates.name.trim()
  }
  if (updates.description !== undefined) {
    project.description = updates.description.trim()
  }
  if (updates.settings !== undefined) {
    project.settings = { ...project.settings, ...updates.settings }
  }
  project.updatedAt = new Date().toISOString()
}

function applyWorkItemUpdate(workItem: WorkItem, patch: UpdateWorkItemInput): void {
  if (patch.type !== undefined) {
    workItem.type = patch.type
  }
  if (patch.title !== undefined) {
    workItem.title = patch.title.trim()
  }
  if (patch.descriptionMarkdown !== undefined) {
    workItem.descriptionMarkdown = patch.descriptionMarkdown
  }
  if (patch.acceptanceCriteriaMarkdown !== undefined) {
    workItem.acceptanceCriteriaMarkdown = patch.acceptanceCriteriaMarkdown
  }
  if (patch.priority !== undefined) {
    workItem.priority = patch.priority
  }
  workItem.updatedAt = new Date().toISOString()
}

function filterWorkItems(items: WorkItem[], filters: WorkItemFilters): WorkItem[] {
  const query = filters.query?.trim().toLowerCase()
  return items
    .filter((item) => !filters.status || item.status === filters.status)
    .filter((item) => !filters.type || item.type === filters.type)
    .filter((item) => !filters.priority || item.priority === filters.priority)
    .filter((item) => !filters.source || item.source === filters.source)
    .filter(
      (item) =>
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.descriptionMarkdown.toLowerCase().includes(query) ||
        item.acceptanceCriteriaMarkdown.toLowerCase().includes(query)
    )
    .sort((left, right) => right.sequenceNumber - left.sequenceNumber)
    .slice(0, filters.limit)
    .map(clone)
}

function normalizeExpiredBrowserClaims(state: BrowserState, items: WorkItem[]): void {
  const now = Date.now()
  for (const item of items) {
    for (const claim of state.claimsByWorkItem[item.id] ?? []) {
      if (claim.state === 'active' && new Date(claim.leaseExpiresAt).getTime() <= now) {
        claim.state = 'expired'
        item.status = 'backlog'
        item.updatedAt = new Date(now).toISOString()
      }
    }
  }
}

function defaultSettings(workItemPrefix: string): ProjectSettings {
  return {
    workItemPrefix,
    defaultLeaseSeconds: 1800,
    heartbeatSeconds: 300,
    autoReleaseExpiredClaims: true,
    autoUpdateKnowledgeOnCompletion: true
  }
}

function derivePrefix(name: string): string {
  const prefix = name
    .toUpperCase()
    .match(/[A-Z0-9]+/g)
    ?.join('')
    .slice(0, 6)
  return prefix || 'WS'
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function toAttachment(attachment: BrowserAttachment): Attachment {
  return clone({
    id: attachment.id,
    workItemId: attachment.workItemId,
    originalFilename: attachment.originalFilename,
    storedRelativePath: attachment.storedRelativePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt
  })
}

function safeFilename(filename: string): string {
  const safe = filename.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '')
  return safe || 'attachment'
}

function createBrowserKnowledgeSource(projectId: string, input: KnowledgeSourceInput): KnowledgeSource {
  const state = loadState()
  requireProject(state, projectId)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const source: BrowserKnowledgeSource = {
    id,
    kind: 'manual',
    displayName: input.displayName.trim(),
    relativeOrExternalLocation: `knowledge/raw/${id}-${safeFilename(input.filename)}`,
    status: 'indexed',
    createdAt: now,
    updatedAt: now,
    content: input.content
  }
  const sources = state.knowledgeByProject[projectId] ?? []
  sources.push(source)
  state.knowledgeByProject[projectId] = sources
  saveState(state)
  return toKnowledgeSource(source)
}

function toKnowledgeSource(source: BrowserKnowledgeSource): KnowledgeSource {
  return clone({
    id: source.id,
    kind: source.kind,
    displayName: source.displayName,
    relativeOrExternalLocation: source.relativeOrExternalLocation,
    status: source.status,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return window.btoa(binary)
}

export type { CreateProjectInput, CreateWorkItemInput }

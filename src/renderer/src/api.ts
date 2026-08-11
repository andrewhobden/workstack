import type { BinaryAttachmentPayload, DesktopApi, CreateProjectInput } from '../../shared/desktop-api'
import type { KnowledgeSearchResult, KnowledgeSourceInput } from '../../shared/desktop-api'
import type {
  KnowledgeRetrievalResult,
  KnowledgeRetrievalSourceType,
  KnowledgeSource,
  ProjectKnowledgeRetrieval,
  WikiArticle
} from '../../core/knowledge'
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
import type { PlanningContext, PlanningMessage, PlanningProposal } from '../../core/types'

interface BrowserState {
  projects: ProjectMetadata[]
  workItemsByProject: Record<string, WorkItem[]>
  claimsByWorkItem: Record<string, WorkClaim[]>
  knowledgeByProject: Record<string, BrowserKnowledgeSource[]>
  planningByProject: Record<string, Record<string, PlanningProposal>>
  planningMessagesBySession: Record<string, PlanningMessage[]>
  wikiByProject: Record<string, WikiArticle[]>
  attachmentsByWorkItem: Record<string, BrowserAttachment[]>
  attachmentsByPlanningSession: Record<string, BrowserAttachment[]>
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
    propose: async (prompt) => `Suggested planning notes for: ${prompt}`,
    proposePlanning: async (projectId, sessionId, prompt) => {
      const context = await browserDesktopApi.planning.context(projectId, sessionId, prompt)
      return `Suggested planning notes for: ${prompt}\n\nUsing ${context.knowledge.length + context.completedWork.length + context.backlogOverlap.length} relevant project records.`
    }
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
    delete: async (projectId, input) => {
      if (input.confirmed !== true) {
        throw new Error('Project deletion requires explicit confirmation.')
      }
      const state = loadState()
      const project = requireProject(state, projectId)
      const index = state.projects.findIndex((candidate) => candidate.id === projectId)
      state.projects.splice(index, 1)
      for (const item of state.workItemsByProject[projectId] ?? []) {
        delete state.claimsByWorkItem[item.id]
      }
      delete state.workItemsByProject[projectId]
      delete state.knowledgeByProject[projectId]
      delete state.planningByProject[projectId]
      saveState(state)
      return { backupPath: `/workstack-browser-backups/project-deletions/${project.id}/.workstack` }
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
    retrieve: async (projectId, query, limit) => browserKnowledgeRetrieval(loadState(), projectId, query, limit),
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
    },
    context: async (projectId, sessionId, query) => browserPlanningContext(loadState(), projectId, sessionId, query),
    listAttachments: async (projectId, sessionId) => {
      const state = loadState()
      requirePlanningProposal(state, projectId, sessionId)
      return (state.attachmentsByPlanningSession[sessionId] ?? []).map(toAttachment)
    },
    attachBytes: async (projectId, sessionId, input) => createBrowserPlanningAttachment(projectId, sessionId, input),
    pasteImage: async (projectId, sessionId, input) => createBrowserPlanningAttachment(projectId, sessionId, input),
    removeAttachment: async (projectId, sessionId, attachmentId) => {
      const state = loadState()
      requirePlanningProposal(state, projectId, sessionId)
      const attachments = state.attachmentsByPlanningSession[sessionId] ?? []
      const index = attachments.findIndex((attachment) => attachment.id === attachmentId)
      if (index === -1) throw new Error('Attachment not found.')
      attachments.splice(index, 1)
      saveState(state)
    },
    previewAttachmentUrl: async (projectId, sessionId, attachmentId) => {
      const state = loadState()
      requirePlanningProposal(state, projectId, sessionId)
      const attachment = (state.attachmentsByPlanningSession[sessionId] ?? []).find((candidate) => candidate.id === attachmentId)
      if (!attachment) throw new Error('Attachment not found.')
      return attachment.previewUrl
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
    return { projects: [], workItemsByProject: {}, claimsByWorkItem: {}, knowledgeByProject: {}, planningByProject: {}, planningMessagesBySession: {}, wikiByProject: {}, attachmentsByWorkItem: {}, attachmentsByPlanningSession: {}, completionsByWorkItem: {}, activityByProject: {} }
  }
  const state = JSON.parse(stored) as BrowserState
  state.claimsByWorkItem ??= {}
  state.knowledgeByProject ??= {}
  state.planningByProject ??= {}
  state.planningMessagesBySession ??= {}
  state.wikiByProject ??= {}
  state.attachmentsByWorkItem ??= {}
  state.attachmentsByPlanningSession ??= {}
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
    planningSessionId: null,
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

function browserKnowledgeRetrieval(state: BrowserState, projectId: string, query: string, limit = 40): ProjectKnowledgeRetrieval {
  requireProject(state, projectId)
  const normalized = query.trim()
  const candidates: BrowserRetrievalCandidate[] = [
    ...(state.wikiByProject[projectId] ?? []).map((article) => ({
      sourceId: `wiki:${article.slug}`,
      sourceType: 'wiki_article' as const,
      title: article.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ? `Wiki: ${article.content.match(/^#\s+(.+)$/m)?.[1]?.trim()}` : `Wiki: ${article.slug}`,
      content: article.content,
      location: `knowledge/wiki/${article.slug}.md`
    })),
    ...(state.knowledgeByProject[projectId] ?? [])
      .filter((source) => source.kind !== 'work_completion')
      .map((source) => ({
        sourceId: `raw:${source.id}`,
        sourceType: 'raw_source' as const,
        title: source.displayName,
        content: source.content,
        location: source.relativeOrExternalLocation
      })),
    ...(state.workItemsByProject[projectId] ?? [])
      .filter((item) => item.status === 'completed')
      .map((item) => ({
        sourceId: `completed:${item.id}`,
        sourceType: 'completed_work' as const,
        title: `${item.displayId} · ${item.title}`,
        content: `${item.title}\n${item.descriptionMarkdown}\n${item.acceptanceCriteriaMarkdown}\n${state.completionsByWorkItem[item.id]?.summaryMarkdown ?? ''}\n${state.completionsByWorkItem[item.id]?.validationMarkdown ?? ''}`,
        location: `work-items/${item.id}/completion.md`,
        workItemId: item.id
      })),
    ...(state.workItemsByProject[projectId] ?? [])
      .filter((item) => item.status === 'backlog')
      .map((item) => ({
        sourceId: `backlog:${item.id}`,
        sourceType: 'backlog' as const,
        title: `${item.displayId} · ${item.title}`,
        content: `${item.title}\n${item.descriptionMarkdown}\n${item.acceptanceCriteriaMarkdown}`,
        location: `work-items/${item.id}/work-item.md`,
        workItemId: item.id
      }))
  ]
  const results = candidates
    .map(({ content, ...candidate }) => ({
      ...candidate,
      excerpt: browserExcerpt(content, normalized),
      relevance: browserRelevance(`${candidate.title}\n${content}`, normalized)
    }))
    .filter((result) => result.relevance > 0)
    .sort(browserCompareResults)
    .slice(0, limit)
  return { query: normalized, results, groups: browserRetrievalGroups(results) }
}

interface BrowserRetrievalCandidate extends Omit<KnowledgeRetrievalResult, 'excerpt' | 'relevance'> {
  content: string
}

function browserExcerpt(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] ?? '')
  return content.slice(index < 0 ? 0 : Math.max(0, index - 40), (index < 0 ? 0 : Math.max(0, index - 40)) + 220).trim()
}

function browserRelevance(content: string, query: string): number {
  const normalizedContent = content.toLowerCase()
  const normalizedQuery = query.toLowerCase()
  const terms = [...new Set(normalizedQuery.match(/[a-z0-9_-]+/g) ?? [])]
  if (!terms.some((term) => normalizedContent.includes(term))) return 0
  const occurrences = (value: string): number => {
    let count = 0
    let start = 0
    while (true) {
      const index = normalizedContent.indexOf(value, start)
      if (index === -1) return count
      count += 1
      start = index + value.length
    }
  }
  const title = content.split('\n', 1)[0].toLowerCase()
  const titleMatches = terms.reduce((total, term) => total + [...title.matchAll(new RegExp(term, 'g'))].length, 0)
  return occurrences(normalizedQuery) * 100 + titleMatches * 20 + terms.reduce((total, term) => total + occurrences(term), 0)
}

function browserCompareResults(left: KnowledgeRetrievalResult, right: KnowledgeRetrievalResult): number {
  if (right.relevance !== left.relevance) return right.relevance - left.relevance
  const order: KnowledgeRetrievalSourceType[] = ['wiki_article', 'raw_source', 'completed_work', 'backlog']
  const typeOrder = order.indexOf(left.sourceType) - order.indexOf(right.sourceType)
  if (typeOrder !== 0) return typeOrder
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
}

function browserRetrievalGroups(results: KnowledgeRetrievalResult[]): ProjectKnowledgeRetrieval['groups'] {
  const labels: Record<KnowledgeRetrievalSourceType, string> = {
    wiki_article: 'Wiki articles',
    raw_source: 'Raw sources',
    completed_work: 'Completed work',
    backlog: 'Backlog'
  }
  return (['wiki_article', 'raw_source', 'completed_work', 'backlog'] as const).map((sourceType) => ({
    sourceType,
    label: labels[sourceType],
    results: results.filter((result) => result.sourceType === sourceType)
  }))
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
    planningSessionId: attachment.planningSessionId,
    originalFilename: attachment.originalFilename,
    storedRelativePath: attachment.storedRelativePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt
  })
}

async function createBrowserPlanningAttachment(
  projectId: string,
  sessionId: string,
  input: BinaryAttachmentPayload
): Promise<Attachment> {
  const state = loadState()
  requirePlanningProposal(state, projectId, sessionId)
  if (input.data.byteLength === 0) throw new Error('Attachment data cannot be empty.')
  const id = crypto.randomUUID()
  const storedFilename = `${id}-${safeFilename(input.originalFilename)}`
  const attachment: BrowserAttachment = {
    id,
    workItemId: null,
    planningSessionId: sessionId,
    originalFilename: input.originalFilename,
    storedRelativePath: `planning-sessions/${sessionId}/attachments/${storedFilename}`,
    mimeType: input.mimeType ?? 'application/octet-stream',
    sizeBytes: input.data.byteLength,
    sha256: null,
    createdAt: new Date().toISOString(),
    previewUrl: `data:${input.mimeType ?? 'application/octet-stream'};base64,${toBase64(input.data)}`
  }
  const attachments = state.attachmentsByPlanningSession[sessionId] ?? []
  attachments.push(attachment)
  state.attachmentsByPlanningSession[sessionId] = attachments
  saveState(state)
  return toAttachment(attachment)
}

function browserPlanningContext(state: BrowserState, projectId: string, sessionId: string, query: string): PlanningContext {
  const project = requireProject(state, projectId)
  const proposal = requirePlanningProposal(state, projectId, sessionId)
  const normalizedQuery = query.trim().toLowerCase()
  const workQuery = normalizedQuery.split(/\s+/).find((term) => term.length > 2) ?? normalizedQuery
  const matches = (value: string, useWorkQuery = false): boolean =>
    Boolean(useWorkQuery ? workQuery : normalizedQuery) && value.toLowerCase().includes(useWorkQuery ? workQuery : normalizedQuery)
  const workEvidence = (kind: 'completed_work' | 'backlog_overlap', item: WorkItem) => ({
    kind,
    sourceId: item.id,
    title: `${item.displayId} · ${item.title}`,
    excerpt: item.descriptionMarkdown || item.acceptanceCriteriaMarkdown || 'No written details.',
    metadata: { status: item.status, priority: item.priority, type: item.type }
  })
  return {
    project: { id: project.id, name: project.name, description: project.description, rootPath: project.rootPath },
    proposal: clone(proposal),
    knowledge: (state.knowledgeByProject[projectId] ?? [])
      .filter((source) => matches(`${source.displayName} ${source.content}`))
      .slice(0, 5)
      .map((source, index) => ({
        kind: 'knowledge' as const,
        sourceId: source.id,
        title: source.displayName,
        excerpt: source.content.slice(0, 220),
        metadata: { score: 1 / (index + 1) }
      })),
    completedWork: (state.workItemsByProject[projectId] ?? [])
      .filter((item) => item.status === 'completed' && matches(`${item.title} ${item.descriptionMarkdown} ${item.acceptanceCriteriaMarkdown}`, true))
      .slice(0, 5).map((item) => workEvidence('completed_work', item)),
    backlogOverlap: (state.workItemsByProject[projectId] ?? [])
      .filter((item) => item.status === 'backlog' && matches(`${item.title} ${item.descriptionMarkdown} ${item.acceptanceCriteriaMarkdown}`, true))
      .slice(0, 5).map((item) => workEvidence('backlog_overlap', item)),
    planningAttachments: (state.attachmentsByPlanningSession[sessionId] ?? []).map((attachment) => ({
      kind: 'planning_attachment' as const,
      sourceId: attachment.id,
      title: attachment.originalFilename,
      excerpt: 'Attached planning evidence. File contents are not included automatically.',
      metadata: { mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 }
    }))
  }
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

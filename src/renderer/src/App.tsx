import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { getDesktopApi } from './api'
import type { DesktopApi } from '../../shared/desktop-api'
import type {
  Attachment,
  CompletionRecord,
  CreateWorkItemInput,
  ProjectMetadata,
  ProjectSummary,
  UpdateWorkItemInput,
  WorkItem,
  WorkClaim
} from '../../core/types'
import type { PlanningContext, PlanningProposal } from '../../core/types'
import type { KnowledgeSource } from '../../core/knowledge'
import type { KnowledgeRetrievalResult, ProjectKnowledgeRetrieval } from '../../core/knowledge'

type ProjectView = 'projects' | 'overview' | 'backlog' | 'in-progress' | 'completed' | 'knowledge' | 'activity' | 'settings'

const navigation: Array<{ id: Exclude<ProjectView, 'projects'>; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'completed', label: 'Completed' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Project Settings' }
]

export function App(): JSX.Element {
  const api = useMemo(getDesktopApi, [])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [selectedProject, setSelectedProject] = useState<ProjectMetadata>()
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [claims, setClaims] = useState<WorkClaim[]>([])
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([])
  const [planningProposal, setPlanningProposal] = useState<PlanningProposal>()
  const [view, setView] = useState<ProjectView>('projects')
  const [showProjectSheet, setShowProjectSheet] = useState(false)
  const [showProjectDeletionSheet, setShowProjectDeletionSheet] = useState(false)
  const [showWorkItemSheet, setShowWorkItemSheet] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItem>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [knowledgeSourceRequest, setKnowledgeSourceRequest] = useState(0)

  const startPlanning = useCallback(async (): Promise<void> => {
    if (!selectedProjectId) return
    try {
      setPlanningProposal(await api.planning.create(selectedProjectId))
    } catch (reason) {
      setError(messageFor(reason))
    }
  }, [api, selectedProjectId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = event.metaKey || event.ctrlKey
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShowCommandPalette((visible) => !visible)
        return
      }
      if (!command) {
        if (event.key === 'Escape') {
          setShowCommandPalette(false)
        }
        return
      }
      if (event.key.toLowerCase() === 'n' && selectedProjectId) {
        event.preventDefault()
        if (event.shiftKey) {
          void startPlanning()
        } else {
          setSelectedWorkItem(undefined)
          setShowWorkItemSheet(true)
        }
        return
      }
      if (selectedProjectId && !event.shiftKey) {
        const shortcutViews: Record<string, ProjectView> = {
          '1': 'overview',
          '2': 'backlog',
          '3': 'in-progress',
          '4': 'completed',
          '5': 'knowledge'
        }
        const nextView = shortcutViews[event.key]
        if (nextView) {
          event.preventDefault()
          setSelectedWorkItem(undefined)
          setView(nextView)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedProjectId, startPlanning])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.projects.list())
    } catch (reason) {
      setError(messageFor(reason))
    }
  }, [api])

  const refreshWorkItems = useCallback(
    async (projectId: string) => {
      try {
        setWorkItems(await api.workItems.list(projectId))
      } catch (reason) {
        setError(messageFor(reason))
      }
    },
    [api]
  )
  const refreshClaims = useCallback(
    async (projectId: string) => {
      try {
        setClaims(await api.claims.list(projectId))
      } catch (reason) {
        setError(messageFor(reason))
      }
    },
    [api]
  )
  const refreshKnowledge = useCallback(async (projectId: string) => {
    try {
      setKnowledgeSources(await api.knowledge.listSources(projectId))
    } catch (reason) {
      setError(messageFor(reason))
    }
  }, [api])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id)
      setView('overview')
    }
  }, [projects, selectedProjectId])

  useEffect(() => {
    let isCurrent = true

    if (!selectedProjectId) {
      setSelectedProject(undefined)
      setWorkItems([])
      setClaims([])
      setKnowledgeSources([])
      return () => {
        isCurrent = false
      }
    }

    void api.projects
      .get(selectedProjectId)
      .then((project) => {
        if (isCurrent) {
          setSelectedProject(project)
        }
      })
      .catch((reason: unknown) => {
        if (isCurrent) {
          setError(messageFor(reason))
        }
      })
    void api.workItems
      .list(selectedProjectId)
      .then((items) => {
        if (isCurrent) {
          setWorkItems(items)
        }
      })
    void api.claims
      .list(selectedProjectId)
      .then((nextClaims) => {
        if (isCurrent) {
          setClaims(nextClaims)
        }
      })
    void api.knowledge
      .listSources(selectedProjectId)
      .then((sources) => {
        if (isCurrent) {
          setKnowledgeSources(sources)
        }
      })
      .catch((reason: unknown) => {
        if (isCurrent) {
          setError(messageFor(reason))
        }
      })
      .catch((reason: unknown) => {
        if (isCurrent) {
          setError(messageFor(reason))
        }
      })

    return () => {
      isCurrent = false
    }
  }, [api, selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) {
      return
    }
    const timer = window.setInterval(() => {
      void Promise.all([refreshProjects(), refreshWorkItems(selectedProjectId), refreshClaims(selectedProjectId), refreshKnowledge(selectedProjectId)])
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [refreshClaims, refreshKnowledge, refreshProjects, refreshWorkItems, selectedProjectId])

  const activeProject = projects.find((project) => project.id === selectedProjectId)
  const openProjectSheet = (): void => {
    setError(undefined)
    setShowProjectSheet(true)
  }

  const createProject = async (input: {
    rootPath: string
    name: string
    description: string
    workItemPrefix?: string
  }): Promise<void> => {
    try {
      const project = await api.projects.create(input)
      setSelectedProjectId(project.id)
      setView('overview')
      setShowProjectSheet(false)
      await refreshProjects()
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  const createWorkItem = async (input: CreateWorkItemInput): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      await api.workItems.create(selectedProjectId, input)
      setShowWorkItemSheet(false)
      await Promise.all([refreshProjects(), refreshWorkItems(selectedProjectId)])
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  const updateWorkItem = async (workItemId: string, patch: UpdateWorkItemInput): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      const updated = await api.workItems.update(selectedProjectId, workItemId, patch)
      setSelectedWorkItem(updated)
      await Promise.all([refreshProjects(), refreshWorkItems(selectedProjectId)])
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  const detachProject = async (): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      await api.projects.detach(selectedProjectId)
      setProjects((currentProjects) => currentProjects.filter((project) => project.id !== selectedProjectId))
      setSelectedProjectId(undefined)
      setSelectedWorkItem(undefined)
      setView('projects')
      await refreshProjects()
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  const deleteProject = async (): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      const result = await api.projects.delete(selectedProjectId, { confirmed: true })
      setProjects((currentProjects) => currentProjects.filter((project) => project.id !== selectedProjectId))
      setSelectedProjectId(undefined)
      setSelectedWorkItem(undefined)
      setView('projects')
      setShowProjectDeletionSheet(false)
      setNotice(`Project removed. Your .workstack backup is available at ${result.backupPath}`)
      await refreshProjects()
    } catch (reason) {
      setError(messageFor(reason))
      throw reason
    }
  }

  const updateProject = async (input: Parameters<DesktopApi['projects']['update']>[1]): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      await api.projects.update(selectedProjectId, input)
      await refreshProjects()
      setSelectedProject(await api.projects.get(selectedProjectId))
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  const forceReleaseWorkItem = async (workItemId: string, reason: string): Promise<void> => {
    if (!selectedProjectId) {
      return
    }
    try {
      await api.claims.forceRelease(selectedProjectId, workItemId, { reason })
      const updated = await api.workItems.get(selectedProjectId, workItemId)
      setSelectedWorkItem(updated)
      await Promise.all([refreshProjects(), refreshWorkItems(selectedProjectId), refreshClaims(selectedProjectId)])
    } catch (reason) {
      setError(messageFor(reason))
      throw reason
    }
  }

  const addKnowledgeSource = async (input: { displayName: string; filename: string; content: string }): Promise<void> => {
    if (!selectedProjectId) {
      return
    }

    try {
      await api.knowledge.addSource(selectedProjectId, input)
      await refreshKnowledge(selectedProjectId)
    } catch (reason) {
      setError(messageFor(reason))
      throw reason
    }
  }

  const savePlanning = async (patch: Parameters<DesktopApi['planning']['update']>[2]): Promise<void> => {
    if (!selectedProjectId || !planningProposal) return
    const proposal = await api.planning.update(selectedProjectId, planningProposal.planningSessionId, patch)
    setPlanningProposal(proposal)
  }

  const convertPlanning = async (patch?: Parameters<DesktopApi['planning']['update']>[2]): Promise<void> => {
    if (!selectedProjectId || !planningProposal) return
    try {
      if (patch) {
        await api.planning.update(selectedProjectId, planningProposal.planningSessionId, patch)
      }
      await api.planning.convert(selectedProjectId, planningProposal.planningSessionId)
      setPlanningProposal(undefined)
      await Promise.all([refreshProjects(), refreshWorkItems(selectedProjectId)])
      setView('backlog')
    } catch (reason) {
      setError(messageFor(reason))
    }
  }

  return (
    <main className="app-shell">
      <Sidebar
        activeProjectId={selectedProjectId}
        currentView={view}
        onAddProject={openProjectSheet}
        onNavigate={(nextView) => {
          setSelectedWorkItem(undefined)
          setView(nextView)
        }}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId)
          setSelectedWorkItem(undefined)
          setView('overview')
        }}
        projects={projects}
      />
      <section className="content">
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="success-banner" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(undefined)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {!activeProject || view === 'projects' ? (
          <ProjectsHome projects={projects} onCreateProject={openProjectSheet} onOpenProject={(projectId) => {
            setSelectedProjectId(projectId)
            setView('overview')
          }} />
        ) : selectedWorkItem ? (
          <WorkItemDetail
            api={api}
            item={selectedWorkItem}
            onBack={() => setSelectedWorkItem(undefined)}
            onError={setError}
            onItemChanged={(item) => {
              setSelectedWorkItem(item)
              void Promise.all([refreshProjects(), refreshWorkItems(activeProject.id), refreshClaims(activeProject.id)])
            }}
            claim={claims.find((claim) => claim.workItemId === selectedWorkItem.id)}
            onForceRelease={(reason) => forceReleaseWorkItem(selectedWorkItem.id, reason)}
            onSave={(patch) => updateWorkItem(selectedWorkItem.id, patch)}
            projectId={activeProject.id}
          />
        ) : (
          <ProjectViewContent
            activeProject={activeProject}
            claims={claims}
            knowledgeSources={knowledgeSources}
            metadata={selectedProject}
            onCreateWorkItem={() => setShowWorkItemSheet(true)}
            onPlanWork={startPlanning}
            onDetachProject={detachProject}
            onDeleteProject={() => setShowProjectDeletionSheet(true)}
            onOpenFolder={() => {
              void api.projects.openFolder(activeProject.id).catch((reason: unknown) => setError(messageFor(reason)))
            }}
            onOpenWorkItem={(workItem) => setSelectedWorkItem(workItem)}
            onAddKnowledgeSource={addKnowledgeSource}
            knowledgeSourceRequest={knowledgeSourceRequest}
            onKnowledgeSourceRequestHandled={() => setKnowledgeSourceRequest(0)}
            onUpdateProject={updateProject}
            view={view}
            workItems={workItems}
          />
        )}
      </section>
      {showProjectSheet ? (
        <ProjectSheet api={api} onCancel={() => setShowProjectSheet(false)} onSubmit={createProject} />
      ) : null}
      {showProjectDeletionSheet && activeProject ? (
        <ProjectDeletionSheet
          name={activeProject.name}
          rootPath={selectedProject?.rootPath ?? activeProject.rootPath}
          onCancel={() => setShowProjectDeletionSheet(false)}
          onConfirm={deleteProject}
        />
      ) : null}
      {showWorkItemSheet ? (
        <WorkItemSheet onCancel={() => setShowWorkItemSheet(false)} onSubmit={createWorkItem} />
      ) : null}
      {planningProposal && selectedProjectId ? <PlanningSheet api={api} projectId={selectedProjectId} proposal={planningProposal} onCancel={() => setPlanningProposal(undefined)} onConvert={convertPlanning} onSave={savePlanning} /> : null}
      {showCommandPalette ? (
        <CommandPalette
          activeProject={activeProject}
          projects={projects}
          workItems={workItems}
          onClose={() => setShowCommandPalette(false)}
          onCreateWorkItem={() => { setShowCommandPalette(false); setShowWorkItemSheet(true) }}
          onCreateProject={() => { setShowCommandPalette(false); openProjectSheet() }}
          onPlanWork={() => { setShowCommandPalette(false); void startPlanning() }}
          onAddKnowledge={() => { setShowCommandPalette(false); setSelectedWorkItem(undefined); setView('knowledge'); setKnowledgeSourceRequest((current) => current + 1) }}
          onOpenFolder={() => {
            setShowCommandPalette(false)
            if (activeProject) void api.projects.openFolder(activeProject.id).catch((reason: unknown) => setError(messageFor(reason)))
          }}
          onOpenWorkItem={(item) => { setShowCommandPalette(false); setSelectedWorkItem(item) }}
          onSelectProject={(projectId) => {
            setShowCommandPalette(false)
            setSelectedProjectId(projectId)
            setSelectedWorkItem(undefined)
            setView('overview')
          }}
          onNavigate={(nextView) => { setShowCommandPalette(false); setSelectedWorkItem(undefined); setView(nextView) }}
        />
      ) : null}
    </main>
  )
}

function CommandPalette({
  activeProject,
  projects,
  workItems,
  onAddKnowledge,
  onClose,
  onCreateProject,
  onCreateWorkItem,
  onNavigate,
  onOpenFolder,
  onOpenWorkItem,
  onPlanWork,
  onSelectProject
}: {
  activeProject?: ProjectSummary
  projects: ProjectSummary[]
  workItems: WorkItem[]
  onAddKnowledge(): void
  onClose(): void
  onCreateProject(): void
  onCreateWorkItem(): void
  onNavigate(view: ProjectView): void
  onOpenFolder(): void
  onOpenWorkItem(item: WorkItem): void
  onPlanWork(): void
  onSelectProject(projectId: string): void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const matches = (value: string): boolean => !normalizedQuery || value.toLowerCase().includes(normalizedQuery)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string>()
  const copyMcpConfiguration = async (): Promise<void> => {
    const configuration = JSON.stringify({ mcpServers: { workstack: { command: 'npm', args: ['run', 'mcp:serve'] } } }, null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(configuration)
        } catch {
          if (!copyTextFallback(configuration)) {
            throw new Error('Clipboard access is unavailable.')
          }
        }
      } else if (!copyTextFallback(configuration)) {
        throw new Error('Clipboard access is unavailable.')
      }
      setCopyError(undefined)
      setCopied(true)
    } catch (reason) {
      setCopyError(messageFor(reason))
    }
  }
  return (
    <Modal title="Command Palette" onCancel={onClose}>
      <p className="modal-copy">Quick actions · Command-K</p>
      <label className="search-field command-search">
        <span className="sr-only">Search commands and project content</span>
        <input autoFocus aria-label="Search commands and project content" placeholder="Search commands, projects, and work" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="command-list">
        {matches('New project') ? <button type="button" onClick={onCreateProject}>New project</button> : null}
        {activeProject && matches('New work item Create Work Item') ? <button type="button" onClick={onCreateWorkItem}>New work item</button> : null}
        {activeProject && matches('Plan New Work Plan with AI') ? <button type="button" onClick={onPlanWork}>Plan new work</button> : null}
        {activeProject && matches('Add Knowledge Source') ? <button type="button" onClick={onAddKnowledge}>Add knowledge source</button> : null}
        {activeProject && matches('Open Project Folder') ? <button type="button" onClick={onOpenFolder}>Open project folder</button> : null}
        {activeProject && matches('Copy MCP Configuration') ? <button type="button" onClick={() => void copyMcpConfiguration()}>{copied ? 'MCP configuration copied' : 'Copy MCP configuration'}</button> : null}
        {activeProject && matches('Overview') ? <button type="button" onClick={() => onNavigate('overview')}>Go to Overview</button> : null}
        {activeProject && matches('Backlog') ? <button type="button" onClick={() => onNavigate('backlog')}>Go to Backlog</button> : null}
        {activeProject && matches('In Progress Active work') ? <button type="button" onClick={() => onNavigate('in-progress')}>Go to In Progress</button> : null}
        {activeProject && matches('Completed') ? <button type="button" onClick={() => onNavigate('completed')}>Go to Completed</button> : null}
        {activeProject && matches('Knowledge') ? <button type="button" onClick={() => onNavigate('knowledge')}>Go to Knowledge</button> : null}
        {projects.filter((project) => matches(project.name)).map((project) => <button key={project.id} type="button" onClick={() => onSelectProject(project.id)}>Open project: {project.name}</button>)}
        {workItems.filter((item) => matches(`${item.displayId} ${item.title} ${item.status}`)).map((item) => <button key={item.id} type="button" onClick={() => onOpenWorkItem(item)}>Open {item.status.replace('_', ' ')}: {item.displayId} {item.title}</button>)}
      </div>
      {copyError ? <p role="alert">{copyError}</p> : null}
    </Modal>
  )
}

function Sidebar({
  activeProjectId,
  currentView,
  onAddProject,
  onNavigate,
  onSelectProject,
  projects
}: {
  activeProjectId?: string
  currentView: ProjectView
  onAddProject(): void
  onNavigate(view: ProjectView): void
  onSelectProject(projectId: string): void
  projects: ProjectSummary[]
}): JSX.Element {
  return (
    <aside className="sidebar" aria-label="Project navigation">
      <div className="brand" aria-label="Workstack">
        <span className="brand-mark" aria-hidden="true">
          =
        </span>
        <span>workstack</span>
      </div>
      <p className="sidebar-label">PROJECTS</p>
      <div className="project-list">
        {projects.map((project) => (
          <button
            className={`project-link ${project.id === activeProjectId ? 'current' : ''}`}
            key={project.id}
            type="button"
            aria-current={project.id === activeProjectId ? 'page' : undefined}
            onClick={() => onSelectProject(project.id)}
          >
            {project.name}
          </button>
        ))}
      </div>
      <button className="project-link add-project" type="button" onClick={onAddProject}>
        + Add Project
      </button>
      {activeProjectId ? (
        <>
          <p className="sidebar-label project-section-label">PROJECT</p>
          <nav aria-label="Project views">
            {navigation.map((item) => (
              <button
                className={`nav-link ${currentView === item.id ? 'current' : ''}`}
                key={item.id}
                type="button"
                aria-current={currentView === item.id ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </>
      ) : null}
    </aside>
  )
}

function ProjectsHome({
  onCreateProject,
  onOpenProject,
  projects
}: {
  onCreateProject(): void
  onOpenProject(projectId: string): void
  projects: ProjectSummary[]
}): JSX.Element {
  return (
    <>
      <header className="toolbar">
        <label className="search-field">
          <span className="sr-only">Search projects</span>
          <input disabled placeholder="Search projects" type="search" />
        </label>
        <button className="primary-button" type="button" onClick={onCreateProject}>
          + New Project
        </button>
      </header>
      {projects.length === 0 ? (
        <section className="empty-state" aria-labelledby="projects-heading">
          <div className="empty-icon" aria-hidden="true">
            +
          </div>
          <p className="eyebrow">GET STARTED</p>
          <h1 id="projects-heading">Create your first project</h1>
          <p>
            Workstack keeps your project knowledge, implementation-ready work, and coding-agent activity in one
            local place.
          </p>
          <button className="primary-button large" type="button" onClick={onCreateProject}>
            + New Project
          </button>
          <span className="version">Workstack 0.1.0</span>
        </section>
      ) : (
        <section className="projects-page" aria-labelledby="projects-heading">
          <p className="eyebrow">PROJECTS</p>
          <h1 id="projects-heading">Your workspaces</h1>
          <div className="project-cards">
            {projects.map((project) => (
              <button className="project-card" key={project.id} type="button" onClick={() => onOpenProject(project.id)}>
                <span className="project-card-title">{project.name}</span>
                <span className="project-card-description">{project.description || 'No project description yet.'}</span>
                <span className="project-counts" aria-label={`${project.backlogCount} backlog, ${project.inProgressCount} active, ${project.completedCount} completed`}>
                  <strong>{project.backlogCount}</strong> Backlog
                  <strong>{project.inProgressCount}</strong> Active
                  <strong>{project.completedCount}</strong> Completed
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function ProjectViewContent({
  activeProject,
  claims,
  knowledgeSources,
  metadata,
  onCreateWorkItem,
  onPlanWork,
  onDetachProject,
  onDeleteProject,
  onAddKnowledgeSource,
  onKnowledgeSourceRequestHandled,
  knowledgeSourceRequest,
  onOpenFolder,
  onOpenWorkItem,
  onUpdateProject,
  view,
  workItems
}: {
  activeProject: ProjectSummary
  claims: WorkClaim[]
  knowledgeSources: KnowledgeSource[]
  metadata?: ProjectMetadata
  onCreateWorkItem(): void
  onPlanWork(): void
  onDetachProject(): void
  onDeleteProject(): void
  onAddKnowledgeSource(input: { displayName: string; filename: string; content: string }): Promise<void>
  onKnowledgeSourceRequestHandled(): void
  knowledgeSourceRequest: number
  onOpenFolder(): void
  onOpenWorkItem(workItem: WorkItem): void
  onUpdateProject(input: Parameters<DesktopApi['projects']['update']>[1]): Promise<void>
  view: ProjectView
  workItems: WorkItem[]
}): JSX.Element {
  if (view === 'overview') {
    return <Overview claims={claims} project={activeProject} workItems={workItems} onOpenWorkItem={onOpenWorkItem} />
  }
  if (view === 'backlog') {
    return <Backlog api={getDesktopApi()} projectId={activeProject.id} workItems={workItems} onCreateWorkItem={onCreateWorkItem} onPlanWork={onPlanWork} onOpenWorkItem={onOpenWorkItem} />
  }
  if (view === 'completed') {
    return <WorkItemHistory api={getDesktopApi()} projectId={activeProject.id} title="Completed" description="Nothing has been completed yet. Completed work becomes part of Workstack's long-term project memory." items={workItems.filter((item) => item.status === 'completed')} onOpenWorkItem={onOpenWorkItem} />
  }
  if (view === 'in-progress') {
    return <ActiveWorkPage api={getDesktopApi()} projectId={activeProject.id} claims={claims} items={workItems} onOpenWorkItem={onOpenWorkItem} />
  }
  if (view === 'knowledge') {
    return <KnowledgePage api={getDesktopApi()} projectId={activeProject.id} sources={knowledgeSources} workItems={workItems} onOpenWorkItem={onOpenWorkItem} onAddSource={onAddKnowledgeSource} sourceSheetRequest={knowledgeSourceRequest} onSourceSheetRequestHandled={onKnowledgeSourceRequestHandled} />
  }
  if (view === 'activity') {
    return <ActivityPage api={getDesktopApi()} projectId={activeProject.id} />
  }
  return (
    <ProjectSettings
      description={metadata?.description ?? activeProject.description}
      name={metadata?.name ?? activeProject.name}
      projectSettings={metadata?.settings}
      rootPath={metadata?.rootPath ?? activeProject.rootPath}
      onDetach={onDetachProject}
      onDelete={onDeleteProject}
      onOpenFolder={onOpenFolder}
      onSave={onUpdateProject}
    />
  )
}

function ActivityPage({ api, projectId }: { api: DesktopApi; projectId: string }): JSX.Element {
  const [events, setEvents] = useState<import('../../core/types').ActivityEvent[]>([])
  const [filter, setFilter] = useState<'all' | 'human' | 'agents' | 'work-items' | 'knowledge'>('all')
  useEffect(() => { void api.activity.list(projectId).then(setEvents) }, [api, projectId])
  const filteredEvents = events
    .filter((event) => {
      if (filter === 'human') return event.actorType === 'human'
      if (filter === 'agents') return event.actorType === 'agent'
      if (filter === 'work-items') return Boolean(event.workItemId) || event.eventType.startsWith('work_item_')
      if (filter === 'knowledge') return event.eventType.includes('knowledge')
      return true
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return (
    <section className="page-content" aria-labelledby="activity-heading">
      <p className="eyebrow">PROJECT MEMORY</p><h1 id="activity-heading">Activity</h1>
      <p className="page-intro">A durable record of human, agent, and knowledge milestones.</p>
      <div aria-label="Filter activity" className="segmented-control" role="tablist">
        {([
          ['all', 'All'],
          ['human', 'Human'],
          ['agents', 'Agents'],
          ['work-items', 'Work Items'],
          ['knowledge', 'Knowledge']
        ] as const).map(([value, label]) => (
          <button aria-selected={filter === value} key={value} role="tab" type="button" onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      {filteredEvents.length ? <ol className="activity-list">{filteredEvents.map((event) => <li key={event.id}><strong>{event.eventType.replaceAll('_', ' ')}</strong><span>{event.actorId ?? event.actorType} · {formatDate(event.createdAt)}</span></li>)}</ol> : <div className="inline-empty"><p>No activity matches this filter.</p></div>}
    </section>
  )
}

function Overview({
  claims,
  onOpenWorkItem,
  project,
  workItems
}: {
  claims: WorkClaim[]
  onOpenWorkItem(workItem: WorkItem): void
  project: ProjectSummary
  workItems: WorkItem[]
}): JSX.Element {
  const upcoming = workItems.filter((item) => item.status === 'backlog').slice(0, 5)
  const completed = workItems.filter((item) => item.status === 'completed').slice(0, 3)
  return (
    <section className="page-content" aria-labelledby="overview-heading">
      <p className="eyebrow">PROJECT OVERVIEW</p>
      <h1 id="overview-heading">{project.name}</h1>
      <p className="page-intro">{project.description || 'A focused workspace for project knowledge and coding-agent coordination.'}</p>
      <div className="overview-grid">
        <OverviewSection title="In Progress" count={project.inProgressCount}>
          <ActiveWorkList claims={claims} items={workItems} onOpenWorkItem={onOpenWorkItem} compact />
        </OverviewSection>
        <OverviewSection title="Up Next" count={project.backlogCount}>
          {upcoming.length ? <CompactItems items={upcoming} onOpen={onOpenWorkItem} /> : <p className="muted">Your backlog is empty. Add something yourself or plan it with AI.</p>}
        </OverviewSection>
        <OverviewSection title="Recently Completed" count={project.completedCount}>
          {completed.length ? <CompactItems items={completed} onOpen={onOpenWorkItem} /> : <p className="muted">Nothing has been completed yet.</p>}
        </OverviewSection>
        <OverviewSection title="Knowledge" count={0}>
          <p className="muted">Knowledge sources and articles will accumulate as the project evolves.</p>
        </OverviewSection>
      </div>
    </section>
  )
}

function OverviewSection({ children, count, title }: { children: ReactNode; count: number; title: string }): JSX.Element {
  return (
    <section className="overview-section" aria-label={title}>
      <div className="section-heading">
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      {children}
    </section>
  )
}

function CompactItems({ items, onOpen }: { items: WorkItem[]; onOpen(workItem: WorkItem): void }): JSX.Element {
  return (
    <ul className="compact-items">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" onClick={() => onOpen(item)}>
            <span>{item.displayId}</span>
            {item.title}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Backlog({
  api,
  onCreateWorkItem,
  onPlanWork,
  onOpenWorkItem,
  projectId,
  workItems
}: {
  api: DesktopApi
  onCreateWorkItem(): void
  onPlanWork(): void
  onOpenWorkItem(workItem: WorkItem): void
  projectId: string
  workItems: WorkItem[]
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [priority, setPriority] = useState('')
  const [created, setCreated] = useState('')
  const [attachments, setAttachments] = useState<'all' | 'with' | 'without'>('all')
  const [source, setSource] = useState<'all' | 'manual' | 'ai'>('all')
  const [sort, setSort] = useState<'created-desc' | 'created-asc' | 'priority' | 'title'>('created-desc')
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const backlogItems = useMemo(() => workItems.filter((item) => item.status === 'backlog'), [workItems])

  useEffect(() => {
    let current = true
    void Promise.all(backlogItems.map(async (item) => [item.id, (await api.attachments.list(projectId, item.id)).length] as const))
      .then((counts) => {
        if (current) setAttachmentCounts(Object.fromEntries(counts))
      })
      .catch(() => {
        if (current) setAttachmentCounts({})
      })
    return () => { current = false }
  }, [api, projectId, backlogItems])

  const filteredItems = backlogItems
    .filter((item) => {
      const normalizedQuery = query.trim().toLowerCase()
      const matchesQuery = !normalizedQuery || `${item.displayId} ${item.title} ${item.descriptionMarkdown} ${item.acceptanceCriteriaMarkdown}`.toLowerCase().includes(normalizedQuery)
      const matchesCreated = !created || matchesCreatedPeriod(item.createdAt, created)
      const matchesAttachments = attachments === 'all' || (attachments === 'with' ? Boolean(attachmentCounts[item.id]) : !attachmentCounts[item.id])
      const matchesSource = source === 'all' || (source === 'manual' ? item.source === 'manual' : item.source !== 'manual')
      return matchesQuery && (!type || item.type === type) && (!priority || item.priority === priority) && matchesCreated && matchesAttachments && matchesSource
    })
    .sort((left, right) => {
      if (sort === 'created-asc') return left.createdAt.localeCompare(right.createdAt)
      if (sort === 'priority') return priorityRank(left.priority) - priorityRank(right.priority) || right.createdAt.localeCompare(left.createdAt)
      if (sort === 'title') return left.title.localeCompare(right.title)
      return right.createdAt.localeCompare(left.createdAt)
    })
  return (
    <section className="page-content backlog-page" aria-labelledby="backlog-heading">
      <div className="page-toolbar">
        <div>
          <p className="eyebrow">WORK QUEUE</p>
          <h1 id="backlog-heading">Backlog</h1>
        </div>
        <div className="toolbar-actions"><button className="secondary-button" type="button" onClick={onPlanWork}>Plan with AI</button><button className="primary-button" type="button" onClick={onCreateWorkItem}>+ New Work Item</button></div>
      </div>
      <div className="list-controls">
        <label className="search-field">
          <span className="sr-only">Search backlog</span>
          <input
            placeholder="Search backlog"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Filter by type</span>
          <select aria-label="Filter by type" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">All types</option>
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
            <option value="chore">Chore</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by priority</span>
          <select
            aria-label="Filter by priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="">All priorities</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label><span className="sr-only">Filter by created date</span><select aria-label="Filter by created date" value={created} onChange={(event) => setCreated(event.target.value)}><option value="">Any time</option><option value="today">Today</option><option value="week">Past 7 days</option><option value="month">Past 30 days</option><option value="older">Older than 30 days</option></select></label>
        <label><span className="sr-only">Filter by attachments</span><select aria-label="Filter by attachments" value={attachments} onChange={(event) => setAttachments(event.target.value as typeof attachments)}><option value="all">All attachments</option><option value="with">Has attachments</option><option value="without">No attachments</option></select></label>
        <label><span className="sr-only">Filter by source</span><select aria-label="Filter by source" value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">All sources</option><option value="manual">Manual</option><option value="ai">AI generated</option></select></label>
        <label><span className="sr-only">Sort backlog</span><select aria-label="Sort backlog" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="created-desc">Newest created</option><option value="created-asc">Oldest created</option><option value="priority">Priority</option><option value="title">Title</option></select></label>
      </div>
      {filteredItems.length ? (
        <div className="work-table" role="table" aria-label="Backlog work items">
          <div className="work-table-header" role="row">
            <span role="columnheader">ID</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Title</span>
            <span role="columnheader">Priority</span>
            <span role="columnheader">Created</span>
            <span role="columnheader">Files</span>
          </div>
          {filteredItems.map((item) => (
            <div className="work-table-row" key={item.id} role="row">
              <span role="cell">{item.displayId}</span>
              <span role="cell"><TypeBadge type={item.type} /></span>
              <span className="work-title" role="cell"><button type="button" onClick={() => onOpenWorkItem(item)}>{item.title}</button></span>
              <span role="cell"><PriorityBadge priority={item.priority} /></span>
              <span role="cell">{formatDate(item.createdAt)}</span>
              <span aria-label={attachmentCounts[item.id] ? `${attachmentCounts[item.id]} attachments` : 'No attachments'} role="cell">{attachmentCounts[item.id] ? `⌁ ${attachmentCounts[item.id]}` : '—'}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="inline-empty">
          <h2>{backlogItems.length ? 'No backlog items match these filters' : 'Your backlog is empty'}</h2>
          <p>{backlogItems.length ? 'Try removing a filter or changing the search.' : 'Add something yourself or discuss the next feature with Workstack.'}</p>
          <div className="empty-actions">
            <button className="secondary-button" type="button" onClick={onCreateWorkItem}>New Work Item</button>
            <button aria-label="Plan new work with AI" className="primary-button" type="button" onClick={onPlanWork}>Plan with AI</button>
          </div>
        </div>
      )}
    </section>
  )
}

function WorkItemHistory({
  api,
  description,
  items,
  onOpenWorkItem,
  projectId,
  title
}: {
  api: DesktopApi
  description: string
  items: WorkItem[]
  onOpenWorkItem(workItem: WorkItem): void
  projectId: string
  title: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [completions, setCompletions] = useState<Record<string, CompletionRecord>>({})

  useEffect(() => {
    let current = true
    void Promise.all(items.map(async (item) => [item.id, await api.claims.getCompletion(projectId, item.id)] as const))
      .then((records) => {
        if (current) setCompletions(Object.fromEntries(records.filter((entry): entry is [string, CompletionRecord] => Boolean(entry[1]))))
      })
      .catch(() => {
        if (current) setCompletions({})
      })
    return () => { current = false }
  }, [api, items, projectId])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredItems = items
    .filter((item) => {
      const completion = completions[item.id]
      const corpus = [
        item.displayId,
        item.title,
        item.descriptionMarkdown,
        item.acceptanceCriteriaMarkdown,
        completion?.summaryMarkdown,
        completion?.implementationNotesMarkdown,
        completion?.validationMarkdown,
        completion?.filesChanged.join(' '),
        completion?.componentsChanged.join(' '),
        completion?.commitSha,
        completion?.branch,
        completion?.prUrl,
        completion?.completedByAgentId,
        completion?.completedBySessionId
      ].filter(Boolean).join(' ').toLowerCase()
      return !normalizedQuery || corpus.includes(normalizedQuery)
    })
    .sort((left, right) => (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt))
  const groups = filteredItems.reduce<Record<string, WorkItem[]>>((result, item) => {
    const day = formatHistoryDate(item.completedAt ?? item.updatedAt)
    result[day] ??= []
    result[day].push(item)
    return result
  }, {})
  return (
    <section className="page-content" aria-labelledby={`${title.toLowerCase().replace(' ', '-')}-heading`}>
      <p className="eyebrow">WORK HISTORY</p>
      <h1 id={`${title.toLowerCase().replace(' ', '-')}-heading`}>{title}</h1>
      <p className="page-intro">Search completed work, implementation evidence, and agent delivery metadata.</p>
      <label className="search-field history-search"><span className="sr-only">Search completed work</span><input aria-label="Search completed work" placeholder="Search completed work" type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {filteredItems.length ? <div className="history-groups">{Object.entries(groups).map(([day, dayItems]) => <section aria-label={`Completed ${day}`} className="history-group" key={day}><h2>{day}</h2><CompactItems items={dayItems} onOpen={onOpenWorkItem} /></section>)}</div> : <div className="inline-empty"><p>{items.length ? 'No completed work matches this search.' : description}</p></div>}
    </section>
  )
}

function ActiveWorkPage({
  api,
  claims,
  items,
  onOpenWorkItem,
  projectId
}: {
  api: DesktopApi
  claims: WorkClaim[]
  items: WorkItem[]
  onOpenWorkItem(workItem: WorkItem): void
  projectId: string
}): JSX.Element {
  const [agentDetail, setAgentDetail] = useState<{ claim: WorkClaim; item: WorkItem }>()
  return (
    <section className="page-content" aria-labelledby="in-progress-heading">
      <p className="eyebrow">AGENT COORDINATION</p>
      <h1 id="in-progress-heading">In Progress</h1>
      <p className="page-intro">Current coding-agent leases are authoritative. Review the owner and health before intervening.</p>
      <ActiveWorkList claims={claims} items={items} onOpenWorkItem={onOpenWorkItem} onViewAgentDetails={(claim, item) => setAgentDetail({ claim, item })} />
      {agentDetail ? <AgentDetailSheet api={api} claim={agentDetail.claim} item={agentDetail.item} projectId={projectId} onCancel={() => setAgentDetail(undefined)} /> : null}
    </section>
  )
}

function ActiveWorkList({
  claims,
  compact = false,
  items,
  onOpenWorkItem,
  onViewAgentDetails
}: {
  claims: WorkClaim[]
  compact?: boolean
  items: WorkItem[]
  onOpenWorkItem(workItem: WorkItem): void
  onViewAgentDetails?(claim: WorkClaim, item: WorkItem): void
}): JSX.Element {
  const activeItems = claims.flatMap((claim) => {
    const item = items.find((candidate) => candidate.id === claim.workItemId)
    return item ? [{ claim, item }] : []
  })

  if (!activeItems.length) {
    return <p className="muted">No coding agents are active right now.</p>
  }

  return (
    <ul className={`active-work-list ${compact ? 'compact' : ''}`} aria-label="Active work items">
      {activeItems.map(({ claim, item }) => (
        <li key={claim.id}>
          <button className="active-work-open" type="button" onClick={() => onOpenWorkItem(item)}>
            <span className="active-work-heading">
              <span><span className="work-id">{item.displayId}</span> {item.title}</span>
              <ClaimHealthBadge claim={claim} />
            </span>
            <span className="active-work-owner">{claim.agentDisplayName ?? claim.agentId}</span>
            {claim.sessionId ? <span className="active-work-session">Session {claim.sessionId}</span> : null}
            {claim.blockedReason ? <span className="active-work-reason">{claim.blockedReason}</span> : null}
          </button>
          {onViewAgentDetails ? <button aria-label={`View details for ${claim.agentDisplayName ?? claim.agentId}`} className="agent-details-button" type="button" onClick={() => onViewAgentDetails(claim, item)}>Agent details</button> : null}
        </li>
      ))}
    </ul>
  )
}

function KnowledgePage({
  api,
  onAddSource,
  onSourceSheetRequestHandled,
  projectId,
  sourceSheetRequest,
  sources,
  workItems,
  onOpenWorkItem
}: {
  api: DesktopApi
  onAddSource(input: { displayName: string; filename: string; content: string }): Promise<void>
  onSourceSheetRequestHandled(): void
  projectId: string
  sourceSheetRequest: number
  sources: KnowledgeSource[]
  workItems: WorkItem[]
  onOpenWorkItem(workItem: WorkItem): void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [retrieval, setRetrieval] = useState<ProjectKnowledgeRetrieval>()
  const [preview, setPreview] = useState<KnowledgeRetrievalResult>()
  const [showSourceSheet, setShowSourceSheet] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [displaySources, setDisplaySources] = useState(sources)
  const [articles, setArticles] = useState<import('../../core/knowledge').WikiArticle[]>([])
  const [editingArticle, setEditingArticle] = useState<import('../../core/knowledge').WikiArticle>()

  useEffect(() => {
    setDisplaySources(sources)
  }, [sources])
  useEffect(() => { void api.knowledge.listWiki(projectId).then(setArticles) }, [api, projectId])
  useEffect(() => {
    if (sourceSheetRequest) {
      setShowSourceSheet(true)
      onSourceSheetRequestHandled()
    }
  }, [onSourceSheetRequestHandled, sourceSheetRequest])

  const search = (value: string): void => {
    setQuery(value)
    if (!value.trim()) {
      setRetrieval(undefined)
      return
    }
    void api.knowledge.retrieve(projectId, value).then(setRetrieval)
  }

  const refreshSources = async (): Promise<void> => {
    await api.knowledge.processNext(projectId)
    setDisplaySources(await api.knowledge.listSources(projectId))
    setProcessing(false)
  }
  const retrySources = async (): Promise<void> => {
    await api.knowledge.retryFailed(projectId)
    setDisplaySources(await api.knowledge.listSources(projectId))
    setProcessing(false)
  }

  return (
    <section className="page-content knowledge-page" aria-labelledby="knowledge-heading">
      <div className="page-toolbar">
        <div><p className="eyebrow">PROJECT MEMORY</p><h1 id="knowledge-heading">Knowledge</h1></div>
        <div className="toolbar-actions">
          <button className="secondary-button" type="button" onClick={() => setEditingArticle({ slug: '', content: '' })}>New wiki article</button>
          <button className="secondary-button" disabled={processing} type="button" onClick={() => { setProcessing(true); void refreshSources() }}>Process pending</button>
          <button className="secondary-button" disabled={processing} type="button" onClick={() => { setProcessing(true); void retrySources() }}>Retry failed</button>
          <button className="primary-button" type="button" onClick={() => setShowSourceSheet(true)}>+ Add Source</button>
        </div>
      </div>
      <p className="page-intro">Keep source evidence durable and searchable. Manual sources are preserved separately from future maintained wiki articles.</p>
      <label className="search-field">
        <span className="sr-only">Search knowledge</span>
        <input aria-label="Search knowledge" placeholder="Search knowledge" type="search" value={query} onChange={(event) => search(event.target.value)} />
      </label>
      {query ? (
        <section className="knowledge-results" aria-label="Knowledge retrieval results">
          {retrieval?.results.length ? (
            <>
              <p className="retrieval-summary" role="status">{retrieval.results.length} project records, ranked by lexical relevance.</p>
              {retrieval.groups.map((group) => group.results.length ? (
                <section className="retrieval-group" key={group.sourceType} aria-labelledby={`retrieval-${group.sourceType}`}>
                  <h2 id={`retrieval-${group.sourceType}`}>{group.label}</h2>
                  <ul>
                    {group.results.map((result) => (
                      <li key={result.sourceId}>
                        <button type="button" className="retrieval-result" onClick={() => {
                          setPreview(result)
                          if (result.workItemId) {
                            const item = workItems.find((candidate) => candidate.id === result.workItemId)
                            if (item) onOpenWorkItem(item)
                          }
                        }}>
                          <span className="retrieval-result-title">{result.title}</span>
                          <span className="retrieval-result-excerpt">{result.excerpt}</span>
                          <span className="retrieval-provenance">{sourceTypeLabel(result.sourceType)} · {result.location}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null)}
            </>
          ) : <p className="muted">No project records match this search.</p>}
        </section>
      ) : (
        <>
        <section className="knowledge-sources" aria-labelledby="sources-heading">
          <h2 id="sources-heading">Sources</h2>
          {displaySources.length ? <ul>{displaySources.map((source) => <li key={source.id}><strong>{source.displayName}</strong><span>{source.kind} · {source.status}</span><small>{source.relativeOrExternalLocation}</small></li>)}</ul> : <div className="inline-empty"><h2>Your knowledge base is empty</h2><p>Build your project knowledge. Add existing documentation or let Workstack accumulate knowledge as work is completed.</p><button className="primary-button" type="button" onClick={() => setShowSourceSheet(true)}>Add Knowledge Source</button></div>}
        </section>
        <section className="knowledge-sources" aria-labelledby="wiki-heading">
          <h2 id="wiki-heading">Maintained wiki</h2>
          {articles.length ? <ul>{articles.map((article) => <li key={article.slug}><button type="button" onClick={() => setEditingArticle(article)}>{article.slug}</button></li>)}</ul> : <p className="muted">No maintained articles yet.</p>}
        </section>
        </>
      )}
      {preview && !preview.workItemId ? <KnowledgeProvenancePreview result={preview} onClose={() => setPreview(undefined)} /> : null}
      {showSourceSheet ? <KnowledgeSourceSheet onCancel={() => setShowSourceSheet(false)} onSubmit={async (input) => { await onAddSource(input); setShowSourceSheet(false) }} /> : null}
      {editingArticle ? <WikiArticleSheet article={editingArticle} onCancel={() => setEditingArticle(undefined)} onSave={async (article) => { const saved = await api.knowledge.saveWiki(projectId, article.slug, article.content); setArticles(await api.knowledge.listWiki(projectId)); setEditingArticle(saved) }} /> : null}
    </section>
  )
}

function KnowledgeProvenancePreview({ result, onClose }: { result: KnowledgeRetrievalResult; onClose(): void }): JSX.Element {
  return (
    <aside className="provenance-preview" aria-label="Source provenance">
      <div>
        <span className="provenance-type">{sourceTypeLabel(result.sourceType)}</span>
        <strong>{result.title}</strong>
      </div>
      <p>{result.excerpt}</p>
      <small>Source ID: {result.sourceId}<br />Location: {result.location}</small>
      <button className="secondary-button" type="button" onClick={onClose}>Close preview</button>
    </aside>
  )
}

function sourceTypeLabel(sourceType: KnowledgeRetrievalResult['sourceType']): string {
  return sourceType.replace('_', ' ')
}

function WikiArticleSheet({ article, onCancel, onSave }: { article: import('../../core/knowledge').WikiArticle; onCancel(): void; onSave(article: import('../../core/knowledge').WikiArticle): Promise<void> }): JSX.Element {
  const [slug, setSlug] = useState(article.slug)
  const [content, setContent] = useState(article.content)
  return <Modal title="Wiki Article" onCancel={onCancel}><form onKeyDown={submitOnMetaEnter} onSubmit={(event) => { event.preventDefault(); void onSave({ slug, content }) }}>
    <label className="field-label">Article name<input aria-label="Article name" required value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
    <label className="field-label">Article content<textarea aria-label="Article content" value={content} onChange={(event) => setContent(event.target.value)} /></label>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Close</button><button className="primary-button" type="submit">Save article</button></div>
  </form></Modal>
}

function KnowledgeSourceSheet({
  onCancel,
  onSubmit
}: {
  onCancel(): void
  onSubmit(input: { displayName: string; filename: string; content: string }): Promise<void>
}): JSX.Element {
  const [displayName, setDisplayName] = useState('')
  const [filename, setFilename] = useState('notes.md')
  const [content, setContent] = useState('')
  return (
    <Modal title="Add Knowledge Source" onCancel={onCancel}>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => { event.preventDefault(); void onSubmit({ displayName, filename, content }) }}>
        <label className="field-label">Source name<input required aria-label="Source name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="field-label">Filename<input required aria-label="Source filename" value={filename} onChange={(event) => setFilename(event.target.value)} /></label>
        <label className="field-label">Source content<textarea required aria-label="Source content" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">Add Source</button></div>
      </form>
    </Modal>
  )
}

function WorkItemDetail({
  api,
  claim,
  item,
  onBack,
  onError,
  onForceRelease,
  onItemChanged,
  onSave,
  projectId,
}: {
  api: DesktopApi
  claim?: WorkClaim
  item: WorkItem
  onBack(): void
  onError(message: string): void
  onForceRelease(reason: string): Promise<void>
  onItemChanged(item: WorkItem): void
  onSave(patch: UpdateWorkItemInput): Promise<void>
  projectId: string
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [showReleaseSheet, setShowReleaseSheet] = useState(false)
  const [showAgentDetails, setShowAgentDetails] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.descriptionMarkdown)
  const [criteria, setCriteria] = useState(item.acceptanceCriteriaMarkdown)
  const [priority, setPriority] = useState(item.priority)
  const [completion, setCompletion] = useState<CompletionRecord>()
  const { attachments, attachFiles, pasteImage, previewUrls, removeAttachment } = useWorkItemAttachments(
    api,
    projectId,
    item.id,
    onError,
    onItemChanged
  )

  useEffect(() => {
    setTitle(item.title)
    setDescription(item.descriptionMarkdown)
    setCriteria(item.acceptanceCriteriaMarkdown)
    setPriority(item.priority)
  }, [item])

  useEffect(() => {
    if (item.status !== 'completed') {
      setCompletion(undefined)
      return
    }
    void api.claims.getCompletion(projectId, item.id).then(setCompletion).catch((reason) => onError(messageFor(reason)))
  }, [api, item.id, item.status, onError, projectId])

  const handleEditorPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'))
    if (image) {
      event.preventDefault()
      void pasteImage(image)
    }
  }

  return (
    <section className="detail-page" aria-labelledby="work-item-heading">
      <header className="detail-header">
        <button className="back-button" type="button" onClick={onBack}>Back to Backlog</button>
        <div className="detail-actions">
          <TypeBadge type={item.type} />
          <StatusBadge status={item.status} />
          <button className="secondary-button" type="button" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
        </div>
      </header>
      <div className="detail-grid">
        <article className="document-panel">
          <span className="work-id">{item.displayId}</span>
          {editing ? (
            <>
              <label className="field-label">Title<input aria-label="Work item title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label className="field-label">Description<textarea aria-label="Work item description" value={description} onChange={(event) => setDescription(event.target.value)} onPaste={handleEditorPaste} /></label>
              <label className="field-label">Acceptance criteria<textarea aria-label="Work item acceptance criteria" value={criteria} onChange={(event) => setCriteria(event.target.value)} /></label>
              <label className="field-label">Priority<select aria-label="Work item priority" value={priority} onChange={(event) => setPriority(event.target.value as WorkItem['priority'])}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
              <button className="primary-button" type="button" onClick={() => {
                void onSave({ title, descriptionMarkdown: description, acceptanceCriteriaMarkdown: criteria, priority }).then(() => setEditing(false))
              }}>Save changes</button>
            </>
          ) : (
            <>
              <h1 id="work-item-heading">{item.title}</h1>
              {claim ? (
                <ClaimStatusStrip claim={claim} onForceRelease={() => setShowReleaseSheet(true)} onViewAgentDetails={() => setShowAgentDetails(true)} />
              ) : null}
              <DocumentSection attachments={attachments} previewUrls={previewUrls} title="Description">{item.descriptionMarkdown || 'No description has been added yet.'}</DocumentSection>
              <DocumentSection title="Acceptance criteria">{item.acceptanceCriteriaMarkdown || 'No acceptance criteria have been added yet.'}</DocumentSection>
              {completion ? <CompletionResult completion={completion} /> : null}
            </>
          )}
          <AttachmentPanel
            attachments={attachments}
            onAttachFiles={attachFiles}
            onPasteImage={pasteImage}
            onRemove={removeAttachment}
            previewUrls={previewUrls}
          />
        </article>
        <aside className="inspector" aria-label="Work item details">
          <p className="eyebrow">DETAILS</p>
          <dl>
            <dt>Status</dt><dd><StatusBadge status={item.status} /></dd>
            <dt>Priority</dt><dd><PriorityBadge priority={item.priority} /></dd>
            <dt>Type</dt><dd><TypeBadge type={item.type} /></dd>
            <dt>Created</dt><dd>{formatDate(item.createdAt)}</dd>
            <dt>Updated</dt><dd>{formatDate(item.updatedAt)}</dd>
            <dt>Source</dt><dd>{item.source === 'ai_plan' ? 'AI planning' : item.source}</dd>
            {claim ? (
              <>
                <dt>Agent</dt><dd>{claim.agentDisplayName ?? claim.agentId}</dd>
                {claim.sessionId ? <><dt>Session</dt><dd>{claim.sessionId}</dd></> : null}
                <dt>Lease health</dt><dd><ClaimHealthBadge claim={claim} /></dd>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
      {showAgentDetails && claim ? <AgentDetailSheet api={api} claim={claim} item={item} projectId={projectId} onCancel={() => setShowAgentDetails(false)} /> : null}
      {showReleaseSheet && claim ? (
        <ReleaseClaimSheet
          claim={claim}
          onCancel={() => setShowReleaseSheet(false)}
          onSubmit={async (reason) => {
            await onForceRelease(reason)
            setShowReleaseSheet(false)
          }}
        />
      ) : null}
    </section>
  )
}

function CompletionResult({ completion }: { completion: CompletionRecord }): JSX.Element {
  return (
    <section className="document-section" aria-labelledby="result-heading">
      <h2 id="result-heading">Result</h2>
      <DocumentSection title="Summary">{completion.summaryMarkdown}</DocumentSection>
      {completion.implementationNotesMarkdown ? <DocumentSection title="Implementation details">{completion.implementationNotesMarkdown}</DocumentSection> : null}
      {completion.validationMarkdown ? <DocumentSection title="Validation">{completion.validationMarkdown}</DocumentSection> : null}
      {completion.knownLimitationsMarkdown ? <DocumentSection title="Known limitations">{completion.knownLimitationsMarkdown}</DocumentSection> : null}
      {completion.filesChanged.length ? <p><strong>Files changed:</strong> {completion.filesChanged.join(', ')}</p> : null}
      {completion.componentsChanged.length ? <p><strong>Components changed:</strong> {completion.componentsChanged.join(', ')}</p> : null}
      {completion.branch ? <p><strong>Branch:</strong> {completion.branch}</p> : null}
      {completion.commitSha ? <p><strong>Commit:</strong> {completion.commitSha}</p> : null}
      {completion.prUrl ? <p><strong>Pull request:</strong> <a href={completion.prUrl} rel="noreferrer" target="_blank">{completion.prUrl}</a></p> : null}
    </section>
  )
}

function useWorkItemAttachments(
  api: DesktopApi,
  projectId: string,
  workItemId: string,
  onError: (message: string) => void,
  onItemChanged: (item: WorkItem) => void
): {
  attachments: Attachment[]
  attachFiles(files: File[]): Promise<void>
  pasteImage(file: File): Promise<void>
  previewUrls: Record<string, string>
  removeAttachment(attachment: Attachment): Promise<void>
} {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    try {
      const nextAttachments = await api.attachments.list(projectId, workItemId)
      const previews = await Promise.all(
        nextAttachments.map(async (attachment) => [
          attachment.id,
          await api.attachments.previewUrl(projectId, workItemId, attachment.id)
        ] as const)
      )
      setAttachments(nextAttachments)
      setPreviewUrls(Object.fromEntries(previews))
    } catch (reason) {
      onError(messageFor(reason))
    }
  }, [api, onError, projectId, workItemId])

  useEffect(() => {
    void reload()
  }, [reload])

  const attachFiles = useCallback(
    async (files: File[]) => {
      try {
        for (const file of files) {
          await api.attachments.attachBytes(projectId, workItemId, await toAttachmentPayload(file))
        }
        await reload()
      } catch (reason) {
        onError(messageFor(reason))
      }
    },
    [api, onError, projectId, reload, workItemId]
  )

  const pasteImage = useCallback(
    async (file: File) => {
      try {
        await api.attachments.pasteImage(projectId, workItemId, await toAttachmentPayload(file))
        onItemChanged(await api.workItems.get(projectId, workItemId))
        await reload()
      } catch (reason) {
        onError(messageFor(reason))
      }
    },
    [api, onError, onItemChanged, projectId, reload, workItemId]
  )

  const removeAttachment = useCallback(
    async (attachment: Attachment) => {
      try {
        await api.attachments.remove(projectId, workItemId, attachment.id)
        await reload()
      } catch (reason) {
        onError(messageFor(reason))
      }
    },
    [api, onError, projectId, reload, workItemId]
  )

  return { attachments, attachFiles, pasteImage, previewUrls, removeAttachment }
}

function AttachmentPanel({
  attachments,
  onAttachFiles,
  onPasteImage,
  onRemove,
  previewUrls
}: {
  attachments: Attachment[]
  onAttachFiles(files: File[]): Promise<void>
  onPasteImage(file: File): Promise<void>
  onRemove(attachment: Attachment): Promise<void>
  previewUrls: Record<string, string>
}): JSX.Element {
  const [quickLookAttachment, setQuickLookAttachment] = useState<Attachment>()
  const handleDrop = (files: File[]): void => {
    if (files.length) {
      void onAttachFiles(files)
    }
  }
  return (
    <section className="attachments-panel" aria-labelledby="attachments-heading">
      <div className="attachments-heading">
        <div><p className="eyebrow">CONTEXT</p><h2 id="attachments-heading">Attachments</h2></div>
        <label className="secondary-button file-picker-label">
          Add attachment
          <input
            aria-label="Add attachments"
            multiple
            type="file"
            onChange={(event) => {
              handleDrop(Array.from(event.target.files ?? []))
              event.currentTarget.value = ''
            }}
          />
        </label>
      </div>
      <div
        aria-label="Drop attachments or paste screenshots here"
        className="attachment-drop-zone"
        role="region"
        tabIndex={0}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          handleDrop(Array.from(event.dataTransfer.files))
        }}
        onPaste={(event) => {
          const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'))
          if (image) {
            event.preventDefault()
            void onPasteImage(image)
          }
        }}
      >
        Drop files here, choose files, or paste a screenshot into the description editor.
      </div>
      {attachments.length ? (
        <ul className="attachment-grid">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button aria-label={`Quick Look ${attachment.originalFilename}`} className="attachment-preview-trigger" type="button" onClick={() => setQuickLookAttachment(attachment)}>
                {attachment.mimeType?.startsWith('image/') && previewUrls[attachment.id] ? (
                  <img alt={`${attachment.originalFilename} preview`} src={previewUrls[attachment.id]} />
                ) : (
                  <span className="file-thumbnail" aria-hidden="true">FILE</span>
                )}
                <span className="attachment-name">{attachment.originalFilename}</span>
                <span className="attachment-size">Press Space to Quick Look · {formatSize(attachment.sizeBytes)}</span>
              </button>
              <button type="button" onClick={() => void onRemove(attachment)}>Remove {attachment.originalFilename}</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted attachment-empty">No attachments yet.</p>}
      {quickLookAttachment ? <QuickLookSheet attachment={quickLookAttachment} previewUrl={previewUrls[quickLookAttachment.id]} onCancel={() => setQuickLookAttachment(undefined)} /> : null}
    </section>
  )
}

function QuickLookSheet({ attachment, onCancel, previewUrl }: { attachment: Attachment; onCancel(): void; previewUrl?: string }): JSX.Element {
  return (
    <Modal title="Quick Look" onCancel={onCancel}>
      <section className="quick-look" aria-label={`Quick Look ${attachment.originalFilename}`}>
        {attachment.mimeType?.startsWith('image/') && previewUrl ? <img alt={attachment.originalFilename} src={previewUrl} /> : <span aria-hidden="true" className="quick-look-file">FILE</span>}
        <h3>{attachment.originalFilename}</h3>
        <p>{attachment.mimeType ?? 'Unknown file type'} · {formatSize(attachment.sizeBytes)}</p>
      </section>
    </Modal>
  )
}

async function toAttachmentPayload(file: File): Promise<{ data: Uint8Array; originalFilename: string; mimeType?: string }> {
  return {
    data: new Uint8Array(await file.arrayBuffer()),
    originalFilename: file.name,
    mimeType: file.type || undefined
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function DocumentSection({
  attachments = [],
  children,
  previewUrls = {},
  title
}: {
  attachments?: Attachment[]
  children: string
  previewUrls?: Record<string, string>
  title: string
}): JSX.Element {
  return (
    <section className="document-section">
      <h2>{title}</h2>
      <div className="markdown-content">{renderMarkdownContent(children, attachments, previewUrls)}</div>
    </section>
  )
}

function renderMarkdownContent(
  content: string,
  attachments: Attachment[],
  previewUrls: Record<string, string>
): ReactNode {
  const imageExpression = /!\[([^\]]*)\]\(attachments\/([^)]+)\)/g
  const parts: ReactNode[] = []
  let match: RegExpExecArray | null
  let index = 0
  let cursor = 0

  while ((match = imageExpression.exec(content))) {
    if (match.index > cursor) {
      parts.push(<span key={`text-${index}`}>{content.slice(cursor, match.index)}</span>)
      index += 1
    }
    const attachment = attachments.find((candidate) => candidate.storedRelativePath.split('/').at(-1) === match?.[2])
    const previewUrl = attachment ? previewUrls[attachment.id] : undefined
    parts.push(
      previewUrl ? (
        <img alt={match[1] || 'Attached image'} className="inline-markdown-image" key={`image-${index}`} src={previewUrl} />
      ) : (
        <span key={`missing-image-${index}`}>{match[0]}</span>
      )
    )
    index += 1
    cursor = match.index + match[0].length
  }

  if (cursor < content.length || parts.length === 0) {
    parts.push(<span key={`text-${index}`}>{content.slice(cursor)}</span>)
  }
  return parts
}

function ProjectSettings({
  description,
  name,
  onDetach,
  onDelete,
  onOpenFolder,
  onSave,
  projectSettings,
  rootPath
}: {
  description: string
  name: string
  onDetach(): void
  onDelete(): void
  onOpenFolder(): void
  onSave(input: Parameters<DesktopApi['projects']['update']>[1]): Promise<void>
  projectSettings?: ProjectMetadata['settings']
  rootPath: string
}): JSX.Element {
  const [draftName, setDraftName] = useState(name)
  const [draftDescription, setDraftDescription] = useState(description)
  const [draftSettings, setDraftSettings] = useState({
    defaultLeaseSeconds: projectSettings?.defaultLeaseSeconds ?? 1800,
    heartbeatSeconds: projectSettings?.heartbeatSeconds ?? 300,
    autoReleaseExpiredClaims: projectSettings?.autoReleaseExpiredClaims ?? true,
    autoUpdateKnowledgeOnCompletion: projectSettings?.autoUpdateKnowledgeOnCompletion ?? true
  })
  useEffect(() => {
    if (projectSettings) {
      setDraftSettings({
        defaultLeaseSeconds: projectSettings.defaultLeaseSeconds,
        heartbeatSeconds: projectSettings.heartbeatSeconds,
        autoReleaseExpiredClaims: projectSettings.autoReleaseExpiredClaims,
        autoUpdateKnowledgeOnCompletion: projectSettings.autoUpdateKnowledgeOnCompletion
      })
    }
  }, [projectSettings])
  return (
    <section className="page-content settings-page" aria-labelledby="settings-heading">
      <p className="eyebrow">PROJECT</p>
      <h1 id="settings-heading">Project Settings</h1>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => {
        event.preventDefault()
        void onSave({ name: draftName, description: draftDescription, settings: projectSettings ? draftSettings : undefined })
      }}>
        <label className="field-label">Name<input aria-label="Project name" value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label>
        <label className="field-label">Description<textarea aria-label="Project description" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} /></label>
        <label className="field-label">Project folder<input aria-label="Project folder" disabled value={rootPath} /></label>
        <section className="settings-section" aria-labelledby="knowledge-settings-heading">
          <h2 id="knowledge-settings-heading">Knowledge</h2>
          <label className="field-label">Workstack data directory<input aria-label="Workstack data directory" disabled value={`${rootPath}/.workstack`} /></label>
          <label className="check-label"><input aria-label="Auto-update knowledge after completion" checked={draftSettings.autoUpdateKnowledgeOnCompletion} type="checkbox" onChange={(event) => setDraftSettings((current) => ({ ...current, autoUpdateKnowledgeOnCompletion: event.target.checked }))} />Auto-update knowledge after completion</label>
        </section>
        <section className="settings-section" aria-labelledby="agent-settings-heading">
          <h2 id="agent-settings-heading">Agents</h2>
          <label className="field-label">Default lease duration (seconds)<input aria-label="Default lease duration" min={60} required type="number" value={draftSettings.defaultLeaseSeconds} onChange={(event) => setDraftSettings((current) => ({ ...current, defaultLeaseSeconds: Number(event.target.value) }))} /></label>
          <label className="field-label">Expected heartbeat interval (seconds)<input aria-label="Expected heartbeat interval" min={30} required type="number" value={draftSettings.heartbeatSeconds} onChange={(event) => setDraftSettings((current) => ({ ...current, heartbeatSeconds: Number(event.target.value) }))} /></label>
          <label className="check-label"><input aria-label="Auto-release expired claims" checked={draftSettings.autoReleaseExpiredClaims} type="checkbox" onChange={(event) => setDraftSettings((current) => ({ ...current, autoReleaseExpiredClaims: event.target.checked }))} />Auto-release expired claims</label>
        </section>
        <div className="settings-actions"><button className="secondary-button" type="button" onClick={onOpenFolder}>Open Project Folder</button><button className="primary-button" type="submit">Save</button></div>
      </form>
      <AiProviderSettingsForm api={getDesktopApi()} />
      <McpDiagnostics />
      <section className="danger-zone">
        <h2>Detach Project</h2>
        <p>Remove this project from Workstack without deleting its `.workstack` folder or project data.</p>
        <button className="danger-button" type="button" onClick={onDetach}>Detach Project</button>
        <div className="delete-project-action">
          <h3>Delete Workstack data</h3>
          <p>Back up and remove only this project’s `.workstack` data. Your project folder and every other file stay untouched.</p>
          <button className="danger-button" type="button" onClick={onDelete}>Delete Project</button>
        </div>
      </section>
    </section>
  )
}

function ProjectDeletionSheet({
  name,
  onCancel,
  onConfirm,
  rootPath
}: {
  name: string
  onCancel(): void
  onConfirm(): Promise<void>
  rootPath: string
}): JSX.Element {
  const [confirmed, setConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!confirmed || deleting) {
      return
    }
    setDeleting(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (reason) {
      setError(messageFor(reason))
      setDeleting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <section aria-describedby="delete-project-description" aria-labelledby="delete-project-heading" aria-modal="true" className="modal deletion-modal" role="dialog">
        <p className="eyebrow">PERMANENT CHANGE</p>
        <h2 id="delete-project-heading">Delete {name} from Workstack?</h2>
        <p id="delete-project-description">Workstack will first export <strong>{rootPath}/.workstack</strong> to a recoverable backup. Only after the backup succeeds will it remove that data and this project’s registry entry.</p>
        <p>Your repository root and all non-Workstack files will remain exactly where they are.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label className="confirmation-check">
            <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
            I understand that Workstack data will be removed after its backup is created.
          </label>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" disabled={deleting} type="button" onClick={onCancel}>Cancel</button>
            <button className="danger-button" disabled={!confirmed || deleting} type="submit">{deleting ? 'Creating backup…' : 'Back up and delete project'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function McpDiagnostics(): JSX.Element {
  const command = 'npm run mcp:serve'
  return (
    <section className="settings-section" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">MCP server</h2>
      <p>Workstack exposes backlog, knowledge, coordination, and completion tools over stdio. Agents must claim work before changing it.</p>
      <label className="field-label">Launch command<input aria-label="MCP launch command" readOnly value={command} /></label>
      <dl className="diagnostic-list">
        <dt>Transport</dt><dd>stdio</dd>
        <dt>Tools</dt><dd>9 registered</dd>
        <dt>Safety</dt><dd>Claim tokens are never stored in diagnostics.</dd>
      </dl>
    </section>
  )
}

function AiProviderSettingsForm({ api }: { api: DesktopApi }): JSX.Element {
  const [settings, setSettings] = useState<{ baseUrl: string; model: string; configured: boolean }>()
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('gpt-4o-mini')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    void api.ai.settings().then((value) => {
      setSettings(value)
      setBaseUrl(value.baseUrl)
      setModel(value.model)
    })
  }, [api])

  return (
    <section className="settings-section" aria-labelledby="ai-provider-heading">
      <h2 id="ai-provider-heading">AI provider</h2>
      <p>{settings?.configured ? 'A provider key is securely configured on this Mac.' : 'No provider key is configured. Planning remains available for manual editing.'}</p>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => {
        event.preventDefault()
        void api.ai.configure({ baseUrl, model, apiKey: apiKey || undefined }).then((value) => {
          setSettings(value)
          setApiKey('')
        })
      }}>
        <label className="field-label">Provider URL<input aria-label="Provider URL" required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label className="field-label">Model<input aria-label="AI model" required value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <label className="field-label">API key<input aria-label="AI API key" autoComplete="off" placeholder={settings?.configured ? 'Leave blank to retain the configured key' : 'Enter API key'} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <button className="secondary-button" type="submit">Save AI provider</button>
      </form>
    </section>
  )
}

function ProjectSheet({
  api,
  onCancel,
  onSubmit
}: {
  api: ReturnType<typeof getDesktopApi>
  onCancel(): void
  onSubmit(input: { rootPath: string; name: string; description: string; workItemPrefix?: string }): Promise<void>
}): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [prefix, setPrefix] = useState('')
  return (
    <Modal title="New Project" onCancel={onCancel}>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({ rootPath, name, description, workItemPrefix: prefix || undefined })
      }}>
        <label className="field-label">Project name<input autoFocus required aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field-label">Description<textarea aria-label="Project description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="field-label">Project folder<div className="folder-input"><input required aria-label="Project folder" value={rootPath} onChange={(event) => setRootPath(event.target.value)} /><button className="secondary-button" type="button" onClick={() => { void api.projects.chooseFolder().then((folder) => { if (folder) setRootPath(folder) }) }}>Choose...</button></div></label>
        <label className="field-label">Work item prefix<input aria-label="Work item prefix" maxLength={6} placeholder="Derived from name" value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">Create Project</button></div>
      </form>
    </Modal>
  )
}

function WorkItemSheet({
  onCancel,
  onSubmit
}: {
  onCancel(): void
  onSubmit(input: CreateWorkItemInput): Promise<void>
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [type, setType] = useState<WorkItem['type']>('feature')
  const [priority, setPriority] = useState<WorkItem['priority']>('normal')
  return (
    <Modal title="New Work Item" onCancel={onCancel}>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({ title, descriptionMarkdown: description, acceptanceCriteriaMarkdown: criteria, type, priority })
      }}>
        <label className="field-label">Type<select aria-label="Work item type" value={type} onChange={(event) => setType(event.target.value as WorkItem['type'])}><option value="feature">Feature</option><option value="bug">Bug</option><option value="chore">Chore</option></select></label>
        <label className="field-label">Title<input autoFocus required aria-label="Work item title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-label">Description<textarea aria-label="Work item description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="field-label">Acceptance criteria<textarea aria-label="Work item acceptance criteria" value={criteria} onChange={(event) => setCriteria(event.target.value)} /></label>
        <label className="field-label">Priority<select aria-label="Work item priority" value={priority} onChange={(event) => setPriority(event.target.value as WorkItem['priority'])}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">Add to Backlog</button></div>
      </form>
    </Modal>
  )
}

function PlanningSheet({
  api,
  onCancel,
  onConvert,
  onSave,
  projectId,
  proposal
}: {
  api: DesktopApi
  onCancel(): void
  onConvert(patch: Parameters<DesktopApi['planning']['update']>[2]): Promise<void>
  onSave(patch: Parameters<DesktopApi['planning']['update']>[2]): Promise<void>
  projectId: string
  proposal: PlanningProposal
}): JSX.Element {
  const [title, setTitle] = useState(proposal.title)
  const [description, setDescription] = useState(proposal.descriptionMarkdown)
  const [requirements, setRequirements] = useState(proposal.requirementsMarkdown)
  const [criteria, setCriteria] = useState(proposal.acceptanceCriteriaMarkdown)
  const [implementationContext, setImplementationContext] = useState(proposal.implementationContextMarkdown)
  const [relatedReferences, setRelatedReferences] = useState(proposal.relatedReferences.join('\n'))
  const [type, setType] = useState(proposal.type)
  const [priority, setPriority] = useState(proposal.priority)
  const [context, setContext] = useState<PlanningContext>()
  const [contextVisible, setContextVisible] = useState(false)
  const [suggestion, setSuggestion] = useState<string>()
  const [suggestionError, setSuggestionError] = useState<string>()
  const [messages, setMessages] = useState<import('../../core/types').PlanningMessage[]>([])
  const { attachments, attachFiles, pasteImage, previewUrls, removeAttachment } = usePlanningAttachments(
    api,
    projectId,
    proposal.planningSessionId,
    setSuggestionError
  )

  useEffect(() => {
    void api.planning.listMessages(projectId, proposal.planningSessionId).then(setMessages)
  }, [api, projectId, proposal.planningSessionId])
  const contextQuery = `${title} ${description}`.trim()
  const inspectContext = async (): Promise<PlanningContext | undefined> => {
    setContextVisible(true)
    try {
      const nextContext = await api.planning.context(projectId, proposal.planningSessionId, contextQuery)
      setContext(nextContext)
      return nextContext
    } catch (reason) {
      setSuggestionError(messageFor(reason))
      return undefined
    }
  }
  const requestSuggestion = async (): Promise<void> => {
    try {
      setSuggestionError(undefined)
      const planningContext = await inspectContext()
      if (!planningContext) return
      const prompt = `Create a concise implementation suggestion for "${title}" while preserving all user-edited proposal fields. Objective: ${description}`
      await api.planning.addMessage(projectId, proposal.planningSessionId, 'user', prompt)
      const response = await api.ai.proposePlanning(projectId, proposal.planningSessionId, prompt)
      await api.planning.addMessage(projectId, proposal.planningSessionId, 'assistant', response)
      setSuggestion(response)
      setMessages(await api.planning.listMessages(projectId, proposal.planningSessionId))
    } catch (reason) {
      setSuggestionError(messageFor(reason))
    }
  }
  return (
    <Modal className="planning-modal" title="Plan with AI" onCancel={onCancel}>
      <form onKeyDown={submitOnMetaEnter} onSubmit={(event) => {
        event.preventDefault()
        void onConvert({
          title,
          type,
          descriptionMarkdown: description,
          requirementsMarkdown: requirements,
          acceptanceCriteriaMarkdown: criteria,
          implementationContextMarkdown: implementationContext,
          relatedReferences: relatedReferences.split('\n').map((reference) => reference.trim()).filter(Boolean),
          priority
        })
      }}>
        <div className="planning-context-chip" role="status">
          Using project context — {context ? `${context.knowledge.length} knowledge · ${context.completedWork.length} completed · ${context.backlogOverlap.length} backlog · ${context.planningAttachments.length} attachments` : 'inspect evidence before asking'}
        </div>
        <p className="modal-copy">Draft the proposal directly. Suggestions are separate evidence-aware notes and never overwrite your edited fields.</p>
        <div className="planning-field-grid">
          <label className="field-label">Type<select aria-label="Proposal type" value={type} onBlur={() => void onSave({ type })} onChange={(event) => setType(event.target.value as WorkItem['type'])}><option value="feature">Feature</option><option value="bug">Bug</option><option value="chore">Chore</option></select></label>
          <label className="field-label">Priority<select aria-label="Proposal priority" value={priority} onBlur={() => void onSave({ priority })} onChange={(event) => setPriority(event.target.value as WorkItem['priority'])}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
        </div>
        <label className="field-label">Proposal title<input required aria-label="Proposal title" value={title} onBlur={() => void onSave({ title })} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-label">Objective<textarea aria-label="Proposal objective" value={description} onBlur={() => void onSave({ descriptionMarkdown: description })} onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="field-label">Requirements<textarea aria-label="Proposal requirements" value={requirements} onBlur={() => void onSave({ requirementsMarkdown: requirements })} onChange={(event) => setRequirements(event.target.value)} /></label>
        <label className="field-label">Acceptance criteria<textarea aria-label="Proposal acceptance criteria" value={criteria} onBlur={() => void onSave({ acceptanceCriteriaMarkdown: criteria })} onChange={(event) => setCriteria(event.target.value)} /></label>
        <label className="field-label">Implementation context<textarea aria-label="Proposal implementation context" value={implementationContext} onBlur={() => void onSave({ implementationContextMarkdown: implementationContext })} onChange={(event) => setImplementationContext(event.target.value)} /></label>
        <label className="field-label">Related work and references<textarea aria-label="Proposal related references" placeholder="One work item ID, wiki article, or note per line" value={relatedReferences} onBlur={() => void onSave({ relatedReferences: relatedReferences.split('\n').map((reference) => reference.trim()).filter(Boolean) })} onChange={(event) => setRelatedReferences(event.target.value)} /></label>
        <section className="planning-attachments" aria-labelledby="planning-attachments-heading">
          <div className="section-heading"><h3 id="planning-attachments-heading">Planning evidence</h3><label className="secondary-button file-picker-label">Attach files<input aria-label="Attach planning files" multiple type="file" onChange={(event) => { void attachFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} /></label></div>
          <div aria-label="Drop planning evidence or paste screenshots here" className="attachment-drop-zone" role="region" tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void attachFiles(Array.from(event.dataTransfer.files)) }} onPaste={(event) => { const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/')); if (image) { event.preventDefault(); void pasteImage(image) } }}>
            Drop files here, choose files, or paste a screenshot.
          </div>
          {attachments.length ? <ul className="attachment-grid">{attachments.map((attachment) => <li key={attachment.id}>{attachment.mimeType?.startsWith('image/') && previewUrls[attachment.id] ? <img alt={`${attachment.originalFilename} preview`} src={previewUrls[attachment.id]} /> : <span className="file-thumbnail" aria-hidden="true">FILE</span>}<span className="attachment-name">{attachment.originalFilename}</span><span className="attachment-size">{formatSize(attachment.sizeBytes)}</span><button type="button" onClick={() => void removeAttachment(attachment)}>Remove {attachment.originalFilename}</button></li>)}</ul> : <p className="muted attachment-empty">No planning evidence attached yet.</p>}
        </section>
        <section className="planning-suggestion" aria-labelledby="planning-suggestion-heading">
          <div className="section-heading"><h3 id="planning-suggestion-heading">AI suggestion</h3><button className="secondary-button" type="button" onClick={() => void requestSuggestion()}>Request suggestion</button></div>
          <p className="muted">Suggestions never overwrite your proposal. Apply relevant details manually.</p>
          {suggestion ? <p>{suggestion}</p> : null}
          {suggestionError ? <p role="alert">{suggestionError}</p> : null}
          {messages.length ? <ol className="planning-messages" aria-label="Planning conversation">{messages.map((message) => <li key={message.id}><strong>{message.role}</strong><span>{message.contentMarkdown}</span></li>)}</ol> : null}
        </section>
        <section className="planning-context" aria-labelledby="planning-context-heading">
          <div className="section-heading"><h3 id="planning-context-heading">Context inspector</h3><button className="secondary-button" type="button" onClick={() => void inspectContext()}>Inspect context</button></div>
          {contextVisible ? context ? <ContextEvidence context={context} /> : <p className="muted">No matching project context was retrieved.</p> : <p className="muted">Inspect project identity, matching knowledge, completed work, backlog overlap, and attachment metadata.</p>}
        </section>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">Add to Backlog</button></div>
      </form>
    </Modal>
  )
}

function usePlanningAttachments(
  api: DesktopApi,
  projectId: string,
  sessionId: string,
  onError: (message: string) => void
): {
  attachments: Attachment[]
  attachFiles(files: File[]): Promise<void>
  pasteImage(file: File): Promise<void>
  previewUrls: Record<string, string>
  removeAttachment(attachment: Attachment): Promise<void>
} {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const reload = useCallback(async () => {
    try {
      const next = await api.planning.listAttachments(projectId, sessionId)
      const previews = await Promise.all(next.map(async (attachment) => [attachment.id, await api.planning.previewAttachmentUrl(projectId, sessionId, attachment.id)] as const))
      setAttachments(next)
      setPreviewUrls(Object.fromEntries(previews))
    } catch (reason) {
      onError(messageFor(reason))
    }
  }, [api, onError, projectId, sessionId])
  useEffect(() => { void reload() }, [reload])
  const attachFiles = useCallback(async (files: File[]) => {
    try {
      for (const file of files) await api.planning.attachBytes(projectId, sessionId, await toAttachmentPayload(file))
      await reload()
    } catch (reason) {
      onError(messageFor(reason))
    }
  }, [api, onError, projectId, reload, sessionId])
  const pasteImage = useCallback(async (file: File) => {
    try {
      await api.planning.pasteImage(projectId, sessionId, await toAttachmentPayload(file))
      await reload()
    } catch (reason) {
      onError(messageFor(reason))
    }
  }, [api, onError, projectId, reload, sessionId])
  const removeAttachment = useCallback(async (attachment: Attachment) => {
    try {
      await api.planning.removeAttachment(projectId, sessionId, attachment.id)
      await reload()
    } catch (reason) {
      onError(messageFor(reason))
    }
  }, [api, onError, projectId, reload, sessionId])
  return { attachments, attachFiles, pasteImage, previewUrls, removeAttachment }
}

function ContextEvidence({ context }: { context: PlanningContext }): JSX.Element {
  const sections: Array<{ label: string; items: PlanningContext['knowledge'] }> = [
    { label: 'Knowledge', items: context.knowledge },
    { label: 'Completed work', items: context.completedWork },
    { label: 'Backlog overlap', items: context.backlogOverlap },
    { label: 'Planning attachments', items: context.planningAttachments }
  ]
  return (
    <div className="context-evidence">
      <p><strong>{context.project.name}</strong>{context.project.description ? ` — ${context.project.description}` : ''}</p>
      {sections.map((section) => section.items.length ? <section key={section.label}><h4>{section.label}</h4><ul>{section.items.map((item) => <li key={`${item.kind}-${item.sourceId}`}><strong>{item.title}</strong><span>{item.excerpt}</span>{item.metadata ? <small>{Object.entries(item.metadata).map(([key, value]) => `${key}: ${value ?? 'unknown'}`).join(' · ')}</small> : null}</li>)}</ul></section> : null)}
      {!sections.some((section) => section.items.length) ? <p className="muted">No matching project context was retrieved.</p> : null}
    </div>
  )
}

function Modal({ children, className, onCancel, title }: { children: ReactNode; className?: string; onCancel(): void; title: string }): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="modal-heading" aria-modal="true" className={`modal ${className ?? ''}`} role="dialog" onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}>
        <header><h2 id="modal-heading">{title}</h2><button aria-label={`Close ${title}`} className="icon-button" type="button" onClick={onCancel}>x</button></header>
        {children}
      </section>
    </div>
  )
}

function ReleaseClaimSheet({
  claim,
  onCancel,
  onSubmit
}: {
  claim: WorkClaim
  onCancel(): void
  onSubmit(reason: string): Promise<void>
}): JSX.Element {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <Modal title="Release agent claim" onCancel={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitting(true)
          void onSubmit(reason).catch(() => setSubmitting(false))
        }}
      >
        <p className="modal-copy">A recent heartbeat is recorded for this agent.</p>
        <p className="modal-copy">Releasing {claim.agentDisplayName ?? claim.agentId} immediately invalidates its claim token.</p>
        <label className="field-label">
          Release reason
          <textarea
            required
            aria-label="Release reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary-button" disabled={submitting} type="button" onClick={onCancel}>Cancel</button>
          <button className="danger-button" disabled={submitting} type="submit">Release claim</button>
        </div>
      </form>
    </Modal>
  )
}

function TypeBadge({ type }: { type: WorkItem['type'] }): JSX.Element {
  return <span className="badge type-badge">{type}</span>
}

function PriorityBadge({ priority }: { priority: WorkItem['priority'] }): JSX.Element {
  return <span className={`priority priority-${priority}`}>{priority}</span>
}

function StatusBadge({ status }: { status: WorkItem['status'] }): JSX.Element {
  const label = status === 'in_progress' ? 'In Progress' : status[0].toUpperCase() + status.slice(1)
  return <span className={`status status-${status}`}><span aria-hidden="true" className="status-icon" />{label}</span>
}

function ClaimStatusStrip({ claim, onForceRelease, onViewAgentDetails }: { claim: WorkClaim; onForceRelease(): void; onViewAgentDetails?(): void }): JSX.Element {
  const owner = claim.agentDisplayName ?? claim.agentId
  return (
    <section className={`claim-status-strip claim-${claimHealth(claim)}`}>
      <div>
        <p aria-label={`Active claim for ${owner}`} role="status">
          <span className="claim-status-title">Agent work is active</span>
          <ClaimHealthBadge claim={claim} />
        </p>
        <p className="claim-status-meta">
          {owner}{claim.sessionId ? ` · Session ${claim.sessionId}` : ''}
          {claim.blockedReason ? ` · ${claim.blockedReason}` : ''}
        </p>
      </div>
      <div className="claim-status-actions">
        {onViewAgentDetails ? <button className="secondary-button" type="button" onClick={onViewAgentDetails}>View agent details</button> : null}
        <button className="danger-button" type="button" onClick={onForceRelease}>Force release</button>
      </div>
    </section>
  )
}

function AgentDetailSheet({
  api,
  claim,
  item,
  onCancel,
  projectId
}: {
  api: DesktopApi
  claim: WorkClaim
  item: WorkItem
  onCancel(): void
  projectId: string
}): JSX.Element {
  const [actions, setActions] = useState<import('../../core/types').ActivityEvent[]>([])
  const name = claim.agentDisplayName ?? claim.agentId
  useEffect(() => {
    let current = true
    void api.activity.list(projectId).then((events) => {
      if (current) setActions(events.filter((event) => event.actorType === 'agent' && event.actorId === claim.agentId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 8))
    }).catch(() => {
      if (current) setActions([])
    })
    return () => { current = false }
  }, [api, claim.agentId, projectId])
  return (
    <Modal title="Agent details" onCancel={onCancel}>
      <section className="agent-detail-sheet" aria-label={`Details for ${name}`}>
        <div className="agent-identity"><span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div><h3>{name}</h3><p>{claim.agentId}{claim.sessionId ? ` · Session ${claim.sessionId}` : ''}</p></div></div>
        <dl>
          <dt>Current work item</dt><dd>{item.displayId} · {item.title}</dd>
          <dt>Claimed</dt><dd>{formatDateTime(claim.claimedAt)}</dd>
          <dt>Last heartbeat</dt><dd>{formatDateTime(claim.lastHeartbeatAt)}</dd>
          <dt>Lease expires</dt><dd>{formatDateTime(claim.leaseExpiresAt)} · <ClaimHealthBadge claim={claim} /></dd>
        </dl>
        <section aria-labelledby="agent-actions-heading"><h3 id="agent-actions-heading">Recent Workstack actions</h3>{actions.length ? <ol className="agent-actions">{actions.map((action) => <li key={action.id}><strong>{action.eventType.replaceAll('_', ' ')}</strong><span>{formatDateTime(action.createdAt)}</span></li>)}</ol> : <p className="muted">No agent actions have been recorded yet.</p>}</section>
      </section>
    </Modal>
  )
}

function ClaimHealthBadge({ claim }: { claim: WorkClaim }): JSX.Element {
  const health = claimHealth(claim)
  return <span className={`claim-health claim-health-${health}`}><span aria-hidden="true" className="claim-health-icon" />{health === 'healthy' ? 'Healthy' : 'Attention'}</span>
}

function claimHealth(claim: WorkClaim): 'healthy' | 'attention' {
  if (claim.blockedReason) {
    return 'attention'
  }
  return new Date(claim.leaseExpiresAt).getTime() - Date.now() <= 5 * 60 * 1000 ? 'attention' : 'healthy'
}

function submitOnMetaEnter(event: ReactKeyboardEvent<HTMLFormElement>): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    event.currentTarget.requestSubmit()
  }
}

function copyTextFallback(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value))
}

function formatHistoryDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function matchesCreatedPeriod(value: string, period: string): boolean {
  const age = Date.now() - new Date(value).getTime()
  const day = 24 * 60 * 60 * 1000
  if (period === 'today') return age >= 0 && age < day
  if (period === 'week') return age >= 0 && age <= 7 * day
  if (period === 'month') return age >= 0 && age <= 30 * day
  return age > 30 * day
}

function priorityRank(priority: WorkItem['priority']): number {
  return { high: 0, normal: 1, low: 2 }[priority]
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Something went wrong. Please try again.'
}

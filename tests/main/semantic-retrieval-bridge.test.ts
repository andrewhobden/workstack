import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { KnowledgeChatAgent, KnowledgeChatRepository, type AgentChatCompletion } from '../../src/core/knowledge-chat'
import { WorkstackMcpTools } from '../../src/mcp/server'
import { registerIpcHandlers } from '../../src/main/ipc'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { OpenAiCompatibleProvider } from '../../src/main/ai-provider'
import type { CopilotLauncher } from '../../src/main/copilot-launcher'
import type { PullRequestService } from '../../src/main/pull-requests'
import type { WikiAutomationService } from '../../src/main/wiki-automation-service'
import type { KnowledgeRetrievalResponse } from '../../src/core/knowledge-retrieval-contracts'

const transport = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), api: undefined as DesktopApi | undefined, selection: { canceled: true, filePaths: [] as string[] } }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => transport.handlers.set(name, handler) },
  ipcRenderer: { invoke: async (name: string, ...args: unknown[]) => transport.handlers.get(name)!({}, ...args) },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { transport.api = api } },
  BrowserWindow: {}, dialog: { showOpenDialog: async () => transport.selection }, shell: {}, safeStorage: {}
}))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); transport.handlers.clear(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('uses one cited semantic result through desktop, MCP, planning, chat and persisted task context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workstack-semantic-bridge-')); roots.push(root)
  const projects = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
  const processJobs = projects.processSemanticJobs.bind(projects)
  const background = vi.spyOn(projects, 'processSemanticJobs').mockResolvedValue(undefined)
  registerIpcHandlers(projects, {} as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.api!
  const project = await api.projects.create({ rootPath: path.join(root, 'project'), name: 'Offline context' })
  const source = await api.knowledge.addSource(project.id, { displayName: 'Background processing', filename: 'design.md', content: 'Durable queue.' })
  const task = await api.workItems.create(project.id, { title: 'resilient scheduler' })
  expect(await api.semantic.status(project.id)).toMatchObject({ enabled: false })
  await expect(api.semantic.status('not-a-project')).rejects.toThrow()
  expect(await api.semantic.chooseModel(project.id)).toBeUndefined()
  const modelPath = path.join(root, 'vectors.json')
  await writeFile(modelPath, JSON.stringify({ formatVersion: 1, modelId: 'bridge-fixture', version: '1', dimensions: 2, vocabulary: { durable: [1, 0], queue: [1, 0], resilient: [1, 0], scheduler: [1, 0] } }))
  transport.selection = { canceled: false, filePaths: [modelPath] }
  expect(await api.semantic.chooseModel(project.id)).toMatchObject({ enabled: true, indexedPassages: 0, jobs: [{ status: 'pending' }] })
  expect(background).toHaveBeenCalledWith(project.id)
  await processJobs(project.id)
  const result = await api.knowledge.retrieve(project.id, 'resilient scheduler')
  expect(result.mode).toBe('hybrid')
  const passage = result.results.find((entry) => entry.canonicalSourceId === source.id)!
  expect(passage).toMatchObject({ text: 'Durable queue.', citation: { sourceId: source.id }, diagnostics: { semanticRank: 1 } })
  const mcp = await new WorkstackMcpTools(projects).call('workstack_search_knowledge', { project_id: project.id, query: 'resilient scheduler' }) as { mode: string; corpus_revision: string; config_fingerprint: string; results: Array<Record<string, unknown>> }
  expect(mcp).toMatchObject({ mode: result.mode, corpus_revision: result.corpusRevision, config_fingerprint: result.configFingerprint })
  expect(mcp.results.find((entry) => entry.canonical_source_id === source.id)).toMatchObject({ citation: passage.citation, text: passage.text, provenance: passage.provenance, diagnostics: passage.diagnostics })
  const planning = await projects.createPlanningSession(project.id)
  const context = await projects.getPlanningContext(project.id, planning.planningSessionId, 'resilient scheduler')
  expect(context.knowledge[0]).toMatchObject({ sourceId: source.id, excerpt: passage.text, metadata: { citation: JSON.stringify(passage.citation), retrievalMode: 'hybrid', corpusRevision: result.corpusRevision, configFingerprint: result.configFingerprint } })
  const store = await ProjectStore.open(project.rootPath)
  try {
    const session = new KnowledgeChatRepository(store).createSession()
    const responses: AgentChatCompletion[] = [{ toolCalls: [{ id: 'search-fixture', name: 'search_knowledge', arguments: { query: 'resilient scheduler', limit: 40 } }] }, { content: 'Cited queue evidence located.' }]
    const chat = await new KnowledgeChatAgent(store, { completeChat: async () => responses.shift()! }).sendMessage(session.id, 'Find the project context.')
    const chatResult = chat.toolCalls[0].result!.retrieval as KnowledgeRetrievalResponse
    expect(chatResult).toEqual(result)
  } finally { store.close() }
  const packet = await projects.previewContextPacket(project.id, task.id)
  expect(packet.retrieval).toMatchObject({ mode: 'hybrid', corpusRevision: result.corpusRevision, configFingerprint: result.configFingerprint })
  expect(packet.manifest).toContainEqual({ sourceId: source.id, revisionId: passage.citation!.revisionId, contentHash: passage.citation!.contentHash, normalizedHash: passage.citation!.normalizedHash })
  expect(packet.sections.flatMap((section) => section.citations)).toContainEqual(passage.citation)
  expect(await api.semantic.reindex(project.id)).toMatchObject({ indexedPassages: 0, jobs: [{ status: 'pending' }] })
  const job = (await api.semantic.status(project.id)).jobs[0]
  expect(await api.semantic.cancel(project.id, job.id)).toMatchObject({ jobs: [{ status: 'failed' }] })
  expect(await api.semantic.retry(project.id, job.id)).toMatchObject({ jobs: [{ status: 'pending' }] })
  await expect(api.semantic.cancel(project.id, 'invalid')).rejects.toThrow()
  await processJobs(project.id)
  const reopened = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
  expect(await reopened.semanticStatus(project.id)).toMatchObject({ indexedPassages: 1, model: { modelId: 'bridge-fixture' } })
  expect(await api.semantic.disable(project.id)).toMatchObject({ enabled: false })
  expect(await api.knowledge.retrieve(project.id, 'queue')).toMatchObject({ mode: 'lexical', fallbackReason: 'No local semantic model is enabled.' })
  const changedStore = await ProjectStore.open(project.rootPath)
  try { new SourceCatalogRepository(changedStore).updatePolicy(source.id, 'paused') } finally { changedStore.close() }
  expect((await api.knowledge.retrieve(project.id, 'queue')).results).toEqual([])
})

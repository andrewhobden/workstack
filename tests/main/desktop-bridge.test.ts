import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectStore } from '../../src/core/project-store'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { ProjectRegistry } from '../../src/core/project-registry'
import { registerIpcHandlers } from '../../src/main/ipc'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { OpenAiCompatibleProvider } from '../../src/main/ai-provider'
import type { CopilotLauncher } from '../../src/main/copilot-launcher'
import type { PullRequestService } from '../../src/main/pull-requests'
import type { WikiAutomationService } from '../../src/main/wiki-automation-service'

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  exposed: undefined as DesktopApi | undefined
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => transport.handlers.set(name, handler) },
  ipcRenderer: { invoke: async (name: string, ...args: unknown[]) => {
    const handler = transport.handlers.get(name)
    if (!handler) throw new Error(`Unregistered IPC channel: ${name}`)
    return handler({}, ...args)
  } },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { transport.exposed = api } },
  BrowserWindow: {}, dialog: {}, shell: {}, safeStorage: {}
}))

const directories: string[] = []
afterEach(async () => {
  transport.handlers.clear()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

it('runs the actual preload and registered IPC patches, planning conversion and attachments against reopened SQLite storage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-ipc-'))
  directories.push(directory)
  const registryPath = path.join(directory, 'registry.json')
  const service = new ProjectsService(new ProjectRegistry(registryPath))
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'IPC boundary' })
  const createInput = { title: 'Original', requestId: randomUUID() }
  const item = await api.workItems.create(project.id, createInput)
  expect((await api.workItems.create(project.id, createInput)).id).toBe(item.id)
  expect(await api.workItems.list(project.id)).toHaveLength(1)
  const edited = await api.workItems.update(project.id, item.id, { title: 'Edited through IPC', descriptionMarkdown: 'Durable description', priority: 'high' })
  expect(edited).toMatchObject({ title: 'Edited through IPC', priority: 'high' })
  expect(() => transport.handlers.get('work-items:update')!({}, project.id, item.id, { title: 'Bad', workItemId: item.id })).toThrow()
  const proposal = await api.planning.create(project.id)
  const saved = await api.planning.update(project.id, proposal.planningSessionId, { title: 'Implementation plan', requirementsMarkdown: 'Preserve hand edits', acceptanceCriteriaMarkdown: 'Persistence verified' })
  expect(saved.userModifiedFields).toContain('requirementsMarkdown')
  expect(() => transport.handlers.get('planning:update')!({}, project.id, proposal.planningSessionId, { status: 'converted' })).toThrow()
  const attachment = await api.planning.attachBytes(project.id, proposal.planningSessionId, { data: new Uint8Array([65, 66, 67]), originalFilename: 'context.txt', mimeType: 'text/plain' })
  expect(await api.planning.previewAttachmentUrl(project.id, proposal.planningSessionId, attachment.id)).toBe('data:text/plain;base64,QUJD')
  const converted = await api.planning.convert(project.id, proposal.planningSessionId)
  expect(converted.title).toBe('Implementation plan')
  const attachmentInput = { requestId: randomUUID(), data: new Uint8Array([68, 69, 70]), originalFilename: 'result.txt', mimeType: 'text/plain' }
  const evidence = await api.attachments.attachBytes(project.id, item.id, attachmentInput)
  expect((await api.attachments.attachBytes(project.id, item.id, attachmentInput)).id).toBe(evidence.id)
  expect(await api.attachments.list(project.id, item.id)).toHaveLength(1)
  const reopened = new ProjectsService(new ProjectRegistry(registryPath))
  expect(await reopened.getWorkItem(project.id, item.id)).toMatchObject({ title: edited.title, descriptionMarkdown: edited.descriptionMarkdown, priority: 'high' })
  expect((await reopened.listAttachments(project.id, converted.id)).length).toBe(1)
  expect(await reopened.readAttachment(project.id, item.id, evidence.id).then((result) => result.data.toString())).toBe('DEF')
})

it('sends the inspected immutable planning context through preload and cancels a running provider call', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-context-ipc-'))
  directories.push(directory)
  const service = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
  const propose = vi.fn((_prompt: string, _context: unknown, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Cancelled by user')), { once: true })
  }))
  const provider = { proposePlanning: propose, cancelRequest: () => true } as unknown as OpenAiCompatibleProvider
  registerIpcHandlers(service, provider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Context' })
  const plan = await api.planning.create(project.id)
  await api.planning.update(project.id, plan.planningSessionId, { title: 'Inspected title', requirementsMarkdown: 'Include the user requirements' })
  const context = await api.planning.context(project.id, plan.planningSessionId, 'Inspected title')
  await api.planning.update(project.id, plan.planningSessionId, { title: 'Later title' })
  const requestId = randomUUID()
  const pending = api.ai.proposePlanning(project.id, plan.planningSessionId, 'Use the inspected evidence', context.id, requestId)
  const rejected = expect(pending).rejects.toThrow('Cancelled by user')
  await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
  expect(propose.mock.calls[0][1]).toMatchObject({ id: context.id, query: 'Inspected title', proposal: { title: 'Inspected title', requirementsMarkdown: 'Include the user requirements' } })
  await api.ai.cancel(requestId)
  await rejected
})

it('cancels an advanced shell operation through the desktop bridge after the provider request has finished', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-chat-cancel-ipc-'))
  directories.push(directory)
  const service = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
  const completeChat = vi.fn(async () => ({ toolCalls: [
    { id: 'running-shell', name: 'run_bash', arguments: { command: "printf 'retained evidence\\n'; printf ready > started.txt; sleep 30" } },
    { id: 'skipped-proposal', name: 'request_create_work_item', arguments: { title: 'Do not draft after cancellation' } }
  ] }))
  const cancelRequest = vi.fn(() => false)
  registerIpcHandlers(service, { completeChat, cancelRequest } as unknown as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Shell cancellation' })
  await api.projects.update(project.id, { settings: { knowledgeChatProfile: 'advanced' } })
  const session = await api.knowledgeChat.createSession(project.id)
  const requestId = randomUUID()
  const pending = api.knowledgeChat.sendMessage(project.id, session.id, 'Inspect local evidence', requestId)
  const settled = pending.then(
    () => ({ status: 'resolved' }),
    (error: unknown) => ({ status: 'rejected', error })
  )
  try {
    await vi.waitFor(async () => expect(await readFile(path.join(project.rootPath, 'started.txt'), 'utf8')).toBe('ready'), { timeout: 10_000, interval: 50 })
    expect(await api.ai.cancel(requestId)).toBe(true)
  } finally {
    await api.ai.cancel(requestId)
    expect(await settled).toMatchObject({ status: 'rejected', error: { code: 'CANCELLED' } })
  }
  expect(completeChat).toHaveBeenCalledOnce()
  expect(cancelRequest).toHaveBeenCalledWith(requestId)
  expect(await api.knowledgeChat.listToolCalls(project.id, session.id)).toMatchObject([
    { providerCallId: 'running-shell', status: 'failed', result: { cancelled: true, stdout: 'retained evidence\n' } },
    { providerCallId: 'skipped-proposal', status: 'failed', result: { cancelled: true } }
  ])
  expect(await api.knowledgeChat.listPendingActions(project.id, session.id)).toEqual([])
  expect((await api.knowledgeChat.listMessages(project.id, session.id))[0].contentMarkdown).toBe('Inspect local evidence')
  expect(await api.ai.cancel(requestId)).toBe(false)
}, 20_000)

it('preserves active ownership when restart preflight or process shutdown fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-restart-ipc-'))
  directories.push(directory)
  const service = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
  let supported = false
  let shutdownFails = true
  const restart = vi.fn(async (_project: unknown, _item: unknown, beforeLaunch?: () => Promise<void>) => {
    if (shutdownFails) throw new Error('Agent process did not stop')
    await beforeLaunch?.()
  })
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, {
    preflight: async () => ({ supported, reason: 'Profile cannot be enforced' }), restart
  } as unknown as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Restart ownership' })
  const item = await api.workItems.create(project.id, { title: 'Active task' })
  const owned = await service.claimWorkItem(project.id, item.id, { agentId: 'current-worker' })
  await expect(api.workItems.restart(project.id, item.id)).rejects.toThrow('Profile cannot be enforced')
  expect(restart).not.toHaveBeenCalled()
  expect((await service.getActiveClaim(project.id, item.id))?.id).toBe(owned.claim.id)
  supported = true
  await expect(api.workItems.restart(project.id, item.id)).rejects.toThrow('Agent process did not stop')
  expect((await service.getActiveClaim(project.id, item.id))?.id).toBe(owned.claim.id)
  shutdownFails = false
  await api.workItems.restart(project.id, item.id)
  expect(await service.getActiveClaim(project.id, item.id)).toBeUndefined()
  expect((await api.workItems.get(project.id, item.id)).status).toBe('backlog')
})


it('reads immutable source evidence and reviews staged wiki changes through actual preload and IPC', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-knowledge-ipc-'))
  directories.push(directory)
  const service = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Versioned knowledge' })
  const source = await api.knowledge.addSource(project.id, { displayName: 'Ownership policy', filename: 'ownership.md', content: '# Ownership\n\nFenced Narwhal claims preserve ownership.\n' })
  expect(await api.sourceCatalog.list(project.id)).toContainEqual(expect.objectContaining({ id: source.id, state: 'ready' }))
  const passages = await api.sourceCatalog.search(project.id, 'Narwhal')
  expect(passages).toHaveLength(1)
  const citation = passages[0].citation
  const reordered = Object.fromEntries(Object.entries(citation).reverse()) as typeof citation
  expect((await api.sourceCatalog.readCitation(project.id, reordered, 1)).passage.text).toContain('Fenced Narwhal')
  expect((await api.sourceCatalog.readRevision(project.id, source.id, citation.revisionId, 'original')).text).toContain('# Ownership')
  await api.sourceCatalog.setPolicy(project.id, source.id, 'paused')
  expect(await api.sourceCatalog.search(project.id, 'Narwhal')).toEqual([])
  expect((await api.sourceCatalog.readCitation(project.id, citation)).passage.readiness).toBe('stale')
  const store = await ProjectStore.open(project.rootPath)
  let revisionId: string
  try { revisionId = new WikiRevisionRepository(store).stage({ requestKey: 'desktop-review', title: 'Review ownership knowledge', pages: [{ slug: 'generated-ownership', content: '# Ownership\nReviewed Bottlenose ownership contract.' }], author: 'test-worker', rationale: 'Record verified behavior' }).revision.id }
  finally { store.close() }
  expect((await api.wikiRevisions.review(project.id, revisionId)).revision.status).toBe('proposed')
  expect((await api.knowledge.listWiki(project.id)).some((article) => article.slug === 'generated-ownership')).toBe(false)
  await api.wikiRevisions.publish(project.id, revisionId, 'desktop-reviewer', 'Verified against implementation')
  expect((await api.knowledge.listWiki(project.id)).find((article) => article.slug === 'generated-ownership')?.content).toContain('Reviewed Bottlenose')
  expect((await api.wikiRevisions.list(project.id)).find((revision) => revision.id === revisionId)).toMatchObject({ actor: 'desktop-reviewer', reviewNote: 'Verified against implementation', status: 'published' })
})

it('edits, reviews and supersedes typed guidance and resolves directory ambiguity through the actual desktop bridge', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-structured-ipc-'))
  directories.push(directory)
  const service = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Structured knowledge' })
  await api.knowledge.addSource(project.id, { displayName: 'Adapter evidence', filename: 'adapter.md', content: '# Adapter\n\nThe Adapter owns requests.\n' })
  await api.sourceCatalog.list(project.id)
  const citation = (await api.sourceCatalog.search(project.id, 'Adapter'))[0].citation
  const record = await api.knowledgeRecords.create(project.id, { kind: 'decision', title: 'Use an adapter', status: 'accepted', markdown: 'Route requests through the adapter.', rationale: 'Preserve one ownership boundary.', confidence: 0.8, reviewDueAt: '2020-01-01T00:00:00.000Z', references: [{ kind: 'source', citation }] }, 'desktop-owner')
  expect((await api.knowledgeRecords.checks(project.id)).some((finding) => finding.recordId === record.id && finding.code === 'review_due')).toBe(true)
  const edited = await api.knowledgeRecords.update(project.id, record.id, { expectedVersion: record.version, title: 'Use the project adapter', confidence: null, reviewDueAt: null }, 'desktop-owner', 'Clarify the scope.')
  expect(edited.confidence).toBeUndefined()
  expect(edited.reviewDueAt).toBeUndefined()
  await expect(api.knowledgeRecords.review(project.id, record.id, 'desktop-reviewer', 'This review used an outdated draft.', 'confirmed', record.version)).rejects.toThrow()
  await api.knowledgeRecords.review(project.id, record.id, 'desktop-reviewer', 'Verified the cited ownership boundary.', 'confirmed')
  expect(await api.knowledgeRecords.reviews(project.id, record.id)).toContainEqual(expect.objectContaining({ actor: 'desktop-reviewer', outcome: 'confirmed' }))
  const replacement = await api.knowledgeRecords.create(project.id, { kind: 'decision', title: 'Use explicit adapters', status: 'accepted', markdown: 'Name each adapter explicitly.', references: [{ kind: 'source', citation }] }, 'desktop-owner')
  expect(await api.knowledgeRecords.supersede(project.id, record.id, replacement.id, 'desktop-owner', 'The replacement records each adapter.')).toMatchObject({ status: 'superseded', supersededBy: replacement.id })
  expect(await api.knowledgeRecords.history(project.id, record.id)).toContainEqual(expect.objectContaining({ reason: 'Clarify the scope.' }))
  expect(await api.knowledgeRecords.list(project.id)).toContainEqual(expect.objectContaining({ id: record.id, status: 'superseded' }))
  const alpha = await api.projectDirectory.create(project.id, { kind: 'component', displayName: 'Request adapter', aliases: ['Adapter'], definition: 'Owns incoming requests.', references: [{ kind: 'source', citation }] }, 'desktop-owner')
  const beta = await api.projectDirectory.create(project.id, { kind: 'component', displayName: 'Legacy adapter', aliases: ['Adapter'], definition: 'Historical adapter name.' }, 'desktop-owner')
  expect((await api.projectDirectory.lookup(project.id, 'Adapter')).match).toBe('ambiguous')
  const mention = (await api.projectDirectory.detail(project.id, alpha.id)).mentions.find((entry) => entry.surface === 'Adapter')!
  expect(mention.resolution).toBe('candidate')
  expect(await api.projectDirectory.resolveMention(project.id, mention.id, alpha.id, 'desktop-owner', 'This section describes request ownership.')).toMatchObject({ resolution: 'resolved', entityId: alpha.id })
  const merged = await api.projectDirectory.merge(project.id, beta.id, alpha.id, { actor: 'desktop-owner', reason: 'These are the same component.', expectedSourceVersion: beta.version, expectedTargetVersion: alpha.version })
  expect((await api.projectDirectory.detail(project.id, beta.id)).canonicalEntity.id).toBe(alpha.id)
  const split = await api.projectDirectory.split(project.id, alpha.id, { actor: 'desktop-owner', reason: 'The abbreviation describes a separate helper.', expectedVersion: merged.entity.version, entry: { kind: 'component', displayName: 'Adapter helper', definition: 'Maps helper requests.' }, aliases: ['Adapter'], mentionIds: [mention.id] })
  expect(split.entity.displayName).toBe('Adapter helper')
  expect((await api.projectDirectory.detail(project.id, split.entity.id)).mentions).toContainEqual(expect.objectContaining({ id: mention.id, entityId: split.entity.id }))
  const other = await api.projects.create({ rootPath: path.join(directory, 'other'), name: 'Isolated project' })
  expect(await api.knowledgeRecords.list(other.id)).toEqual([])
  expect(await api.projectDirectory.list(other.id)).toEqual([])
})

it('persists exact task context, readiness approvals and reviewable feedback through actual preload and IPC', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-task-context-ipc-'))
  directories.push(directory)
  const registryPath = path.join(directory, 'registry.json')
  const service = new ProjectsService(new ProjectRegistry(registryPath))
  registerIpcHandlers(service, {} as OpenAiCompatibleProvider, {} as CopilotLauncher, {} as PullRequestService, {} as WikiAutomationService)
  await import('../../src/preload/index')
  const api = transport.exposed!
  const project = await api.projects.create({ rootPath: path.join(directory, 'project'), name: 'Exact task context' })
  const task = await api.workItems.create(project.id, { title: 'Preserve Narwhal ownership', descriptionMarkdown: 'Trace the request owner.' })
  const source = await api.knowledge.addSource(project.id, { displayName: 'Narwhal architecture', filename: 'architecture.md', content: '# Narwhal ownership\n\nEvery request has one inspectable owner.\n' })
  await api.sourceCatalog.list(project.id)
  const policy = await api.contextPackets.policy(project.id)
  await api.contextPackets.updatePolicy(project.id, { expectedVersion: policy.version, requirements: [{ category: 'purpose', severity: 'soft' }], sourcePins: [{ sourceId: source.id, category: 'architecture' }], requiredRecordIds: [], allowSoftOverride: true, tokenBudget: 8000, operatorInstructions: 'Preserve the request ownership boundary.' })
  const preview = await api.contextPackets.preview(project.id, task.id)
  expect(preview.canExecute).toBe(false)
  expect(preview.gaps).toContainEqual(expect.objectContaining({ category: 'purpose', severity: 'soft' }))
  const approved = await api.contextPackets.preview(project.id, task.id, { packetId: preview.id, softOverrideReason: 'The owner confirmed project purpose in the task review.' })
  expect(approved).toMatchObject({ canExecute: true, softOverrideReason: 'The owner confirmed project purpose in the task review.' })
  expect(approved.id).not.toBe(preview.id)
  const full = await api.contextPackets.readSection(project.id, approved.id, 'architecture', 0)
  expect(full.text).toContain('Every request has one inspectable owner.')
  expect(full.citations).toContainEqual(expect.objectContaining({ sourceId: source.id }))
  expect((await api.contextPackets.list(project.id, task.id)).map((entry) => entry.id)).toEqual([approved.id, preview.id])
  expect(await api.contextPackets.usage(project.id, approved.id)).toEqual([])
  const preferences = await api.contextPackets.preferences(project.id, task.id)
  await api.contextPackets.updatePreferences(project.id, task.id, { expectedVersion: preferences.version, sourcePins: [], excludedSourceIds: [source.id] })
  await expect(api.contextPackets.preview(project.id, task.id, { packetId: approved.id })).rejects.toThrow(/changed/i)
  const reopened = new ProjectsService(new ProjectRegistry(registryPath))
  expect((await reopened.getContextPacket(project.id, approved.id)).launchMarkdown).toBe(approved.launchMarkdown)
  const feedback = await api.contextFeedback.create(project.id, { workItemId: task.id, packetId: approved.id, category: 'missing_context', note: 'Name the retry owner.', sourceIds: [source.id], actor: 'desktop-owner', authorKind: 'agent' })
  expect(feedback).toMatchObject({ authorKind: 'human', status: 'proposed', packetId: approved.id })
  expect(feedback.sourceReferences).toContainEqual(expect.objectContaining({ sourceId: source.id, packetRevisionId: full.citations[0].revisionId }))
  const triaged = await api.contextFeedback.triage(project.id, feedback.id, { expectedVersion: feedback.version, status: 'triaged', action: 'fixture', target: 'retry-owner-regression', actor: 'desktop-reviewer', note: 'Add the omitted owner to the evaluation corpus.' })
  expect(triaged).toMatchObject({ status: 'triaged', action: 'fixture', target: 'retry-owner-regression' })
  expect(await api.contextFeedback.history(project.id, feedback.id)).toHaveLength(2)
  expect(await api.contextFeedback.list(project.id, { packetId: approved.id })).toHaveLength(1)
  const other = await api.projects.create({ rootPath: path.join(directory, 'other'), name: 'Isolated context' })
  await expect(api.contextPackets.get(other.id, approved.id)).rejects.toThrow()
  expect(await api.contextFeedback.list(other.id, { packetId: approved.id })).toEqual([])
  expect(() => transport.handlers.get('context-packets:update-policy')!({}, project.id, { ...policy, expectedVersion: policy.version, unsafeField: true })).toThrow()
})

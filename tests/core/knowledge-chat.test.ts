import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCancelledError, KnowledgeChatAgent, KnowledgeChatRepository, runBashCommand, type AgentChatCompletion, type AgentChatProvider } from '../../src/core/knowledge-chat'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
import { FrozenClock } from '../../src/core/clock'

const cleanupPaths: string[] = []
afterEach(async () => Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

class ScriptedProvider implements AgentChatProvider {
  readonly toolNames: string[] = []

  constructor(private readonly responses: AgentChatCompletion[]) {}

  async completeChat(input: Parameters<AgentChatProvider['completeChat']>[0]): Promise<AgentChatCompletion> {
    this.toolNames.push(...input.tools.map((tool) => tool.function.name))
    const response = this.responses.shift()
    if (!response) throw new Error('No scripted response available.')
    return response
  }
}

describe('KnowledgeChatAgent', () => {
  it('persists tool-supported answers from project knowledge', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Chat' })
    new KnowledgeRepository(store).addManualSource({
      displayName: 'Architecture',
      filename: 'architecture.md',
      content: 'Workstack uses SQLite WAL for local coordination.'
    })
    const session = new KnowledgeChatRepository(store).createSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'tool-1', name: 'search_knowledge', arguments: { query: 'coordination', limit: 5 } }] },
      { content: 'Workstack uses SQLite WAL for local coordination.' }
    ])

    const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'How does coordination work?')

    expect(turn.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', contentMarkdown: 'How does coordination work?' }),
      expect.objectContaining({ role: 'assistant', contentMarkdown: 'Workstack uses SQLite WAL for local coordination.' })
    ]))
    expect(turn.toolCalls).toEqual([expect.objectContaining({ toolName: 'search_knowledge', status: 'completed' })])
    store.close()
  })

  it('requires explicit approval before creating a work item', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-actions-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Chat Actions' })
    const session = new KnowledgeChatRepository(store).createSession()
    const provider = new ScriptedProvider([
      {
        toolCalls: [{
          id: 'tool-1',
          name: 'request_create_work_item',
          arguments: { type: 'bug', title: 'Fix flaky chat', descriptionMarkdown: 'Approval required.', priority: 'high' }
        }]
      },
      { content: 'I drafted a bug. Please approve it before I add it to the backlog.' }
    ])

    const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Create a bug for flaky chat.')

    expect(new WorkItemRepository(store).list()).toEqual([])
    expect(turn.pendingActions).toEqual([
      expect.objectContaining({ kind: 'create_work_item', status: 'pending', payload: expect.objectContaining({ title: 'Fix flaky chat' }) })
    ])

    const approved = new KnowledgeChatRepository(store).approvePendingAction(session.id, turn.pendingActions[0].id)

    expect(approved.workItem).toMatchObject({ title: 'Fix flaky chat', type: 'bug', status: 'backlog' })
    expect(new WorkItemRepository(store).list()).toEqual([expect.objectContaining({ title: 'Fix flaky chat' })])
    store.close()
  })

  it('runs Bash commands in the project root and persists their output', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-bash-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Chat Bash' })
    await store.updateMetadata({ settings: { knowledgeChatProfile: 'advanced' } })
    const session = new KnowledgeChatRepository(store).createSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'tool-1', name: 'run_bash', arguments: { command: 'git status --short' } }] },
      { content: 'The working tree is clean.' }
    ])
    const commands: Array<{ command: string; cwd: string }> = []

    const turn = await new KnowledgeChatAgent(store, provider, {
      runBash: async (input) => {
        commands.push(input)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      }
    }).sendMessage(session.id, 'Check the working tree.')

    expect(provider.toolNames).toContain('run_bash')
    expect(commands).toEqual([{ command: 'git status --short', cwd: rootPath }])
    expect(turn.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'run_bash', status: 'completed', result: expect.objectContaining({ exitCode: 0 }) })
    ])
    store.close()
  })
})

it('persists assistant requests and original IDs in order across restart without repeating a completed mutation', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-transcript-'))
  cleanupPaths.push(rootPath)
  let store = await ProjectStore.initialize({ rootPath, name: 'Transcript' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const calls: Parameters<AgentChatProvider['completeChat']>[0][] = []
  const provider: AgentChatProvider = { completeChat: async (input) => {
    calls.push(input)
    return calls.length === 1 ? { content: 'Inspecting', toolCalls: [
      { id: 'original-one', name: 'get_project', arguments: {} },
      { id: 'original-two', name: 'request_create_work_item', arguments: { title: 'Suggested work' } }
    ] } : { content: 'Review the suggestion.' }
  } }
  const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Help scope work')
  expect(calls[1].messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool'])
  expect(calls[1].messages[2].toolCalls?.map((call) => call.id)).toEqual(['original-one', 'original-two'])
  expect(calls[1].messages.slice(3).map((message) => message.toolCallId)).toEqual(['original-one', 'original-two'])
  expect(turn.toolCalls.map((call) => call.providerCallId)).toEqual(['original-one', 'original-two'])
  const action = turn.pendingActions[0]
  const first = repository.approvePendingAction(session.id, action.id)
  store.close()
  store = await ProjectStore.open(rootPath)
  const reopened = new KnowledgeChatRepository(store)
  expect(reopened.approvePendingAction(session.id, action.id).workItem.id).toBe(first.workItem.id)
  expect(new WorkItemRepository(store).list()).toHaveLength(1)
  const runner = vi.fn(() => ({ duplicate: true }))
  await reopened.recordToolCall(session.id, 'request_create_work_item', { title: 'Suggested work' }, runner, 'original-two')
  expect(runner).not.toHaveBeenCalled()
  await expect(reopened.recordToolCall(session.id, 'get_project', {}, runner, 'original-two')).rejects.toThrow('different operation')
  store.close()
})

it('rejects simultaneous turns without interleaving history and recovers after cancellation', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-turn-lock-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Serial chat' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  let resolve!: (value: AgentChatCompletion) => void
  const provider: AgentChatProvider = { completeChat: () => new Promise((done) => { resolve = done }) }
  const first = new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'First')
  await expect(new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Second')).rejects.toMatchObject({ code: 'STORE_BUSY' })
  expect(repository.listMessages(session.id).map((message) => message.contentMarkdown)).toEqual(['First'])
  resolve({ content: 'First answer' })
  await first
  const failureProvider: AgentChatProvider = { completeChat: async () => { throw new Error('cancelled') } }
  await expect(new KnowledgeChatAgent(store, failureProvider).sendMessage(session.id, 'Keep my question')).rejects.toThrow('cancelled')
  expect(repository.listMessages(session.id).at(-1)?.contentMarkdown).toBe('Keep my question')
  expect(() => repository.acquireTurn(session.id).release()).not.toThrow()
  store.close()
})

it('recovers an interrupted tool with an unknown outcome and never invents successful evidence', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-interrupt-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Interrupted' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  repository.addMessage(session.id, 'user', 'Inspect')
  repository.addMessage(session.id, 'assistant', '', { metadata: { toolCalls: [{ id: 'unresolved', name: 'get_project', arguments: {} }] } })
  const provider: AgentChatProvider = { completeChat: async (input) => {
    expect(input.messages.find((message) => message.toolCallId === 'unresolved')).toMatchObject({ role: 'tool', content: expect.stringContaining('outcome":"unknown') })
    return { content: 'Previous call was interrupted.' }
  } }
  await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Continue')
  expect(repository.listMessages(session.id).filter((message) => message.toolCallId === 'unresolved')).toHaveLength(1)
  store.close()
})

it('enforces inspection boundaries for commands, excluded files, symlinks and redacted source evidence', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-inspection-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'workstack-outside-'))
  cleanupPaths.push(rootPath, outside)
  await writeFile(path.join(rootPath, '.env'), 'SECRET=keep private')
  await writeFile(path.join(rootPath, 'notes.txt'), 'api_key=examplePrivateCredential\nSQLite WAL')
  await writeFile(path.join(outside, 'private.txt'), 'Do not disclose')
  await symlink(path.join(outside, 'private.txt'), path.join(rootPath, 'escape.txt'))
  const store = await ProjectStore.initialize({ rootPath, name: 'Inspect' })
  const session = new KnowledgeChatRepository(store).createSession()
  const runBash = vi.fn(async () => ({ stdout: 'should not run' }))
  const provider = new ScriptedProvider([{ toolCalls: [
    { id: 'blocked-command', name: 'run_bash', arguments: { command: 'echo test' } },
    { id: 'excluded', name: 'read_large_source_slice', arguments: { path: '.env' } },
    { id: 'escape', name: 'read_large_source_slice', arguments: { path: 'escape.txt' } },
    { id: 'safe', name: 'read_large_source_slice', arguments: { path: 'notes.txt' } }
  ] }, { content: 'SQLite uses WAL.' }])
  const turn = await new KnowledgeChatAgent(store, provider, { runBash }).sendMessage(session.id, 'Inspect project')
  expect(provider.toolNames).not.toContain('run_bash')
  expect(runBash).not.toHaveBeenCalled()
  expect(turn.toolCalls.map((call) => call.status)).toEqual(['failed', 'failed', 'failed', 'completed'])
  expect(JSON.stringify(turn.toolCalls)).not.toContain('examplePrivateCredential')
  expect(JSON.stringify(turn.toolCalls)).not.toContain('Do not disclose')
  expect(JSON.stringify(turn.toolCalls)).toContain('[REDACTED]')
  store.close()
})

it('answers with current work, ownership, completed evidence and full wiki content while keeping drafts unapplied', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-facts-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Project facts' })
  const workItems = new WorkItemRepository(store)
  const backlog = workItems.create({ title: 'Next durability improvement', priority: 'high' })
  const active = workItems.create({ title: 'Active durability work' })
  const activeClaim = new ClaimsRepository(store).claim(active.id, { agentId: 'active-agent' })
  const completed = workItems.create({ title: 'Completed durability work' })
  const claim = new ClaimsRepository(store).claim(completed.id, { agentId: 'completed-agent' })
  new ClaimsRepository(store).complete(completed.id, claim.claimToken, { summaryMarkdown: 'Durability verified with recovery.' })
  const knowledge = new KnowledgeRepository(store)
  const source = knowledge.addManualSource({ displayName: 'Durability design', filename: 'durability.md', content: 'Transactions preserve durability.' })
  knowledge.saveWikiArticle('durability', '# Durability\n\nUse a transactional revision pointer.')
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const provider = new ScriptedProvider([{ toolCalls: [
    { id: 'backlog', name: 'list_work_items', arguments: { status: 'backlog', priority: 'high' } },
    { id: 'active', name: 'get_work_item', arguments: { workItemId: active.id } },
    { id: 'completed', name: 'get_work_item', arguments: { workItemId: completed.id } },
    { id: 'sources', name: 'list_knowledge_sources', arguments: {} },
    { id: 'articles', name: 'list_wiki_articles', arguments: {} },
    { id: 'article', name: 'get_wiki_article', arguments: { slug: 'durability' } },
    { id: 'past-evidence', name: 'search_completed_work', arguments: { query: 'durability' } },
    { id: 'activity', name: 'search_activity', arguments: { limit: 2 } },
    { id: 'draft', name: 'draft_work_item', arguments: { type: 'chore', title: 'Review durability', acceptanceCriteriaMarkdown: 'Recovery documented.' } },
    { id: 'missing-article', name: 'get_wiki_article', arguments: { slug: 'missing' } },
    { id: 'unknown', name: 'unavailable_tool', arguments: {} }
  ] }, { content: 'The revision pointer is documented and recovery was verified.' }])
  const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Explain project durability')
  const result = (id: string) => turn.toolCalls.find((call) => call.providerCallId === id)?.result
  expect(result('backlog')).toMatchObject({ workItems: [{ id: backlog.id }] })
  expect(result('active')).toMatchObject({ workItem: { id: active.id }, currentClaim: { id: activeClaim.claim.id } })
  expect(result('completed')).toMatchObject({ workItem: { id: completed.id }, completion: { summaryMarkdown: 'Durability verified with recovery.' } })
  expect(result('completed')?.currentClaim).toBeUndefined()
  expect(result('sources')).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: source.id })]) })
  expect(result('articles')).toMatchObject({ articles: expect.arrayContaining([expect.objectContaining({ slug: 'durability' })]) })
  expect(result('article')).toMatchObject({ article: { content: '# Durability\n\nUse a transactional revision pointer.' } })
  expect(result('past-evidence')).toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ sourceType: 'completed_work', workItemId: completed.id })]) })
  expect(result('activity')?.events).toHaveLength(2)
  expect(result('draft')).toMatchObject({ draft: { type: 'chore', title: 'Review durability', acceptanceCriteriaMarkdown: 'Recovery documented.' } })
  expect(turn.toolCalls.slice(-2).map((call) => call.status)).toEqual(['failed', 'failed'])
  expect(turn.pendingActions).toEqual([])
  expect(workItems.list()).toHaveLength(3)
  expect(repository.listSessions()).toEqual([turn.session])
  expect(() => repository.getSession('missing')).toThrow('does not exist')
  expect(() => repository.addMessage(session.id, 'user', '   ')).toThrow('cannot be empty')
  store.close()
})

it('keeps source search and line reads inside bounded, readable project evidence', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-source-bounds-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-source-outside-'))
  cleanupPaths.push(rootPath, outside)
  await mkdir(path.join(rootPath, 'docs'))
  const deepDirectory = path.join(rootPath, ...Array.from({ length: 21 }, (_, index) => `depth-${index}`))
  await mkdir(deepDirectory, { recursive: true })
  await Promise.all([
    writeFile(path.join(rootPath, 'notes.txt'), Array.from({ length: 240 }, (_, index) => `${index === 19 || index === 219 ? 'Needle' : 'Ordinary'} line ${index + 1}`).join('\n')),
    writeFile(path.join(rootPath, 'docs', 'guide.txt'), 'Needle in nested guide'),
    writeFile(path.join(rootPath, '.DS_Store'), 'Needle private metadata'),
    writeFile(path.join(rootPath, '.env'), 'Needle private credentials'),
    writeFile(path.join(rootPath, 'binary.dat'), Buffer.from('Needle\0binary')),
    writeFile(path.join(rootPath, 'large.txt'), `Needle${'x'.repeat(512 * 1024)}`),
    writeFile(path.join(deepDirectory, 'beyond-depth.txt'), 'Needle too deep'),
    writeFile(path.join(outside, 'outside.txt'), 'Needle outside project')
  ])
  await symlink(path.join(outside, 'outside.txt'), path.join(rootPath, 'outside-link.txt'))
  const store = await ProjectStore.initialize({ rootPath, name: 'Source bounds' })
  const session = new KnowledgeChatRepository(store).createSession()
  const provider = new ScriptedProvider([{ toolCalls: [
    { id: 'search-all', name: 'search_large_source', arguments: { query: 'needle', limit: 50 } },
    { id: 'search-limit', name: 'search_large_source', arguments: { query: 'needle', limit: 2 } },
    { id: 'search-none', name: 'search_large_source', arguments: { query: 'unmatched-project-query' } },
    { id: 'slice', name: 'read_large_source_slice', arguments: { path: 'notes.txt', startLine: 20, endLine: 999 } },
    { id: 'reverse-range', name: 'read_large_source_slice', arguments: { path: 'notes.txt', startLine: 240, endLine: 1 } },
    ...['.', '../outside.txt', 'missing.txt', 'binary.dat', 'large.txt'].map((sourcePath, index) => ({ id: `invalid-${index}`, name: 'read_large_source_slice', arguments: { path: sourcePath } }))
  ] }, { content: 'Only readable project text was included.' }])
  const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Find source evidence')
  const result = (id: string) => turn.toolCalls.find((call) => call.providerCallId === id)?.result
  expect(result('search-all')).toEqual({ results: [
    { path: 'docs/guide.txt', line: 1, excerpt: 'Needle in nested guide' },
    { path: 'notes.txt', line: 20, excerpt: 'Needle line 20' },
    { path: 'notes.txt', line: 220, excerpt: 'Needle line 220' }
  ] })
  expect(result('search-limit')?.results).toHaveLength(2)
  expect(result('search-none')).toEqual({ results: [] })
  expect(result('slice')).toMatchObject({ path: 'notes.txt', startLine: 20, endLine: 220 })
  expect(result('slice')?.content).toContain('20: Needle line 20')
  expect(result('slice')?.content).not.toContain('221:')
  expect(result('reverse-range')).toMatchObject({ startLine: 240, endLine: 240, content: '240: Ordinary line 240' })
  expect(turn.toolCalls.slice(-5).map((call) => call.status)).toEqual(Array(5).fill('failed'))
  expect(JSON.stringify(turn.toolCalls)).not.toContain('Needle private')
  expect(JSON.stringify(turn.toolCalls)).not.toContain('Needle outside project')
  store.close()
})

it('rejects duplicate and reused provider IDs without repeating actions, and releases the turn after the tool limit', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-tool-bounds-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Tool bounds' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const requested = { id: 'same-id', name: 'request_create_work_item', arguments: { title: 'One pending action' } }
  await expect(new KnowledgeChatAgent(store, new ScriptedProvider([{ toolCalls: [requested, requested] }])).sendMessage(session.id, 'Duplicate request')).rejects.toThrow('duplicate tool call IDs')
  expect(repository.listPendingActions(session.id)).toEqual([])
  await new KnowledgeChatAgent(store, new ScriptedProvider([{ toolCalls: [requested] }, { content: 'Review the pending action.' }])).sendMessage(session.id, 'First request')
  await expect(new KnowledgeChatAgent(store, new ScriptedProvider([{ toolCalls: [requested] }])).sendMessage(session.id, 'Repeated request')).rejects.toThrow('reused a previous tool call ID')
  expect(repository.listPendingActions(session.id)).toHaveLength(1)
  const bounded = await new KnowledgeChatAgent(store, new ScriptedProvider(Array.from({ length: 6 }, (_, step) => ({ toolCalls: [{ id: `bounded-${step}`, name: 'get_project', arguments: {} }] })))).sendMessage(session.id, 'Inspect repeatedly')
  expect(bounded.messages.at(-1)?.contentMarkdown).toContain('stopped after reaching the tool-use limit')
  expect(bounded.toolCalls.filter((call) => call.providerCallId?.startsWith('bounded-'))).toHaveLength(6)
  const blank = await new KnowledgeChatAgent(store, new ScriptedProvider([{ content: ' ' }])).sendMessage(session.id, 'Continue')
  expect(blank.messages.at(-1)?.contentMarkdown).toBe('I could not produce a response.')
  expect(() => repository.acquireTurn(session.id).release()).not.toThrow()
  store.close()
})

it('persists rejected actions across reopen and rejects wrong-session or repeated decisions', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-rejection-'))
  cleanupPaths.push(rootPath)
  let store = await ProjectStore.initialize({ rootPath, name: 'Rejected actions' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const other = repository.createSession()
  const action = repository.createPendingWorkItemAction(session.id, { title: 'Declined suggestion', type: 'bug' })
  expect(() => repository.rejectPendingAction(other.id, action.id)).toThrow('does not exist')
  expect(() => repository.approvePendingAction(session.id, 'missing')).toThrow('does not exist')
  expect(repository.rejectPendingAction(session.id, action.id)).toMatchObject({ id: action.id, status: 'rejected', resolvedAt: expect.any(String) })
  expect(repository.listMessages(session.id).at(-1)?.contentMarkdown).toBe('Rejected proposed bug: Declined suggestion.')
  store.close()
  store = await ProjectStore.open(rootPath)
  const reopened = new KnowledgeChatRepository(store)
  expect(() => reopened.approvePendingAction(session.id, action.id)).toThrow('already been rejected')
  expect(() => reopened.rejectPendingAction(session.id, action.id)).toThrow('already been resolved')
  const legacy = reopened.createPendingWorkItemAction(session.id, { title: 'Legacy untyped suggestion' })
  store.database.prepare('UPDATE knowledge_chat_pending_actions SET payload_json = ? WHERE id = ?').run(JSON.stringify({ title: 'Legacy untyped suggestion' }), legacy.id)
  reopened.rejectPendingAction(session.id, legacy.id)
  expect(reopened.listMessages(session.id).at(-1)?.contentMarkdown).toBe('Rejected proposed feature: Legacy untyped suggestion.')
  expect(new WorkItemRepository(store).list()).toEqual([])
  store.close()
})

it('defaults metadata without a chat profile to inspection and refuses command tools', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-legacy-profile-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Legacy metadata' })
  const metadata = store.project
  delete metadata.settings.knowledgeChatProfile
  const legacyMetadata = vi.spyOn(store, 'project', 'get').mockReturnValue(metadata)
  try {
    const session = new KnowledgeChatRepository(store).createSession()
    const runBash = vi.fn(async () => ({ stdout: 'Must remain unavailable' }))
    let calls = 0
    const provider: AgentChatProvider = { completeChat: async (input) => {
      expect(input.messages[0].content).toContain('Capabilities: inspection.')
      expect(input.tools.some((tool) => tool.function.name === 'run_bash')).toBe(false)
      return ++calls === 1 ? { toolCalls: [{ id: 'legacy-command', name: 'run_bash', arguments: { command: 'pwd' } }] } : { content: 'Inspection remains active.' }
    } }
    const turn = await new KnowledgeChatAgent(store, provider, { runBash }).sendMessage(session.id, 'Inspect older project metadata')
    expect(turn.toolCalls).toMatchObject([{ status: 'failed', errorMessage: expect.stringContaining('disabled in inspection mode') }])
    expect(runBash).not.toHaveBeenCalled()
  } finally {
    legacyMetadata.mockRestore()
    store.close()
  }
})

it('reports an incomplete search when the project exceeds the 2,000-file inspection budget', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-file-budget-'))
  cleanupPaths.push(rootPath)
  const corpus = path.join(rootPath, 'corpus')
  await mkdir(corpus)
  for (let start = 0; start < 2001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2001 - start) }, (_, offset) => {
      const index = start + offset
      return writeFile(path.join(corpus, `${String(index).padStart(5, '0')}.txt`), index === 2000 ? 'Needle beyond the inspection budget' : 'Ordinary source evidence')
    }))
  }
  const store = await ProjectStore.initialize({ rootPath, name: 'Large corpus' })
  const session = new KnowledgeChatRepository(store).createSession()
  const provider = new ScriptedProvider([{ toolCalls: [{ id: 'bounded-search', name: 'search_large_source', arguments: { query: 'needle' } }] }, { content: 'The search was incomplete; narrow the source set.' }])
  const turn = await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Search the entire project')
  expect(turn.toolCalls[0]).toMatchObject({ status: 'completed', result: { results: [], truncated: true } })
  store.close()
})

it('exposes pending calls and records bounded, redacted results and non-Error failures', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-result-audit-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Result audit' })
  let sequence = 0
  const repository = new KnowledgeChatRepository(store, {
    clock: new FrozenClock(new Date('2026-09-09T00:00:00.000Z')),
    id: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  })
  const session = repository.createSession()
  let reject!: (reason: unknown) => void
  const pending = repository.recordToolCall(session.id, 'get_project', {}, () => new Promise((_resolve, fail) => { reject = fail }))
  expect(repository.listToolCalls(session.id)).toMatchObject([{ status: 'pending', result: null, completedAt: null }])
  reject('provider fixture failure')
  expect(await pending).toMatchObject({ status: 'failed', errorMessage: 'provider fixture failure', result: { error: 'provider fixture failure' } })
  const redacted = await repository.recordToolCall(session.id, 'get_project', {}, () => ({ accessToken: 'private-token', nested: [{ password: 'private-password', content: 'api_key=private-key', ok: true, count: 2, empty: null }] }))
  expect(redacted.result).toEqual({ accessToken: '[REDACTED]', nested: [{ password: '[REDACTED]', content: 'api_key=[REDACTED]', ok: true, count: 2, empty: null }] })
  const bounded = await repository.recordToolCall(session.id, 'get_project', {}, () => ({ description: 'a'.repeat(7000), secret: 'hidden-value' }))
  expect(bounded.result).toMatchObject({ truncated: true, excerpt: expect.any(String) })
  expect(String(bounded.result?.excerpt)).toHaveLength(6000)
  const longFailure = await repository.recordToolCall(session.id, 'get_project', {}, () => { throw new Error(`password=private-key ${'x'.repeat(7000)}`) })
  expect(longFailure.errorMessage).toHaveLength(6000)
  expect(longFailure.errorMessage).toMatch(/^password=\[REDACTED\]/)
  const emptyFailure = await repository.recordToolCall(session.id, 'get_project', {}, () => { throw new Error('') })
  expect(emptyFailure).toMatchObject({ status: 'failed', errorMessage: '', result: { error: '' } })
  expect(JSON.stringify(repository.listMessages(session.id))).not.toContain('private-password')
  expect(JSON.stringify(repository.listMessages(session.id))).not.toContain('private-key')
  expect(JSON.stringify(repository.listMessages(session.id))).not.toContain('hidden-value')
  expect(JSON.stringify(repository.listMessages(session.id))).not.toContain('private-token')
  store.close()
})

it.each(['error', 'string'] as const)('redacts a %s tool failure before storing diagnostics or replaying its native result', async (kind) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-error-redaction-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Private diagnostics' })
  await store.updateMetadata({ settings: { knowledgeChatProfile: 'advanced' } })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const raw = 'Failure: password=protected-value api_key=private-key Authorization: Bearer private-bearer'
  const redacted = 'Failure: password=[REDACTED] api_key=[REDACTED] Authorization: [REDACTED]'
  let request = 0
  const provider: AgentChatProvider = { completeChat: async (input) => {
    if (++request === 1) return { toolCalls: [{ id: 'failed-operation', name: 'run_bash', arguments: { command: 'fixture-command' } }] }
    expect(input.messages.find((message) => message.role === 'tool')).toMatchObject({ toolCallId: 'failed-operation', content: JSON.stringify({ error: redacted }, null, 2) })
    for (const secret of ['protected-value', 'private-key', 'private-bearer']) expect(JSON.stringify(input)).not.toContain(secret)
    return { content: 'The redacted failure remains available for review.' }
  } }
  const turn = await new KnowledgeChatAgent(store, provider, { runBash: async () => { throw kind === 'error' ? new Error(raw) : raw } }).sendMessage(session.id, 'Inspect the project')
  expect(turn.toolCalls).toMatchObject([{ status: 'failed', errorMessage: redacted, result: { error: redacted } }])
  expect(store.database.prepare('SELECT error_message FROM knowledge_chat_tool_calls WHERE session_id = ?').get(session.id)).toEqual({ error_message: redacted })
  store.close()
  const reopened = await ProjectStore.open(rootPath)
  try { expect(new KnowledgeChatRepository(reopened).listToolCalls(session.id)).toMatchObject([{ errorMessage: redacted, result: { error: redacted } }]) }
  finally { reopened.close() }
})

it('runs an explicitly selected command in a real project directory and collects its output', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-command-'))
  cleanupPaths.push(rootPath)
  expect(await runBashCommand({ command: 'pwd', cwd: rootPath })).toMatchObject({
    cwd: rootPath, command: 'pwd', exitCode: 0, timedOut: false, stdout: `${await realpath(rootPath)}\n`, stderr: ''
  })
})

it('cancels a real shell process group while a child command is running', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-real-cancel-'))
  cleanupPaths.push(rootPath)
  const controller = new AbortController()
  const pending = runBashCommand({ command: "printf 'started\\n'; printf ready > started.txt; sleep 30", cwd: rootPath, signal: controller.signal })
  const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', partialResult: { stdout: 'started\n', timedOut: false } })
  try {
    await vi.waitFor(async () => expect(await readFile(path.join(rootPath, 'started.txt'), 'utf8')).toBe('ready'))
    controller.abort()
    await failed
  } finally { controller.abort() }
})

it('renews long-running turns and fences an expired owner from releasing the replacement lock', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-lock-renewal-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Lock renewal' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'))
    let resolve!: (value: AgentChatCompletion) => void
    const agent = new KnowledgeChatAgent(store, { completeChat: () => new Promise((done) => { resolve = done }) })
    const pending = agent.sendMessage(session.id, 'Wait for a response')
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(() => repository.acquireTurn(session.id)).toThrow('already has a request in progress')
    resolve({ content: 'The long request completed.' })
    await pending
    const expired = repository.acquireTurn(session.id)
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000))
    const replacement = repository.acquireTurn(session.id)
    expired.renew()
    expired.release()
    expect(() => repository.acquireTurn(session.id)).toThrow('already has a request in progress')
    replacement.release()
    expect(() => repository.acquireTurn(session.id).release()).not.toThrow()
  } finally {
    vi.useRealTimers()
    store.close()
  }
})

it('stops cancellation before a provider response can execute requested tools', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-cancel-boundary-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Cancellation boundary' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const controller = new AbortController()
  const provider: AgentChatProvider = { completeChat: async () => {
    controller.abort()
    return { toolCalls: [{ id: 'after-cancel', name: 'request_create_work_item', arguments: { title: 'Must not be drafted' } }] }
  } }
  await expect(new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Keep the question', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(repository.listMessages(session.id).map((message) => message.contentMarkdown)).toEqual(['Keep the question'])
  expect(repository.listPendingActions(session.id)).toEqual([])
  expect(repository.listToolCalls(session.id)).toEqual([])
  expect(() => repository.acquireTurn(session.id).release()).not.toThrow()
  const unused = vi.fn()
  await expect(new KnowledgeChatAgent(store, { completeChat: unused }).sendMessage(session.id, 'Precancelled', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(unused).not.toHaveBeenCalled()
  store.close()
})

it('cancels the active tool, audits every skipped call and never makes another provider request', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-cancel-tools-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Cancellation during tools' })
  await store.updateMetadata({ settings: { knowledgeChatProfile: 'advanced' } })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const controller = new AbortController()
  const provider = { completeChat: vi.fn(async () => ({ toolCalls: [
    { id: 'running-command', name: 'run_bash', arguments: { command: 'fixture-command' } },
    { id: 'skipped-action', name: 'request_create_work_item', arguments: { title: 'Do not create this suggestion' } }
  ] })) }
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const agent = new KnowledgeChatAgent(store, provider, { runBash: async ({ signal }) => {
    expect(signal).toBe(controller.signal)
    started()
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new ChatCancelledError({ stdout: 'Partial evidence', stderr: '', exitCode: null })), { once: true }))
  } })
  const pending = agent.sendMessage(session.id, 'Inspect before proposing', { signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  await ready
  controller.abort()
  await rejected
  expect(provider.completeChat).toHaveBeenCalledOnce()
  expect(repository.listToolCalls(session.id)).toMatchObject([
    { providerCallId: 'running-command', status: 'failed', result: { cancelled: true, stdout: 'Partial evidence' } },
    { providerCallId: 'skipped-action', status: 'failed', result: { cancelled: true } }
  ])
  expect(repository.listPendingActions(session.id)).toEqual([])
  const next = await new KnowledgeChatAgent(store, { completeChat: async (input) => {
    expect(input.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['running-command', 'skipped-action'])
    return { content: 'The cancelled operations remain in the audit.' }
  } }).sendMessage(session.id, 'Continue safely')
  expect(next.messages.at(-1)?.contentMarkdown).toContain('cancelled operations')
  store.close()
})

it('reopens pre-native transcripts as labeled evidence and leaves the original audit unchanged', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-legacy-replay-'))
  cleanupPaths.push(rootPath)
  let store = await ProjectStore.initialize({ rootPath, name: 'Legacy transcript' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  repository.addMessage(session.id, 'user', 'Inspect the old project')
  await repository.recordToolCall(session.id, 'get_project', {}, () => ({ evidence: 'Older retained project fact' }))
  repository.addMessage(session.id, 'tool', 'Older unidentified evidence')
  repository.addMessage(session.id, 'assistant', 'The earlier project fact was recorded.')
  const before = repository.listMessages(session.id)
  store.close()
  store = await ProjectStore.open(rootPath)
  const provider: AgentChatProvider = { completeChat: async (input) => {
    expect(input.messages.some((message) => message.role === 'tool')).toBe(false)
    expect(input.messages.filter((message) => message.content.startsWith('Legacy tool evidence'))).toHaveLength(2)
    expect(JSON.stringify(input.messages)).toContain('Older retained project fact')
    expect(JSON.stringify(input.messages)).toContain('original provider request was not retained')
    return { content: 'I can continue from the retained reference.' }
  } }
  await new KnowledgeChatAgent(store, provider).sendMessage(session.id, 'Continue')
  expect(new KnowledgeChatRepository(store).listMessages(session.id).slice(0, before.length)).toEqual(before)
  store.close()
})

it('retains an oversized current question and fails before sending incomplete context', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-chat-history-overflow-'))
  cleanupPaths.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'History overflow' })
  const repository = new KnowledgeChatRepository(store)
  const session = repository.createSession()
  const completeChat = vi.fn()
  const question = 'Context '.repeat(7000)
  await expect(new KnowledgeChatAgent(store, { completeChat }).sendMessage(session.id, question)).rejects.toThrow('full conversation is saved')
  expect(repository.listMessages(session.id)[0].contentMarkdown).toBe(question.trim())
  expect(completeChat).not.toHaveBeenCalled()
  expect(() => repository.acquireTurn(session.id).release()).not.toThrow()
  store.close()
})

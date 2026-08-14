import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeChatAgent, KnowledgeChatRepository, type AgentChatCompletion, type AgentChatProvider } from '../../src/core/knowledge-chat'
import { KnowledgeRepository } from '../../src/core/knowledge'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

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

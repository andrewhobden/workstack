import { expect, it } from 'vitest'
import { prepareChatHistory } from '../../src/core/knowledge-chat'
import type { KnowledgeChatMessage } from '../../src/core/types'

let sequence = 0
function message(role: KnowledgeChatMessage['role'], contentMarkdown: string, metadata: Record<string, unknown> = {}, toolCallId: string | null = null): KnowledgeChatMessage {
  return { id: String(++sequence), sessionId: 'history-fixture', role, contentMarkdown, metadata, toolCallId, createdAt: '2026-09-09T00:00:00.000Z' }
}

it('bounds old history without separating native calls/results or losing unresolved outcomes and retained citation pointers', () => {
  const history = [message('assistant', 'Initial saved context'), message('user', 'Earlier interrupted question'),
    message('assistant', '', { toolCalls: [{ id: 'interrupted', name: 'get_project', arguments: {} }] }),
    message('tool', '{"outcome":"unknown","error":"Interrupted; inspect before retrying."}', {}, 'interrupted')]
  for (let index = 0; index < 70; index++) history.push(message('user', `Earlier question ${index} ${'q'.repeat(600)}`), message('assistant', `Earlier answer ${index} ${'a'.repeat(600)} source://project/revisions/immutable/passages/${index}#L1-L2`))
  history.push(message('user', 'Recent cited lookup'), message('assistant', '', { toolCalls: [{ id: 'recent-one', name: 'get_project', arguments: {} }, { id: 'recent-two', name: 'search_knowledge', arguments: { query: 'revision' } }] }), message('tool', '{"project":"Retained project"}', {}, 'recent-one'), message('tool', '{"citation":"source://project/revisions/exact/passages/1#L3-L5"}', {}, 'recent-two'), message('assistant', 'Cited final answer'), message('user', 'Current follow-up'))
  const projected = prepareChatHistory(history)
  expect(JSON.stringify(projected).length).toBeLessThanOrEqual(48_000)
  expect(projected[0].content).toContain('older exchanges were condensed')
  expect(projected[0].content).toContain('source://project/revisions/immutable/passages/0#L1-L2')
  expect(projected.at(-1)).toEqual({ role: 'user', content: 'Current follow-up' })
  for (const id of ['interrupted', 'recent-one', 'recent-two']) expect(projected.some((entry) => entry.toolCallId === id)).toBe(true)
  const native = projected.findIndex((entry) => entry.toolCalls?.[0].id === 'recent-one')
  expect(projected.slice(native + 1, native + 3).map((entry) => entry.toolCallId)).toEqual(['recent-one', 'recent-two'])
  expect(projected[native + 2].content).toContain('source://project/revisions/exact/passages/1#L3-L5')
  expect(projected.find((entry) => entry.toolCallId === 'interrupted')?.content).toContain('"outcome":"unknown"')
  expect(history).toHaveLength(150)
})

it('keeps short history exact and refuses an unmatched native tool request', () => {
  expect(prepareChatHistory([])).toEqual([])
  expect(prepareChatHistory([message('user', 'Short question'), message('assistant', 'Short answer')])).toEqual([{ role: 'user', content: 'Short question' }, { role: 'assistant', content: 'Short answer' }])
  expect(() => prepareChatHistory([message('assistant', '', { toolCalls: [{ id: 'missing', name: 'get_project', arguments: {} }] })])).toThrow('unresolved tool request')
})

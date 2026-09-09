import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleProvider } from '../../src/main/ai-provider'
import { ProjectStore } from '../../src/core/project-store'
import { PlanningRepository } from '../../src/core/planning'
import { ArtifactStore } from '../../src/core/artifact-store'

vi.mock('electron', () => ({ safeStorage: { encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '') } }))

const cleanupPaths: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function providerWithSettings(settings: Record<string, unknown>, policy: ConstructorParameters<typeof OpenAiCompatibleProvider>[1] = {}): Promise<OpenAiCompatibleProvider> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-ai-provider-'))
  cleanupPaths.push(directory)
  const settingsPath = path.join(directory, 'ai-provider.json')
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8')
  return new OpenAiCompatibleProvider(settingsPath, policy)
}

describe('OpenAiCompatibleProvider endpoint modes', () => {
  it('uses /responses for proposal prompts when configured', async () => {
    const provider = await providerWithSettings({
      baseUrl: 'http://localhost:1234/v1',
      model: 'modern-model',
      apiMode: 'responses'
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: 'Response output.' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.propose('Explain the project.')).resolves.toBe('Response output.')

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:1234/v1/responses', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"max_output_tokens"')
    }))
  })

  it('uses /messages and parses tool calls when configured', async () => {
    const provider = await providerWithSettings({
      baseUrl: 'http://localhost:1234/v1',
      model: 'claude-style-model',
      apiMode: 'messages'
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'get_project', input: {} },
        { type: 'text', text: 'I will inspect the project.' }
      ]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.completeChat({
      messages: [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'What is this project?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_project',
          description: 'Get project metadata.',
          parameters: { type: 'object', properties: {} }
        }
      }]
    })).resolves.toMatchObject({
      content: 'I will inspect the project.',
      toolCalls: [{ id: 'tool-1', name: 'get_project', arguments: {} }]
    })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:1234/v1/messages', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"input_schema"')
    }))
  })
})

describe('provider association and request lifecycle', () => {
  it('preserves a legacy encrypted credential only for its original normalized endpoint and mode', async () => {
    const provider = await providerWithSettings({ baseUrl: 'https://provider.example/v1/', model: 'legacy-model', encryptedApiKey: Buffer.from('encrypted:legacy-private-key').toString('base64') })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'legacy-model' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const settings = await provider.settings()
    expect(JSON.stringify(settings)).not.toContain('legacy-private-key')
    await provider.listModels({ baseUrl: 'https://provider.example/v1' })
    expect(fetchMock).toHaveBeenLastCalledWith('https://provider.example/v1/models', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer legacy-private-key' } }))
    for (const input of [{ baseUrl: 'https://other.example/v1' }, { baseUrl: 'https://provider.example/v2' }, { baseUrl: 'https://provider.example/v1', apiMode: 'messages' as const }]) {
      await expect(provider.listModels(input)).rejects.toThrow('Enter an API key')
    }
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await provider.configure({ baseUrl: 'https://provider.example/v1', model: 'replacement-model' })).configured).toBe(true)
    expect((await provider.configure({ baseUrl: 'https://provider.example/v1', model: 'replacement-model', apiMode: 'messages' })).configured).toBe(false)
  })

  it('never follows a provider redirect or retries a malformed response object', async () => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm' })
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://other.example/v1' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider.propose('draft')).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 302, retryable: false })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]).toEqual(['http://localhost:1234/v1/chat/completions', expect.objectContaining({ redirect: 'error' })])
    for (const payload of [null, [], 5]) {
      fetchMock.mockClear().mockImplementation(async () => new Response(JSON.stringify(payload)))
      await expect(provider.propose('draft')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('cancels a rate-limit backoff before another network attempt', async () => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm' })
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '5' } }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = provider.propose('saved draft', { requestId: 'cancel-backoff' })
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(provider.cancelRequest('cancel-backoff')).toBe(true)
    await failed
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(provider.cancelRequest('cancel-backoff')).toBe(false)
  })

  it('rejects non-object native Messages tool arguments as an invalid provider response', async () => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm', apiMode: 'messages' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'invalid-input', name: 'get_project', input: 'not an argument object' }] }))))
    await expect(provider.completeChat({ messages: [{ role: 'user', content: 'Inspect' }], tools: [] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('binds saved credentials to the URL and mode and supports removal without exposing key material', async () => {
    const provider = await providerWithSettings({ baseUrl: 'https://provider.example/v1', model: 'm' })
    expect(await provider.configure({ baseUrl: 'https://provider.example/v1/', model: 'm', apiKey: 'test-credential' })).toEqual({ baseUrl: 'https://provider.example/v1', model: 'm', apiMode: 'chat_completions', configured: true })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] })))
    vi.stubGlobal('fetch', fetchMock)
    await provider.listModels({ baseUrl: 'https://provider.example/v1' })
    expect(fetchMock).toHaveBeenLastCalledWith('https://provider.example/v1/models', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer test-credential' } }))
    for (const baseUrl of ['https://other.example/v1', 'https://provider.example/v2']) await expect(provider.listModels({ baseUrl })).rejects.toThrow('Enter an API key')
    await expect(provider.listModels({ baseUrl: 'https://provider.example/v1', apiMode: 'messages' })).rejects.toThrow('Enter an API key')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await provider.configure({ baseUrl: 'https://other.example/v1', model: 'm' })).configured).toBe(false)
    await provider.configure({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'replacement' })
    expect((await provider.configure({ baseUrl: 'https://provider.example/v1', model: 'm', removeApiKey: true })).configured).toBe(false)
    for (const baseUrl of ['http://remote.example/v1', 'https://user:password@provider.example/v1', 'https://provider.example/v1?key=value']) await expect(provider.configure({ baseUrl, model: 'm', apiKey: 'credential' })).rejects.toThrow('Use HTTPS')
  })

  it('bounds stalled fetches and response bodies, and releases cancellation IDs', async () => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm' }, { timeoutMs: 25 })
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await expect(provider.propose('draft', { requestId: 'timeout' })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(provider.cancelRequest('timeout')).toBe(false)
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise(() => {}) }))
    const pending = provider.propose('draft', { requestId: 'cancel-me' }).catch((error: unknown) => error)
    await ready
    expect(provider.cancelRequest('cancel-me')).toBe(true)
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })))
    await expect(provider.propose('stalled body')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('retries transient capacity failures but never authentication or invalid responses', async () => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm' }, { retryBaseMs: 1 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider.propose('draft')).resolves.toBe('OK')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockReset().mockResolvedValue(new Response('', { status: 401 }))
    await expect(provider.propose('draft')).rejects.toMatchObject({ code: 'AUTHENTICATION', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockReset().mockImplementation(async () => new Response('', { status: 503 }))
    await expect(provider.propose('draft')).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    fetchMock.mockReset().mockResolvedValue(new Response('not json'))
    await expect(provider.propose('draft')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['chat_completions', 'responses', 'messages'] as const)('replays two correlated native calls in %s', async (apiMode) => {
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm', apiMode })
    const first = apiMode === 'chat_completions' ? { choices: [{ message: { tool_calls: [
      { id: 'call-one', function: { name: 'get_project', arguments: '{}' } }, { id: 'call-two', function: { name: 'search_knowledge', arguments: '{"query":"WAL"}' } }
    ] } }] } : apiMode === 'responses' ? { output: [
      { type: 'function_call', call_id: 'call-one', name: 'get_project', arguments: '{}' }, { type: 'function_call', call_id: 'call-two', name: 'search_knowledge', arguments: '{"query":"WAL"}' }
    ] } : { content: [
      { type: 'tool_use', id: 'call-one', name: 'get_project', input: {} }, { type: 'tool_use', id: 'call-two', name: 'search_knowledge', input: { query: 'WAL' } }
    ] }
    const last = apiMode === 'chat_completions' ? { choices: [{ message: { content: 'Cited answer' } }] } : apiMode === 'responses' ? { output_text: 'Cited answer' } : { content: [{ type: 'text', text: 'Cited answer' }] }
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(first))).mockResolvedValueOnce(new Response(JSON.stringify(last)))
    vi.stubGlobal('fetch', fetchMock)
    const response = await provider.completeChat({ messages: [{ role: 'user', content: 'Explain WAL' }], tools: [] })
    expect(response.toolCalls?.map((call) => call.id)).toEqual(['call-one', 'call-two'])
    await expect(provider.completeChat({ tools: [], messages: [
      { role: 'user', content: 'Explain WAL' }, { role: 'assistant', content: '', toolCalls: response.toolCalls },
      { role: 'tool', content: '{"project":"Workstack"}', toolCallId: 'call-one' },
      { role: 'tool', content: '{"citation":"source:12"}', toolCallId: 'call-two' }
    ] })).resolves.toMatchObject({ content: 'Cited answer' })
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    if (apiMode === 'chat_completions') {
      expect(body.messages[1].tool_calls.map((call: { id: string }) => call.id)).toEqual(['call-one', 'call-two'])
      expect(body.messages.slice(2).map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(['call-one', 'call-two'])
    } else if (apiMode === 'responses') {
      expect(body.input.filter((item: { type: string }) => item.type === 'function_call_output').map((item: { call_id: string }) => item.call_id)).toEqual(['call-one', 'call-two'])
    } else {
      expect(body.messages[1].content.map((item: { id: string }) => item.id)).toEqual(['call-one', 'call-two'])
      expect(body.messages[2].content.map((item: { tool_use_id: string }) => item.tool_use_id)).toEqual(['call-one', 'call-two'])
    }
  })

  it.each(['chat_completions', 'responses', 'messages'] as const)('sends the inspected planning draft, history and image bytes in %s', async (apiMode) => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-provider-planning-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Image planning' })
    const planning = new PlanningRepository(store)
    const { planningSessionId } = planning.createSession()
    planning.updateProposal(planningSessionId, { title: 'Reviewed proposal', requirementsMarkdown: 'Preserve diagram context.' })
    planning.addMessage(planningSessionId, 'user', 'We agreed to retain immutable revisions.')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
    new ArtifactStore(store).attachPlanningBytes(planningSessionId, { originalFilename: 'architecture.png', data: bytes })
    new ArtifactStore(store).attachPlanningBytes(planningSessionId, { originalFilename: 'notes.txt', data: Buffer.from('Approved supporting notes.') })
    const context = planning.assembleContext(planningSessionId, 'architecture')
    planning.updateProposal(planningSessionId, { title: 'Unreviewed later proposal' })
    const provider = await providerWithSettings({ baseUrl: 'http://localhost:1234/v1', model: 'm', apiMode })
    const response = apiMode === 'chat_completions' ? { choices: [{ message: { content: 'Image-aware proposal' } }] } : apiMode === 'responses' ? { output_text: 'Image-aware proposal' } : { content: [{ type: 'text', text: 'Image-aware proposal' }] }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider.proposePlanning('Continue the reviewed plan.', context)).resolves.toBe('Image-aware proposal')
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    const content = apiMode === 'responses' ? body.input[0].content : body.messages[0].content
    const prompt = content[0].text as string
    expect(prompt).toContain('Reviewed proposal')
    expect(prompt).toContain('Preserve diagram context.')
    expect(prompt).toContain('We agreed to retain immutable revisions.')
    expect(prompt).toContain('Approved supporting notes.')
    expect(prompt).not.toContain('Unreviewed later proposal')
    expect(content).toHaveLength(2)
    if (apiMode === 'chat_completions') expect(content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } })
    else if (apiMode === 'responses') expect(content[1]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` })
    else expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } })
    store.close()
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleProvider } from '../../src/main/ai-provider'

const cleanupPaths: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function providerWithSettings(settings: Record<string, unknown>): Promise<OpenAiCompatibleProvider> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-ai-provider-'))
  cleanupPaths.push(directory)
  const settingsPath = path.join(directory, 'ai-provider.json')
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8')
  return new OpenAiCompatibleProvider(settingsPath)
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

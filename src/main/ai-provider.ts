import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { formatPlanningPrompt } from '../core/planning'
import type {
  AgentChatCompletion,
  AgentChatMessage,
  AgentChatProvider,
  AgentToolDefinition
} from '../core/knowledge-chat'
import type { PlanningContext } from '../core/types'

export interface AiProviderSettings {
  baseUrl: string
  model: string
  apiMode: AiApiMode
  configured: boolean
}

export interface AiModel {
  id: string
  label?: string
}

export type AiApiMode = 'chat_completions' | 'responses' | 'messages'

interface StoredSettings {
  baseUrl: string
  model: string
  apiMode?: AiApiMode
  encryptedApiKey?: string
}

export class OpenAiCompatibleProvider implements AgentChatProvider {
  constructor(private readonly settingsPath: string) {}

  async settings(): Promise<AiProviderSettings> {
    const settings = await this.read()
    return this.publicSettings(settings)
  }

  async configure(input: { baseUrl: string; model: string; apiMode?: AiApiMode; apiKey?: string }): Promise<AiProviderSettings> {
    const current = await this.read()
    const next: StoredSettings = {
      baseUrl: new URL(input.baseUrl).toString().replace(/\/$/, ''),
      model: input.model.trim(),
      apiMode: input.apiMode ?? current.apiMode ?? 'chat_completions',
      encryptedApiKey: input.apiKey?.trim()
        ? safeStorage.encryptString(input.apiKey.trim()).toString('base64')
        : current.encryptedApiKey
    }
    if (!next.model) throw new Error('A model name is required.')
    await writeFile(this.settingsPath, JSON.stringify(next), { mode: 0o600 })
    return this.publicSettings(next)
  }

  async listModels(input: { baseUrl: string; apiKey?: string }): Promise<AiModel[]> {
    const current = await this.read()
    const baseUrl = new URL(input.baseUrl).toString().replace(/\/$/, '')
    const apiKey = input.apiKey?.trim()
      ? input.apiKey.trim()
      : current.encryptedApiKey
        ? safeStorage.decryptString(Buffer.from(current.encryptedApiKey, 'base64'))
        : undefined
    if (!apiKey && !isLoopback(baseUrl)) throw new Error('Enter an API key before loading models for this provider.')
    const response = await fetch(`${baseUrl}/models`, {
      headers: authHeaders(apiKey)
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status} while loading models.`)
    const payload = await response.json() as { data?: Array<{ id?: string; name?: string; owned_by?: string }> }
    return (payload.data ?? [])
      .flatMap((model) => model.id ? [{ id: model.id, label: model.name ?? model.owned_by }] : [])
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async propose(prompt: string): Promise<string> {
    return this.request(prompt)
  }

  async proposePlanning(prompt: string, context: PlanningContext): Promise<string> {
    return this.request(formatPlanningPrompt(prompt, context))
  }

  async completeChat(input: {
    messages: AgentChatMessage[]
    tools: AgentToolDefinition[]
    maxTokens?: number
  }): Promise<AgentChatCompletion> {
    const settings = await this.read()
    if (!settings.encryptedApiKey && !isLoopback(settings.baseUrl)) throw new Error('Configure an AI provider before using project chat.')
    const apiKey = settings.encryptedApiKey ? safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64')) : undefined
    switch (settings.apiMode ?? 'chat_completions') {
      case 'responses':
        return this.completeResponses(settings, apiKey, input)
      case 'messages':
        return this.completeMessages(settings, apiKey, input)
      case 'chat_completions':
        return this.completeChatCompletions(settings, apiKey, input)
    }
  }

  private async completeChatCompletions(
    settings: StoredSettings,
    apiKey: string | undefined,
    input: { messages: AgentChatMessage[]; tools: AgentToolDefinition[]; maxTokens?: number }
  ): Promise<AgentChatCompletion> {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.role === 'tool' && message.toolCallId ? { tool_call_id: message.toolCallId } : {})
        })),
        ...(input.tools.length ? { tools: input.tools } : {}),
        max_tokens: input.maxTokens ?? 1200
      })
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status}.`)
    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_text?: string
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
    }
    const message = payload.choices?.[0]?.message
    const toolCalls = message?.tool_calls?.flatMap((toolCall) => {
      const name = toolCall.function?.name
      if (!name) return []
      return [{
        id: toolCall.id ?? randomUUID(),
        name,
        arguments: parseToolArguments(toolCall.function?.arguments)
      }]
    })
    return {
      content: (message?.content ?? message?.reasoning_text)?.trim(),
      toolCalls
    }
  }

  private async completeResponses(
    settings: StoredSettings,
    apiKey: string | undefined,
    input: { messages: AgentChatMessage[]; tools: AgentToolDefinition[]; maxTokens?: number }
  ): Promise<AgentChatCompletion> {
    const response = await fetch(`${settings.baseUrl}/responses`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        input: input.messages.map((message) => ({
          role: message.role === 'tool' ? 'user' : message.role,
          content: message.content
        })),
        ...(input.tools.length ? { tools: input.tools.map(toResponsesTool) } : {}),
        max_output_tokens: input.maxTokens ?? 1200
      })
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status}.`)
    const payload = await response.json() as {
      output_text?: string
      output?: Array<{
        id?: string
        call_id?: string
        type?: string
        name?: string
        arguments?: string
        content?: Array<{ type?: string; text?: string }>
      }>
    }
    return {
      content: payload.output_text?.trim() || payload.output
        ?.flatMap((item) => item.content ?? [])
        .flatMap((content) => content.text ? [content.text] : [])
        .join('\n')
        .trim(),
      toolCalls: payload.output
        ?.filter((item) => item.type === 'function_call' && item.name)
        .map((item) => ({
          id: item.call_id ?? item.id ?? randomUUID(),
          name: item.name ?? '',
          arguments: parseToolArguments(item.arguments)
        }))
    }
  }

  private async completeMessages(
    settings: StoredSettings,
    apiKey: string | undefined,
    input: { messages: AgentChatMessage[]; tools: AgentToolDefinition[]; maxTokens?: number }
  ): Promise<AgentChatCompletion> {
    const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
    const response = await fetch(`${settings.baseUrl}/messages`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        ...(system ? { system } : {}),
        messages: input.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.content
          })),
        ...(input.tools.length ? { tools: input.tools.map(toMessagesTool) } : {}),
        max_tokens: input.maxTokens ?? 1200
      })
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status}.`)
    const payload = await response.json() as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
    }
    return {
      content: payload.content
        ?.flatMap((content) => content.type === 'text' && content.text ? [content.text] : [])
        .join('\n')
        .trim(),
      toolCalls: payload.content
        ?.filter((content) => content.type === 'tool_use' && content.name)
        .map((content) => ({
          id: content.id ?? randomUUID(),
          name: content.name ?? '',
          arguments: content.input ?? {}
        }))
    }
  }

  private async request(prompt: string): Promise<string> {
    const settings = await this.read()
    if (!settings.encryptedApiKey && !isLoopback(settings.baseUrl)) throw new Error('Configure an AI provider before requesting a proposal.')
    const apiKey = settings.encryptedApiKey ? safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64')) : undefined
    if ((settings.apiMode ?? 'chat_completions') !== 'chat_completions') {
      const response = await this.completeChat({ messages: [{ role: 'user', content: prompt }], tools: [], maxTokens: 1200 })
      const content = response.content?.trim()
      if (!content) throw new Error('AI provider returned no proposal content.')
      return content
    }
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1200 })
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status}.`)
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_text?: string } }> }
    const content = (payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.message?.reasoning_text)?.trim()
    if (!content) throw new Error('AI provider returned no proposal content.')
    return content
  }

  private async read(): Promise<StoredSettings> {
    try {
      return JSON.parse(await readFile(this.settingsPath, 'utf8')) as StoredSettings
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
      throw error
    }
  }

  private publicSettings(settings: StoredSettings): AiProviderSettings {
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiMode: settings.apiMode ?? 'chat_completions',
      configured: Boolean(settings.encryptedApiKey) || isLoopback(settings.baseUrl)
    }
  }

}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function toResponsesTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }
}

function toMessagesTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }
}

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function isLoopback(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

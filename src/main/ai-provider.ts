import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { formatPlanningPrompt } from '../core/planning'
import type { AgentChatCompletion, AgentChatMessage, AgentChatProvider, AgentToolDefinition } from '../core/knowledge-chat'
import type { PlanningContext } from '../core/types'

export interface AiProviderSettings {
  baseUrl: string
  model: string
  apiMode: AiApiMode
  configured: boolean
}
export interface AiModel { id: string; label?: string }
export type AiApiMode = 'chat_completions' | 'responses' | 'messages'
export interface AiRequestOptions { signal?: AbortSignal; requestId?: string }
export interface AgentRequest extends AiRequestOptions {
  messages: AgentChatMessage[]
  tools: AgentToolDefinition[]
  maxTokens?: number
}
interface StoredSettings {
  baseUrl: string
  model: string
  apiMode?: AiApiMode
  encryptedApiKey?: string
  credentialAssociation?: string
}
export class AiRequestError extends Error {
  constructor(
    readonly code: 'CANCELLED' | 'TIMEOUT' | 'AUTHENTICATION' | 'RATE_LIMIT' | 'INVALID_RESPONSE' | 'PROVIDER_ERROR',
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) { super(message); this.name = 'AiRequestError' }
}

/** Credentials belong to an exact normalized base URL and API mode; base-path changes clear them. */
export class OpenAiCompatibleProvider implements AgentChatProvider {
  private readonly requests = new Map<string, AbortController>()
  constructor(private readonly settingsPath: string, private readonly policy: { timeoutMs?: number; maxRetries?: number; retryBaseMs?: number } = {}) {}

  async settings(): Promise<AiProviderSettings> { return this.publicSettings(await this.read()) }

  async configure(input: { baseUrl: string; model: string; apiMode?: AiApiMode; apiKey?: string; removeApiKey?: boolean }): Promise<AiProviderSettings> {
    const current = await this.read()
    const next: StoredSettings = { baseUrl: normalizeBaseUrl(input.baseUrl), model: input.model.trim(), apiMode: validateMode(input.apiMode ?? current.apiMode ?? 'chat_completions') }
    if (!next.model) throw new Error('A model name is required.')
    const association = providerAssociation(next)
    if (!input.removeApiKey) {
      if (input.apiKey?.trim()) next.encryptedApiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
      else if (association === (current.credentialAssociation ?? providerAssociation(current))) next.encryptedApiKey = current.encryptedApiKey
      if (next.encryptedApiKey) next.credentialAssociation = association
    }
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
    await rename(temporary, this.settingsPath)
    return this.publicSettings(next)
  }

  cancelRequest(requestId: string): boolean {
    const controller = this.requests.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async listModels(input: { baseUrl: string; apiMode?: AiApiMode; apiKey?: string } & AiRequestOptions): Promise<AiModel[]> {
    const current = await this.read()
    const selected = { baseUrl: normalizeBaseUrl(input.baseUrl), apiMode: validateMode(input.apiMode ?? current.apiMode ?? 'chat_completions') }
    const associated = providerAssociation(selected) === (current.credentialAssociation ?? providerAssociation(current))
    const apiKey = input.apiKey?.trim() || (associated ? this.decrypt(current) : undefined)
    if (!apiKey && !isLoopback(selected.baseUrl)) throw new Error('Enter an API key before loading models for this provider.')
    const payload = await this.requestJson(`${selected.baseUrl}/models`, { headers: authHeaders(apiKey) }, input) as { data?: Array<{ id?: string; name?: string; owned_by?: string }> }
    return (payload.data ?? []).flatMap((model) => model.id ? [{ id: model.id, label: model.name ?? model.owned_by }] : []).sort((a, b) => a.id.localeCompare(b.id))
  }

  async propose(prompt: string, options: AiRequestOptions = {}): Promise<string> {
    const response = await this.completeChat({ messages: [{ role: 'user', content: prompt }], tools: [], maxTokens: 1200, ...options })
    const content = response.content?.trim()
    if (!content) throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned no proposal content.')
    return content
  }

  async proposePlanning(prompt: string, context: PlanningContext, options: AiRequestOptions = {}): Promise<string> {
    const response = await this.completeChat({ messages: [{ role: 'user', content: formatPlanningPrompt(prompt, context), images: context.planningAttachments.flatMap((item) => item.image ? [item.image] : []) }], tools: [], maxTokens: 2000, ...options })
    if (!response.content?.trim()) throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned no proposal content.')
    return response.content.trim()
  }

  async completeChat(input: AgentRequest): Promise<AgentChatCompletion> {
    const settings = await this.read()
    settings.baseUrl = normalizeBaseUrl(settings.baseUrl)
    const apiKey = this.decrypt(settings)
    if (!apiKey && !isLoopback(settings.baseUrl)) throw new Error('Configure an AI provider before using project chat.')
    const mode = validateMode(settings.apiMode ?? 'chat_completions')
    const payload = await this.requestJson(`${settings.baseUrl}/${mode === 'chat_completions' ? 'chat/completions' : mode}`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), ...(mode === 'messages' ? { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(settings, input, mode))
    }, input) as ProviderPayload
    return parseCompletion(payload, mode)
  }

  private decrypt(settings: StoredSettings): string | undefined {
    if (!settings.encryptedApiKey || (settings.credentialAssociation && settings.credentialAssociation !== providerAssociation(settings))) return undefined
    return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'))
  }

  private async requestJson(url: string, init: RequestInit, options: AiRequestOptions): Promise<unknown> {
    if (options.requestId && this.requests.has(options.requestId)) throw new AiRequestError('PROVIDER_ERROR', 'This request is already running.')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (options.signal?.aborted) cancel()
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.requestId) this.requests.set(options.requestId, controller)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.policy.timeoutMs ?? 45_000)
    const aborted = () => new AiRequestError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'AI request timed out. Your draft is retained; retry when the provider is available.' : 'AI request cancelled.')
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (controller.signal.aborted) throw aborted()
        try {
          const response = await abortable(fetch(url, { ...init, redirect: 'error', signal: controller.signal }), controller.signal, aborted)
          if (!response.ok) {
            const retryable = [408, 429, 502, 503, 504].includes(response.status)
            const error = new AiRequestError(response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', `AI provider returned ${response.status}.`, response.status, retryable)
            if (!retryable || attempt >= (this.policy.maxRetries ?? 2)) throw error
            await waitForRetry(retryDelay(response.headers.get('retry-after'), attempt, this.policy.retryBaseMs ?? 250), controller.signal, aborted)
            continue
          }
          try { return await abortable(response.json(), controller.signal, aborted) }
          catch (error) {
            if (error instanceof AiRequestError) throw error
            throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned invalid JSON.')
          }
        } catch (error) {
          if (controller.signal.aborted) throw aborted()
          if (error instanceof AiRequestError) throw error
          if (attempt >= (this.policy.maxRetries ?? 2)) throw new AiRequestError('PROVIDER_ERROR', 'Unable to reach the AI provider.', undefined, true)
          await waitForRetry(retryDelay(null, attempt, this.policy.retryBaseMs ?? 250), controller.signal, aborted)
        }
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      if (options.requestId) this.requests.delete(options.requestId)
    }
  }

  private async read(): Promise<StoredSettings> {
    try { return JSON.parse(await readFile(this.settingsPath, 'utf8')) as StoredSettings }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
      throw error
    }
  }

  private publicSettings(settings: StoredSettings): AiProviderSettings {
    return { baseUrl: settings.baseUrl, model: settings.model, apiMode: settings.apiMode ?? 'chat_completions', configured: Boolean(settings.encryptedApiKey && (!settings.credentialAssociation || settings.credentialAssociation === providerAssociation(settings))) || isLoopback(settings.baseUrl) }
  }
}

function requestBody(settings: StoredSettings, input: AgentRequest, mode: AiApiMode): Record<string, unknown> {
  const base = { model: settings.model }
  if (mode === 'chat_completions') return {
    ...base, messages: input.messages.map((m) => ({ role: m.role, content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } }))] : m.content,
      ...(m.role === 'tool' ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) })),
    ...(input.tools.length ? { tools: input.tools } : {}), max_tokens: input.maxTokens ?? 1200
  }
  if (mode === 'responses') return {
    ...base, input: input.messages.flatMap((m): Record<string, unknown>[] => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.toolCallId, output: m.content }]
      return [...(m.content ? [{ role: m.role, content: m.images?.length ? [{ type: 'input_text', text: m.content }, ...m.images.map((image) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.dataBase64}` }))] : m.content }] : []), ...(m.toolCalls ?? []).map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))]
    }), ...(input.tools.length ? { tools: input.tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters })) } : {}), max_output_tokens: input.maxTokens ?? 1200
  }
  const system = input.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const messages: Array<{ role: string; content: Record<string, unknown>[] }> = []
  for (const m of input.messages.filter((message) => message.role !== 'system')) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] : [
      ...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.images ?? []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 } })), ...(m.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))
    ]
    if (messages.at(-1)?.role === role) messages[messages.length - 1].content.push(...content)
    else messages.push({ role, content })
  }
  return { ...base, ...(system ? { system } : {}), messages, ...(input.tools.length ? { tools: input.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}), max_tokens: input.maxTokens ?? 1200 }
}

interface ProviderPayload {
  choices?: Array<{ message?: { content?: string; reasoning_text?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>
  output_text?: string
  output?: Array<{ id?: string; call_id?: string; type?: string; name?: string; arguments?: string; content?: Array<{ text?: string }> }>
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
}
function parseCompletion(payload: ProviderPayload, mode: AiApiMode): AgentChatCompletion {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned an invalid response object.')
  if (mode === 'chat_completions') {
    const message = payload.choices?.[0]?.message
    return { content: (message?.content ?? message?.reasoning_text)?.trim(), toolCalls: message?.tool_calls?.map((call) => ({ id: required(call.id), name: required(call.function?.name), arguments: parseArguments(call.function?.arguments) })) }
  }
  if (mode === 'responses') return {
    content: payload.output_text?.trim() || payload.output?.flatMap((item) => item.content ?? []).flatMap((c) => c.text ? [c.text] : []).join('\n').trim(),
    toolCalls: payload.output?.filter((item) => item.type === 'function_call').map((call) => ({ id: required(call.call_id), name: required(call.name), arguments: parseArguments(call.arguments) }))
  }
  return { content: payload.content?.flatMap((c) => c.type === 'text' && c.text ? [c.text] : []).join('\n').trim(), toolCalls: payload.content?.filter((c) => c.type === 'tool_use').map((call) => ({ id: required(call.id), name: required(call.name), arguments: call.input === undefined ? {} : parseArguments(JSON.stringify(call.input)) })) }
}
function required(value?: string): string {
  if (!value) throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned a tool call without its required identity.')
  return value
}
function parseArguments(value?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch { throw new AiRequestError('INVALID_RESPONSE', 'AI provider returned invalid tool arguments.') }
}
function authHeaders(apiKey?: string): Record<string, string> { return apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(value)))) throw new Error('Use HTTPS for remote providers or HTTP for a loopback provider, without credentials, query or fragment in the URL.')
  return url.toString().replace(/\/+$/, '')
}
function validateMode(mode: string): AiApiMode {
  if (!['chat_completions', 'responses', 'messages'].includes(mode)) throw new Error('Unsupported AI provider mode.')
  return mode as AiApiMode
}
function providerAssociation(settings: Pick<StoredSettings, 'baseUrl' | 'apiMode'>): string { return `${normalizeBaseUrl(settings.baseUrl)}|${settings.apiMode ?? 'chat_completions'}` }
function isLoopback(baseUrl: string): boolean { return ['127.0.0.1', '[::1]', '::1', 'localhost'].includes(new URL(baseUrl).hostname) }
function retryDelay(header: string | null, attempt: number, base: number): number {
  const requested = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Math.min(5000, Math.max(0, Number.isFinite(requested) ? requested : base * 2 ** attempt))
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(error())
    if (signal.aborted) { reject(error()); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function waitForRetry(ms: number, signal: AbortSignal, error: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(error()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

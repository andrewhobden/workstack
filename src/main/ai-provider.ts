import { readFile, writeFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import { formatPlanningPrompt } from '../core/planning'
import type { PlanningContext } from '../core/types'

export interface AiProviderSettings {
  baseUrl: string
  model: string
  configured: boolean
}

interface StoredSettings {
  baseUrl: string
  model: string
  encryptedApiKey?: string
}

export class OpenAiCompatibleProvider {
  constructor(private readonly settingsPath: string) {}

  async settings(): Promise<AiProviderSettings> {
    const settings = await this.read()
    return { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.encryptedApiKey) || isLoopback(settings.baseUrl) }
  }

  async configure(input: { baseUrl: string; model: string; apiKey?: string }): Promise<AiProviderSettings> {
    const current = await this.read()
    const next: StoredSettings = {
      baseUrl: new URL(input.baseUrl).toString().replace(/\/$/, ''),
      model: input.model.trim(),
      encryptedApiKey: input.apiKey?.trim()
        ? safeStorage.encryptString(input.apiKey.trim()).toString('base64')
        : current.encryptedApiKey
    }
    if (!next.model) throw new Error('A model name is required.')
    await writeFile(this.settingsPath, JSON.stringify(next), { mode: 0o600 })
    return { baseUrl: next.baseUrl, model: next.model, configured: Boolean(next.encryptedApiKey) || isLoopback(next.baseUrl) }
  }

  async propose(prompt: string): Promise<string> {
    return this.request(prompt)
  }

  async proposePlanning(prompt: string, context: PlanningContext): Promise<string> {
    return this.request(formatPlanningPrompt(prompt, context))
  }

  private async request(prompt: string): Promise<string> {
    const settings = await this.read()
    if (!settings.encryptedApiKey && !isLoopback(settings.baseUrl)) throw new Error('Configure an AI provider before requesting a proposal.')
    const apiKey = settings.encryptedApiKey ? safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64')) : undefined
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...(apiKey ? { Authorization: 'Bearer '.concat(apiKey) } : {}), 'Content-Type': 'application/json' },
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

}

function isLoopback(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

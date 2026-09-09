import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { AiModel, AiModelListInput, AiProviderConfiguration, AiProviderSettings, DesktopApi } from '../../src/shared/desktop-api'
import type { ProjectMetadata } from '../../src/core/types'

test('configures a planning provider without exposing its API key @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Provider Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/provider-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible()
  await expect(page.getByLabel('MCP launch command')).toHaveValue('npm run mcp:serve')
  await expect(page.getByText('Available over stdio', { exact: true })).toBeVisible()
  await page.getByLabel('Provider URL').fill('https://example.test/v1')
  await page.getByLabel('AI API style').selectOption('responses')
  await page.getByLabel('AI API key').fill('super-secret-key')
  await expect(page.getByLabel('AI model')).toHaveValue('test-model')
  await page.getByLabel('AI model').selectOption('test-model-large')
  await page.getByRole('button', { name: 'Save AI provider' }).click()
  await expect(page.getByText('A provider key is securely configured on this Mac.')).toBeVisible()
  await expect(page.getByLabel('AI API style')).toHaveValue('responses')
  await expect(page.getByLabel('AI model')).toHaveValue('test-model-large')
  await expect(page.getByLabel('AI API key')).toHaveValue('')
  await expect(page.locator('body')).not.toContainText('super-secret-key')
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('ai-provider-settings.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
  const semantic = page.getByRole('region', { name: 'Local semantic search', exact: true })
  await expect(semantic.getByRole('status')).toHaveText('Disabled · lexical search is active')
  await semantic.getByRole('button', { name: 'Choose local vector pack' }).click()
  await expect(semantic.getByRole('alert')).toHaveText('Open Workstack desktop to select and use a local model file.')
  await expect(semantic.getByRole('button', { name: 'Rebuild local index' })).toHaveCount(0)
})

async function installProviderFixture(page: Page, delayDiscovery = false): Promise<void> {
  await page.addInitScript(({ delayDiscovery }) => {
    const now = new Date().toISOString()
    const project = {
      id: 'provider-project', name: 'Provider Project', description: '', rootPath: '/tmp/provider-project', createdAt: now, updatedAt: now,
      settings: { workItemPrefix: 'PROV', defaultLeaseSeconds: 600, heartbeatSeconds: 30, autoReleaseExpiredClaims: true, autoUpdateKnowledgeOnCompletion: false }
    } as ProjectMetadata
    const replacement = { baseUrl: 'https://provider.example/alternate/v1', model: 'test-model', apiMode: 'responses' as const }
    const configurationResponses: AiProviderSettings[] = [
      { ...replacement, configured: false }, { ...replacement, configured: true }, { ...replacement, configured: false }
    ]
    const pending = new Map<number, (models: AiModel[]) => void>()
    const state = {
      settings: { baseUrl: 'https://provider.example/v1', model: 'test-model', apiMode: 'chat_completions', configured: true } as AiProviderSettings,
      discoveries: [] as AiModelListInput[], configurations: [] as AiProviderConfiguration[],
      finishDiscovery: (index: number, models: AiModel[]) => {
        const resolve = pending.get(index)
        if (!resolve) throw new Error(`No pending model discovery ${index}.`)
        pending.delete(index)
        resolve(models)
      }
    }
    const bridge = {
      system: { appVersion: async () => 'test' },
      projects: { list: async () => [{ ...project, lastOpenedAt: now, backlogCount: 0, inProgressCount: 0, completedCount: 0 }], get: async () => project },
      workItems: { list: async () => [] },
      claims: { list: async () => [] },
      knowledge: { listSources: async () => [], listWiki: async () => [] },
      wikiAutomation: { listReports: async () => [] },
      ai: {
        settings: async () => structuredClone(state.settings),
        listModels: async (input: AiModelListInput) => {
          const index = state.discoveries.push(structuredClone(input)) - 1
          return delayDiscovery ? new Promise<AiModel[]>((resolve) => { pending.set(index, resolve) }) : [{ id: 'test-model' }]
        },
        configure: async (input: AiProviderConfiguration) => {
          state.configurations.push(structuredClone(input))
          const response = configurationResponses.shift()
          if (!response) throw new Error('Unexpected provider configuration request.')
          state.settings = response
          return structuredClone(response)
        }
      }
    } as unknown as DesktopApi
    Object.assign(window, { workstack: bridge, providerFixture: state })
  }, { delayDiscovery })
}

test('provider edits scope model discovery to credentials and removal updates public settings', async ({ page }) => {
  await installProviderFixture(page)
  const discoveries = (): Promise<AiModelListInput[]> => page.evaluate('window.providerFixture.discoveries')
  const configurations = (): Promise<AiProviderConfiguration[]> => page.evaluate('window.providerFixture.configurations')
  await page.goto('/')
  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  const provider = page.getByRole('region', { name: 'AI provider', exact: true })
  const url = provider.getByLabel('Provider URL')
  const mode = provider.getByLabel('AI API style')
  const key = provider.getByLabel('AI API key')
  await expect(provider.getByRole('combobox', { name: 'AI model' })).toHaveValue('test-model')
  await expect(key).toHaveAttribute('placeholder', 'Leave blank to retain the configured key')
  expect(await discoveries()).toContainEqual({ baseUrl: 'https://provider.example/v1', apiMode: 'chat_completions', apiKey: undefined })

  for (const edit of [
    { baseUrl: 'https://other.example/v1', apiMode: 'chat_completions' },
    { baseUrl: 'https://provider.example/alternate/v1', apiMode: 'chat_completions' },
    { baseUrl: 'https://provider.example/v1', apiMode: 'responses' }
  ]) {
    const before = (await discoveries()).length
    await url.fill(edit.baseUrl)
    await mode.selectOption(edit.apiMode)
    await expect(provider.getByRole('textbox', { name: 'AI model' })).toHaveValue('test-model')
    await expect(provider.getByRole('status')).toContainText('do not have a saved credential')
    await expect(key).toHaveAttribute('placeholder', 'Enter API key for this endpoint')
    expect(await discoveries()).toHaveLength(before)
    await url.fill('https://provider.example/v1')
    await mode.selectOption('chat_completions')
    await expect(provider.getByRole('combobox', { name: 'AI model' })).toHaveValue('test-model')
    expect((await discoveries()).length).toBeGreaterThan(before)
    expect((await discoveries()).at(-1)).toEqual({ baseUrl: 'https://provider.example/v1', apiMode: 'chat_completions', apiKey: undefined })
  }

  await url.fill('https://provider.example/alternate/v1')
  await mode.selectOption('responses')
  await expect(provider.getByRole('textbox', { name: 'AI model' })).toBeVisible()
  await provider.getByRole('button', { name: 'Save AI provider' }).click()
  await expect(provider.getByText('No provider key is configured. Planning remains available for manual editing.')).toBeVisible()
  expect(await configurations()).toEqual([{ baseUrl: 'https://provider.example/alternate/v1', model: 'test-model', apiMode: 'responses', apiKey: undefined }])
  await expect(provider.getByRole('button', { name: 'Remove saved API key' })).toHaveCount(0)

  await key.fill('replacement-provider-secret')
  await expect(provider.getByRole('combobox', { name: 'AI model' })).toHaveValue('test-model')
  expect((await discoveries()).at(-1)).toEqual({ baseUrl: 'https://provider.example/alternate/v1', apiMode: 'responses', apiKey: 'replacement-provider-secret' })
  await provider.getByRole('button', { name: 'Save AI provider' }).click()
  await expect(provider.getByText('A provider key is securely configured on this Mac.')).toBeVisible()
  await expect(key).toHaveValue('')
  expect((await configurations())[1]).toEqual({ baseUrl: 'https://provider.example/alternate/v1', model: 'test-model', apiMode: 'responses', apiKey: 'replacement-provider-secret' })
  await expect(page.locator('body')).not.toContainText('replacement-provider-secret')

  await url.fill('https://unsaved.example/v1')
  await mode.selectOption('messages')
  await expect(provider.getByRole('textbox', { name: 'AI model' })).toBeVisible()
  const beforeRemoval = (await discoveries()).length
  await provider.getByRole('button', { name: 'Remove saved API key' }).click()
  await expect(provider.getByText('No provider key is configured. Planning remains available for manual editing.')).toBeVisible()
  await expect(provider.getByRole('button', { name: 'Remove saved API key' })).toHaveCount(0)
  expect((await configurations())[2]).toEqual({ baseUrl: 'https://provider.example/alternate/v1', model: 'test-model', apiMode: 'responses', removeApiKey: true })
  expect(await page.evaluate('window.providerFixture.settings')).toEqual({ baseUrl: 'https://provider.example/alternate/v1', model: 'test-model', apiMode: 'responses', configured: false })
  await url.fill('https://provider.example/alternate/v1')
  await mode.selectOption('responses')
  await expect(provider.getByRole('textbox', { name: 'AI model' })).toBeVisible()
  await expect(key).toHaveAttribute('placeholder', 'Enter API key for this endpoint')
  await expect(key).toHaveValue('')
  expect(await discoveries()).toHaveLength(beforeRemoval)
})

test('pending model discovery stops on endpoint or mode edits and ignores late replies', async ({ page }) => {
  await installProviderFixture(page, true)
  await page.goto('/')
  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  const provider = page.getByRole('region', { name: 'AI provider', exact: true })
  const url = provider.getByLabel('Provider URL')
  const mode = provider.getByLabel('AI API style')
  const loading = provider.getByRole('status').filter({ hasText: 'Loading models...' })
  const count = (): Promise<number> => page.evaluate('window.providerFixture.discoveries.length')
  const finish = async (index: number, models: AiModel[]): Promise<void> => {
    await page.evaluate(async ({ index, models }) => {
      const fixture = (window as unknown as { providerFixture: { finishDiscovery(index: number, models: AiModel[]): void } }).providerFixture
      fixture.finishDiscovery(index, models)
      // Let the promise handlers and React's render settle before checking a late reply.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    }, { index, models })
  }
  const staleRequests: number[] = []
  for (const edit of [
    { baseUrl: 'https://other.example/v1', apiMode: 'chat_completions' },
    { baseUrl: 'https://provider.example/v1', apiMode: 'responses' },
    { baseUrl: 'https://provider.example/v2', apiMode: 'chat_completions' }
  ]) {
    await expect(loading).toBeVisible()
    const before = await count()
    staleRequests.push(before - 1)
    await url.fill(edit.baseUrl)
    await mode.selectOption(edit.apiMode)
    await expect(loading).toHaveCount(0)
    await expect(provider.getByRole('textbox', { name: 'AI model' })).toHaveValue('test-model')
    await expect(provider.getByLabel('AI API key')).toHaveAttribute('placeholder', 'Enter API key for this endpoint')
    expect(await count()).toBe(before)
    await url.fill('https://provider.example/v1')
    await mode.selectOption('chat_completions')
    await expect(loading).toBeVisible()
    expect(await count()).toBe(before + 1)
  }
  await finish((await count()) - 1, [{ id: 'test-model' }, { id: 'current-model' }])
  await expect(loading).toHaveCount(0)
  await expect(provider.getByRole('combobox', { name: 'AI model' })).toHaveValue('test-model')
  for (const index of staleRequests.reverse()) {
    await finish(index, [{ id: `late-model-${index}` }])
    await expect(provider.getByRole('combobox', { name: 'AI model' }).getByRole('option')).toHaveText(['test-model', 'current-model'])
    await expect(loading).toHaveCount(0)
  }
  expect(await count()).toBe(4)
})

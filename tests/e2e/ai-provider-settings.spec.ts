import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('configures a planning provider without exposing its API key @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Provider Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/provider-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible()
  await expect(page.getByLabel('MCP launch command')).toHaveValue('npm run mcp:serve')
  await expect(page.getByText('9 registered', { exact: true })).toBeVisible()
  await page.getByLabel('Provider URL').fill('https://example.test/v1')
  await page.getByLabel('AI model').fill('test-model')
  await page.getByLabel('AI API key').fill('super-secret-key')
  await page.getByRole('button', { name: 'Save AI provider' }).click()
  await expect(page.getByText('A provider key is securely configured on this Mac.')).toBeVisible()
  await expect(page.getByLabel('AI API key')).toHaveValue('')
  await expect(page.locator('body')).not.toContainText('super-secret-key')
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('ai-provider-settings.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

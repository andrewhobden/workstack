import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('shows a completed agent result with implementation and validation evidence @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Completed Work')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/completed-work')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item title').fill('Show completion evidence')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByRole('button', { name: 'Add to Backlog' }).click()
  await seedCompletion(page)
  await page.reload()
  await page.getByRole('button', { name: 'Completed', exact: true }).click()
  await page.getByRole('button', { name: 'Show completion evidence' }).click()
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible()
  await expect(page.getByText('All relevant tests passed.', { exact: true })).toBeVisible()
  await expect(page.getByText('src/core/claims.ts', { exact: false })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('completed-result.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

async function seedCompletion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'workstack-browser-state'
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}') as {
      projects: Array<{ id: string }>
      workItemsByProject: Record<string, Array<{ id: string; status: string; completedAt: string | null; updatedAt: string }>>
      completionsByWorkItem?: Record<string, unknown>
    }
    const workItem = state.workItemsByProject[state.projects[0].id][0]
    const now = new Date().toISOString()
    workItem.status = 'completed'
    workItem.completedAt = now
    workItem.updatedAt = now
    state.completionsByWorkItem ??= {}
    state.completionsByWorkItem[workItem.id] = {
      workItemId: workItem.id,
      summaryMarkdown: 'Agent delivered a reliable completion surface.',
      implementationNotesMarkdown: 'Added shared completion retrieval and a result panel.',
      validationMarkdown: 'All relevant tests passed.',
      knownLimitationsMarkdown: '',
      filesChanged: ['src/core/claims.ts'],
      componentsChanged: ['completion UI'],
      commitSha: '123abc',
      branch: 'workstack/completed-result',
      prUrl: null,
      completedByAgentId: 'codex',
      completedBySessionId: 'session-42',
      createdAt: now
    }
    window.localStorage.setItem(key, JSON.stringify(state))
  })
}

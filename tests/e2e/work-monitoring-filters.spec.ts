import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('filters and sorts the backlog by delivery-relevant metadata @a11y @visual', async ({ page }) => {
  await createProject(page, 'Backlog Filters')
  await createWorkItem(page, 'Manual high priority', 'bug', 'high')
  await createWorkItem(page, 'AI design review', 'feature', 'normal')
  await createWorkItem(page, 'Older maintenance', 'chore', 'low')
  await seedBacklogMetadata(page)
  await page.reload()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()

  await page.getByLabel('Filter by attachments').selectOption('with')
  await expect(page.getByText('AI design review', { exact: true })).toBeVisible()
  await expect(page.getByText('Manual high priority', { exact: true })).toHaveCount(0)
  await page.getByLabel('Filter by source').selectOption('ai')
  await expect(page.getByText('AI design review', { exact: true })).toBeVisible()
  await page.getByLabel('Filter by attachments').selectOption('all')
  await page.getByLabel('Filter by source').selectOption('all')
  await page.getByLabel('Filter by priority').selectOption('high')
  await expect(page.getByText('Manual high priority', { exact: true })).toBeVisible()
  await page.getByLabel('Filter by priority').selectOption('')
  await page.getByLabel('Sort backlog').selectOption('created-asc')
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('backlog-monitoring-filters.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

test('searches completed history across evidence and groups reverse chronology @a11y @visual', async ({ page }) => {
  await createProject(page, 'Completed History')
  await createWorkItem(page, 'Newest delivery', 'feature', 'normal')
  await createWorkItem(page, 'Older delivery', 'chore', 'low')
  await seedCompletedHistory(page)
  await page.reload()
  await page.getByRole('button', { name: 'Completed', exact: true }).click()

  await expect(page.getByRole('heading', { name: /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/ }).first()).toBeVisible()
  await page.getByLabel('Search completed work').fill('commit-older')
  await expect(page.getByRole('button', { name: /Older delivery/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Newest delivery/ })).toHaveCount(0)
  await page.getByLabel('Search completed work').fill('')
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('completed-history-search.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

async function createProject(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Project' })
  await dialog.getByLabel('Project name').fill(name)
  await dialog.getByLabel('Project folder').fill(`/workspace/${name.toLowerCase().replaceAll(' ', '-')}`)
  await dialog.getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
}

async function createWorkItem(page: Page, title: string, type: 'feature' | 'bug' | 'chore', priority: 'high' | 'normal' | 'low'): Promise<void> {
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Work Item' })
  await dialog.getByLabel('Work item type').selectOption(type)
  await dialog.getByLabel('Work item title').fill(title)
  await dialog.getByLabel('Work item priority').selectOption(priority)
  await dialog.getByRole('button', { name: 'Add to Backlog' }).click()
}

async function seedBacklogMetadata(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'workstack-browser-state'
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}') as {
      projects: Array<{ id: string }>
      workItemsByProject: Record<string, Array<{ id: string; title: string; source: string; createdAt: string }>>
      attachmentsByWorkItem?: Record<string, unknown[]>
    }
    const items = state.workItemsByProject[state.projects[0].id]
    const aiItem = items.find((item) => item.title === 'AI design review')!
    const olderItem = items.find((item) => item.title === 'Older maintenance')!
    aiItem.source = 'ai_plan'
    olderItem.createdAt = '2024-01-02T09:00:00.000Z'
    state.attachmentsByWorkItem ??= {}
    state.attachmentsByWorkItem[aiItem.id] = [{
      id: 'attachment-1', workItemId: aiItem.id, planningSessionId: null, originalFilename: 'design.png',
      storedRelativePath: `work-items/${aiItem.id}/attachments/design.png`, mimeType: 'image/png', sizeBytes: 68,
      sha256: null, createdAt: aiItem.createdAt, previewUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg=='
    }]
    window.localStorage.setItem(key, JSON.stringify(state))
  })
}

async function seedCompletedHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'workstack-browser-state'
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}') as {
      projects: Array<{ id: string }>
      workItemsByProject: Record<string, Array<{ id: string; title: string; status: string; completedAt: string | null; updatedAt: string }>>
      completionsByWorkItem?: Record<string, unknown>
    }
    const items = state.workItemsByProject[state.projects[0].id]
    state.completionsByWorkItem ??= {}
    for (const [index, item] of items.entries()) {
      const completedAt = index === 0 ? '2026-08-10T10:00:00.000Z' : '2026-08-08T10:00:00.000Z'
      item.status = 'completed'
      item.completedAt = completedAt
      item.updatedAt = completedAt
      state.completionsByWorkItem[item.id] = {
        workItemId: item.id, summaryMarkdown: `Completion for ${item.title}`, implementationNotesMarkdown: '',
        validationMarkdown: '', knownLimitationsMarkdown: '', filesChanged: [], componentsChanged: [],
        commitSha: index === 0 ? 'commit-newer' : 'commit-older', branch: null, prUrl: null,
        completedByAgentId: 'codex', completedBySessionId: 'session-history', createdAt: completedAt
      }
    }
    window.localStorage.setItem(key, JSON.stringify(state))
  })
}

import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('shows active agent work, attention semantics, and safe forced release @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Coordination Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/coordination-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item title').fill('Coordinate a coding agent')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByRole('button', { name: 'Add to Backlog' }).click()

  await seedActiveClaim(page, { blockedReason: null })
  await page.reload()
  await page.getByRole('button', { name: 'In Progress', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'In Progress' })).toBeVisible()
  await expect(page.getByText('Codex', { exact: true })).toBeVisible()
  await expect(page.getByText('Session session-42')).toBeVisible()
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Coordinate a coding agent/ }).click()
  await expect(page.getByRole('status', { name: 'Active claim for Codex' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Force release' })).toBeVisible()
  await expect(page).toHaveScreenshot('active-agent-claim.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })

  await page.getByRole('button', { name: 'Force release' }).click()
  const dialog = page.getByRole('dialog', { name: 'Release agent claim' })
  await expect(dialog.getByText('A recent heartbeat is recorded for this agent.')).toBeVisible()
  await dialog.getByLabel('Release reason').fill('Reassigned after a support handoff')
  await dialog.getByRole('button', { name: 'Release claim' }).click()
  await expect(page.getByLabel('Work item details').getByText('Backlog', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Force release' })).toHaveCount(0)

  await seedActiveClaim(page, { blockedReason: 'Waiting for repository access' })
  await page.reload()
  await page.getByRole('button', { name: 'In Progress', exact: true }).click()
  await expect(page.getByText('Attention', { exact: true })).toBeVisible()
  await expect(page.getByText('Waiting for repository access')).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

async function seedActiveClaim(page: Page, options: { blockedReason: string | null }): Promise<void> {
  await page.evaluate((blockedReason) => {
    const key = 'workstack-browser-state'
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}') as {
      projects: Array<{ id: string }>
      workItemsByProject: Record<string, Array<{ id: string; status: string; updatedAt: string }>>
      claimsByWorkItem?: Record<string, unknown[]>
    }
    const project = state.projects[0]
    const workItem = state.workItemsByProject[project.id][0]
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    workItem.status = 'in_progress'
    workItem.updatedAt = now
    state.claimsByWorkItem ??= {}
    state.claimsByWorkItem[workItem.id] = [
      {
        id: 'b5fc7d89-6908-4b1e-a029-a2f1c60d6ecf',
        workItemId: workItem.id,
        agentId: 'codex',
        agentDisplayName: 'Codex',
        sessionId: 'session-42',
        claimedAt: now,
        lastHeartbeatAt: now,
        leaseExpiresAt: expiresAt,
        state: 'active',
        releaseReason: null,
        blockedReason,
        releasedAt: null,
        completedAt: null
      }
    ]
    window.localStorage.setItem(key, JSON.stringify(state))
  }, options.blockedReason)
}

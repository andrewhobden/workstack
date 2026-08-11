import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('filters activity, inspects an agent lease, and quick looks selected evidence @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  const project = page.getByRole('dialog', { name: 'New Project' })
  await project.getByLabel('Project name').fill('Agent Monitoring')
  await project.getByLabel('Project folder').fill('/workspace/agent-monitoring')
  await project.getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  const item = page.getByRole('dialog', { name: 'New Work Item' })
  await item.getByLabel('Work item title').fill('Inspect active delivery')
  await item.getByRole('button', { name: 'Add to Backlog' }).click()
  await seedAgentMonitoring(page)
  await page.reload()

  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents' }).click()
  await expect(page.getByText('work item heartbeated', { exact: true })).toBeVisible()
  await expect(page.getByText('work item created', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'In Progress', exact: true }).click()
  await page.getByRole('button', { name: 'View details for Codex' }).click()
  const detail = page.getByRole('dialog', { name: 'Agent details' })
  await expect(detail.getByText('Codex', { exact: true })).toBeVisible()
  await expect(detail.getByText('Recent Workstack actions', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Close Agent details' }).click()

  await page.getByRole('button', { name: 'In Progress', exact: true }).click()
  await page.getByRole('button', { name: /Inspect active delivery/ }).click()
  const quickLook = page.getByRole('button', { name: 'Quick Look evidence.png' })
  await quickLook.focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('dialog', { name: 'Quick Look' })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('agent-detail-and-quick-look.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

async function seedAgentMonitoring(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'workstack-browser-state'
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}') as {
      projects: Array<{ id: string }>
      workItemsByProject: Record<string, Array<{ id: string; status: string; updatedAt: string }>>
      claimsByWorkItem?: Record<string, unknown[]>
      attachmentsByWorkItem?: Record<string, unknown[]>
      activityByProject?: Record<string, unknown[]>
    }
    const project = state.projects[0]
    const workItem = state.workItemsByProject[project.id][0]
    const now = new Date().toISOString()
    workItem.status = 'in_progress'
    workItem.updatedAt = now
    state.claimsByWorkItem ??= {}
    state.claimsByWorkItem[workItem.id] = [{
      id: 'claim-1', workItemId: workItem.id, agentId: 'codex', agentDisplayName: 'Codex', sessionId: 'session-monitor',
      claimedAt: now, lastHeartbeatAt: now, leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      state: 'active', releaseReason: null, blockedReason: null, releasedAt: null, completedAt: null
    }]
    state.attachmentsByWorkItem ??= {}
    state.attachmentsByWorkItem[workItem.id] = [{
      id: 'attachment-1', workItemId: workItem.id, planningSessionId: null, originalFilename: 'evidence.png',
      storedRelativePath: `work-items/${workItem.id}/attachments/evidence.png`, mimeType: 'image/png', sizeBytes: 68,
      sha256: null, createdAt: now, previewUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg=='
    }]
    state.activityByProject ??= {}
    state.activityByProject[project.id] = [
      { id: 'heartbeat-1', eventType: 'work_item_heartbeated', actorType: 'agent', actorId: 'codex', workItemId: workItem.id, payload: {}, createdAt: now },
      { id: 'created-1', eventType: 'work_item_created', actorType: 'human', actorId: null, workItemId: workItem.id, payload: {}, createdAt: new Date(Date.now() - 1000).toISOString() }
    ]
    window.localStorage.setItem(key, JSON.stringify(state))
  })
}

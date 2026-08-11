import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('turns a protected proposal into a backlog work item only by explicit conversion @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Planning Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/planning-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByLabel('Attach planning files').setInputFiles({
    name: 'planning-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Durable evidence for this proposal.')
  })
  await expect(dialog.getByText('planning-evidence.txt', { exact: true })).toBeVisible()
  await dialog.getByLabel('Proposal title').fill('Plan protected proposals')
  await dialog.getByLabel('Proposal objective').fill('Users keep manual edits when planning.')
  await dialog.getByLabel('Proposal acceptance criteria').fill('- [ ] User chooses Add to Backlog')
  await dialog.getByRole('button', { name: 'Inspect context' }).click()
  await expect(dialog.getByText('Planning Project', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Attached planning evidence. File contents are not included automatically.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Request suggestion' }).click()
  await expect(dialog.getByRole('paragraph').filter({ hasText: 'Suggested planning notes for: Create a concise implementation suggestion' })).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Planning conversation' })).toContainText('user')
  await expect(dialog.getByRole('list', { name: 'Planning conversation' })).toContainText('assistant')
  await dialog.getByRole('button', { name: 'Add to Backlog' }).click()
  await expect(page.getByText('Plan protected proposals', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await expect(page.getByText('Plan protected proposals', { exact: true })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('backlog-from-plan.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 })
})

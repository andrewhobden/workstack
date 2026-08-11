import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('supports keyboard-led recovery, durable operational settings, and dark appearance @a11y @visual', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  const projectDialog = page.getByRole('dialog', { name: 'New Project' })
  await projectDialog.getByLabel('Project name').fill('Release Workspace')
  await projectDialog.getByLabel('Project folder').fill('/tmp/release-workspace')
  await projectDialog.getByRole('button', { name: 'Create Project' }).click()

  await page.keyboard.press('Meta+2')
  await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeVisible()
  await expect(page.locator('.inline-empty').getByRole('button', { name: 'Plan new work with AI' })).toBeVisible()

  await page.keyboard.press('Meta+n')
  const workItemDialog = page.getByRole('dialog', { name: 'New Work Item' })
  await workItemDialog.getByLabel('Work item title').fill('Release polish task')
  await workItemDialog.getByLabel('Work item description').fill('Exercise keyboard-first release workflows.')
  await page.keyboard.press('Meta+Enter')
  await expect(page.getByRole('table', { name: 'Backlog work items' }).getByText('Release polish task')).toBeVisible()

  await page.keyboard.press('Meta+Shift+n')
  await expect(page.getByRole('dialog', { name: 'Plan with AI' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Plan with AI' })).toBeHidden()

  await page.keyboard.press('Meta+5')
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible()
  await expect(page.getByText('Build your project knowledge. Add existing documentation or let Workstack accumulate knowledge as work is completed.')).toBeVisible()

  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByLabel('Search commands and project content').fill('Add knowledge source')
  await palette.getByRole('button', { name: 'Add knowledge source' }).click()
  await expect(page.getByRole('dialog', { name: 'Add Knowledge Source' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Add Knowledge Source' })).toBeHidden()

  await page.keyboard.press('Meta+k')
  await palette.getByLabel('Search commands and project content').fill('release polish task')
  await palette.getByRole('button', { name: /Open backlog:.*Release polish task/ }).click()
  await expect(page.getByRole('heading', { name: 'Release polish task' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Backlog' }).click()

  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  await page.getByLabel('Default lease duration').fill('900')
  await page.getByLabel('Expected heartbeat interval').fill('120')
  await page.getByLabel('Auto-release expired claims').uncheck()
  await page.getByLabel('Auto-update knowledge after completion').uncheck()
  await page.keyboard.press('Meta+Enter')
  await page.reload()
  await page.getByRole('button', { name: 'Project Settings', exact: true }).click()
  await expect(page.getByLabel('Default lease duration')).toHaveValue('900')
  await expect(page.getByLabel('Expected heartbeat interval')).toHaveValue('120')
  await expect(page.getByLabel('Auto-release expired claims')).not.toBeChecked()
  await expect(page.getByLabel('Auto-update knowledge after completion')).not.toBeChecked()

  await page.keyboard.press('Meta+k')
  await palette.getByRole('button', { name: 'Copy MCP configuration' }).click()
  await expect(palette.getByRole('button', { name: 'MCP configuration copied' })).toBeVisible()
  await page.keyboard.press('Escape')

  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('release-polish-dark.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })
})

import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('selects a project folder from the native picker flow @a11y', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Project' })

  await dialog.getByRole('button', { name: 'Choose...' }).click()

  await expect(dialog.getByLabel('Project folder')).toHaveValue('/tmp/workstack-project')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('creates, reopens, and safely detaches a project @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Workstack Demo')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project description').fill('A stylish local workspace')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/workstack-demo')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()

  await expect(page.getByRole('heading', { name: 'Workstack Demo' })).toBeVisible()
  await page.getByRole('button', { name: 'Project Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Detach Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Backlog', exact: true })).toHaveCount(0)
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('project-settings-detached.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })
})

test('requires confirmation, preserves cancellation, and reports the project-data backup after deletion @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Deletion Demo')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/deletion-demo')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Project Settings' }).click()
  await page.getByRole('button', { name: 'Delete Project' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete Deletion Demo from Workstack?' })
  await expect(dialog).toContainText('Your repository root and all non-Workstack files will remain exactly where they are.')
  await expect(dialog.getByRole('button', { name: 'Back up and delete project' })).toBeDisabled()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('project-deletion-confirmation.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible()

  await page.getByRole('button', { name: 'Delete Project' }).click()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Back up and delete project' }).click()
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Your .workstack backup is available at /workstack-browser-backups/project-deletions/')
})

test('creates, finds, edits, and retains a work item after reload @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Product Work')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/product-work')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item title').fill('Support pasted screenshots')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item description').fill('Users can paste images directly into the editor.')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item acceptance criteria').fill('Image persists after restart.')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item priority').selectOption('high')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByRole('button', { name: 'Add to Backlog' }).click()

  await expect(page.getByRole('table', { name: 'Backlog work items' }).getByText('Support pasted screenshots')).toBeVisible()
  await page.getByPlaceholder('Search backlog').fill('screenshots')
  await page.getByText('Support pasted screenshots', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Support pasted screenshots' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Work item title').fill('Support pasted images')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'Support pasted images' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await expect(page.getByText('Support pasted images', { exact: true })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('backlog-with-work-item.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })
})

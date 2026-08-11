import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('shows a clear no-project starting point @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ New Project' }).first()).toBeVisible()
  await expect(page.getByLabel('Project navigation')).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('empty-projects.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })
})

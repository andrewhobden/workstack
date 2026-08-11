import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('opens command palette with Command-K and navigates to knowledge @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Palette Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/palette-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await page.keyboard.press('Meta+k')
  await palette.getByRole('button', { name: 'Go to Knowledge' }).click()
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('command-palette-knowledge.png', { animations: 'disabled', maxDiffPixelRatio: 0.01 })
})

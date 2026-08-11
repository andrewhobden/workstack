import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==',
  'base64'
)

test('stores picker, drag-drop, and pasted image context durably @a11y @visual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill('Artifact Project')
  await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project folder').fill('/tmp/artifact-project')
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Create Project' }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  await page.getByRole('dialog', { name: 'New Work Item' }).getByLabel('Work item title').fill('Capture visual context')
  await page.getByRole('dialog', { name: 'New Work Item' }).getByRole('button', { name: 'Add to Backlog' }).click()
  await page.getByText('Capture visual context', { exact: true }).click()

  await page.getByLabel('Add attachments').setInputFiles({
    name: 'picker.png',
    mimeType: 'image/png',
    buffer: onePixelPng
  })
  await expect(page.getByRole('img', { name: 'picker.png preview' })).toBeVisible()

  await page.getByLabel('Drop attachments or paste screenshots here').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['dragged notes'], 'dropped-notes.txt', { type: 'text/plain' }))
      return data
    })
  })
  await expect(page.getByText('dropped-notes.txt', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  const description = page.getByLabel('Work item description')
  await description.evaluate((element, png) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(png)], 'pasted.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, Array.from(onePixelPng))
  await expect(page.getByRole('img', { name: 'pasted.png preview' })).toBeVisible()
  await expect(description).toHaveValue(/!\[pasted\.png\]\(attachments\//)

  await page.getByRole('button', { name: 'Remove dropped-notes.txt' }).click()
  await expect(page.getByText('dropped-notes.txt', { exact: true })).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByText('Capture visual context', { exact: true }).click()
  await expect(page.getByRole('img', { name: 'picker.png preview' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'pasted.png preview' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'pasted.png', exact: true })).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page).toHaveScreenshot('work-item-attachments.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.001
  })
})

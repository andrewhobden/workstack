import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function installProjectKnowledge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = '2026-09-09T00:00:00.000Z'
    const project = { id: 'project-context', name: 'Project context', rootPath: '/tmp/context', description: '', createdAt: now, updatedAt: now, settings: { workItemPrefix: 'CTX', defaultLeaseSeconds: 600, heartbeatSeconds: 30, autoReleaseExpiredClaims: true, autoUpdateKnowledgeOnCompletion: false } }
    const records = [{ id: 'record:one', kind: 'decision', title: 'Keep ownership explicit', status: 'accepted', markdown: 'The adapter owns requests.', rationale: 'Preserve one owner.', references: [{ kind: 'file', path: 'src/adapter.ts' }], confidence: 0.8, reviewDueAt: now, version: 1, createdAt: now, updatedAt: now, current: true, readiness: 'needs_review', locator: 'record://one', trust: 'untrusted_reference' }, { id: 'record:two', kind: 'decision', title: 'Name each request owner', status: 'accepted', markdown: 'Every request identifies its owner.', rationale: 'Make ownership inspectable.', references: [], version: 1, createdAt: now, updatedAt: now, current: true, readiness: 'ready', locator: 'record://two', trust: 'untrusted_reference' }]
    const entities = [{ id: 'entity:one', kind: 'component', displayName: 'Request adapter', aliases: ['Adapter'], definition: 'Owns incoming requests.', references: [], status: 'active', version: 1, createdAt: now, updatedAt: now, locator: 'entity://one', trust: 'untrusted_reference' }, { id: 'entity:two', kind: 'component', displayName: 'Legacy adapter', aliases: ['Adapter'], definition: 'The original adapter name.', references: [], status: 'active', version: 1, createdAt: now, updatedAt: now, locator: 'entity://two', trust: 'untrusted_reference' }]
    const state = { recordAttempts: 0, entityAttempts: 0, mergeAttempts: 0, checks: 0, reviews: [] as unknown[], updates: [] as unknown[], splits: [] as unknown[], merges: [] as unknown[] }
    const record = (id: string) => records.find((entry) => entry.id === id)!
    const entity = (id: string) => entities.find((entry) => entry.id === id)!
    const history = (id: string) => [{ version: record(id).version, actor: 'owner', reason: 'Saved governing guidance.', changedAt: now, snapshot: structuredClone(record(id)) }]
    const detail = (id: string) => ({ entity: structuredClone(entity(id)), canonicalEntity: structuredClone(entity(id)), mentions: [], history: [{ id: 1, entityId: id, action: 'created', actor: 'owner', reason: 'Curated project definition.', createdAt: now, snapshot: structuredClone(entity(id)) }] })
    Object.assign(window, { projectKnowledgeFixture: state, workstack: {
      system: { appVersion: async () => 'test' }, ai: { cancel: async () => true }, projects: { list: async () => [{ ...project, lastOpenedAt: now, backlogCount: 0, inProgressCount: 0, completedCount: 0 }], get: async () => project }, workItems: { list: async () => [] }, claims: { list: async () => [] }, knowledge: {
        listSources: async () => [], listWiki: async () => [],
        retrieve: async (_projectId: string, query: string) => { const results = [{ sourceId: 'record:one', recordId: 'record:one', sourceType: 'knowledge_record', title: 'Keep ownership explicit', excerpt: 'The adapter owns requests.', location: 'record://one', relevance: 1 }, { sourceId: 'entity:one', entityId: 'entity:one', sourceType: 'project_entity', title: 'Request adapter', excerpt: 'Owns incoming requests.', location: 'entity://one', relevance: 0.9 }]; return { query, results, groups: [{ sourceType: 'knowledge_record', label: 'Decisions, requirements and risks', results: [results[0]] }, { sourceType: 'project_entity', label: 'Components and glossary', results: [results[1]] }], mode: 'lexical', fallbackReason: 'Local model is unavailable; exact project matches remain searchable.' } }
      }, wikiAutomation: { listReports: async () => [] },
      knowledgeRecords: {
        list: async () => structuredClone(records), get: async (_projectId: string, id: string) => structuredClone(record(id)), history: async (_projectId: string, id: string) => history(id), reviews: async () => structuredClone(state.reviews),
        checks: async () => { state.checks++; return [{ id: 'finding-1', code: 'review_due', severity: 'info', recordId: 'record:one', locator: 'record://one', reason: 'The recorded review date is due.', action: 'Confirm the evidence or update the guidance.' }] },
        update: async (_projectId: string, id: string, input: Record<string, unknown>) => { state.recordAttempts++; state.updates.push(input); if (state.recordAttempts === 1) throw new Error('The saved version changed. Review the latest record.'); Object.assign(record(id), input, { version: record(id).version + 1 }); return structuredClone(record(id)) },
        review: async (_projectId: string, id: string, actor: string, note: string, outcome: string) => { const review = { id: 'review-1', recordId: id, actor, note, outcome, reviewedAt: now, recordVersion: record(id).version }; state.reviews.push(review); return review },
        supersede: async (_projectId: string, id: string, replacementId: string) => { Object.assign(record(id), { status: 'superseded', supersededBy: replacementId, current: false, readiness: 'historical' }); return structuredClone(record(id)) },
        create: async (_projectId: string, input: Record<string, unknown>) => { const created = { ...structuredClone(records[0]), ...input, id: 'record:new' }; records.push(created); return created }
      },
      projectDirectory: {
        list: async () => structuredClone(entities), detail: async (_projectId: string, id: string) => detail(id), lookup: async (_projectId: string, query: string) => ({ query, match: 'ambiguous', candidates: structuredClone(entities) }),
        update: async (_projectId: string, id: string, input: Record<string, unknown>) => { state.entityAttempts++; if (state.entityAttempts === 1) throw new Error('Directory storage is temporarily unavailable.'); Object.assign(entity(id), input, { version: entity(id).version + 1 }); return structuredClone(entity(id)) },
        split: async (_projectId: string, id: string, input: { entry: Record<string, unknown>; aliases: string[] }) => { state.splits.push(input); const created = { ...structuredClone(entity(id)), ...input.entry, aliases: input.aliases, id: 'entity:split', version: 1 }; entities.push(created); return detail(created.id) },
        merge: async (_projectId: string, sourceId: string, targetId: string, input: unknown) => { state.mergeAttempts++; state.merges.push({ sourceId, targetId, input }); if (state.mergeAttempts === 1) throw new Error('The surviving entry changed. Reload before merging.'); return detail(targetId) },
        resolveMention: async () => undefined, create: async () => entities[0]
      }
    } as unknown as DesktopApi })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
}

test('knowledge checks open affected guidance and failed edits preserve the draft through review and supersession', async ({ page }, testInfo) => {
  await installProjectKnowledge(page)
  await page.getByRole('button', { name: 'Decisions, requirements and risks', exact: true }).click()
  await expect(page.getByText('Confirm the evidence or update the guidance.')).toBeVisible()
  await page.getByRole('button', { name: 'Review Keep ownership explicit' }).click()
  await page.getByLabel('Knowledge record title').fill('Keep request ownership explicit')
  await page.getByLabel('Knowledge record confidence').fill('')
  await page.getByLabel('Knowledge review due date').fill('')
  await page.getByLabel('Knowledge change reason').fill('Clarify request scope.')
  await page.getByRole('button', { name: 'Save knowledge record' }).click()
  await expect(page.getByRole('alert')).toContainText('saved version changed')
  await expect(page.getByLabel('Knowledge record title')).toHaveValue('Keep request ownership explicit')
  await expect(page.getByLabel('Knowledge change reason')).toHaveValue('Clarify request scope.')
  await page.getByRole('button', { name: 'Save knowledge record' }).click()
  await expect(page.getByRole('status')).toContainText('Knowledge record saved')
  expect(await page.evaluate('window.projectKnowledgeFixture.updates[1]')).toMatchObject({ confidence: null, reviewDueAt: null, expectedVersion: 1 })
  await page.getByText('Review or supersede this record', { exact: true }).click()
  await page.getByLabel('Knowledge review note').fill('Verified the saved guidance against implementation.')
  await page.getByRole('button', { name: 'Confirm saved guidance' }).click()
  await page.getByText('Review history (1)', { exact: true }).click()
  await expect(page.getByText('confirmed · local-user')).toBeVisible()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('knowledge-record-review.png') })
  await page.getByLabel('Superseding knowledge record').selectOption('record:two')
  await page.getByRole('button', { name: 'Supersede with selected record' }).click()
  await expect(page.locator('.source-notice').filter({ hasText: 'decision · superseded · historical' })).toBeVisible()
})

test('unified search opens the named guidance and directory identity while explaining lexical fallback', async ({ page }) => {
  await installProjectKnowledge(page)
  await page.getByLabel('Search knowledge', { exact: true }).fill('adapter ownership')
  const results = page.getByRole('region', { name: 'Knowledge retrieval results' })
  await expect(results.getByRole('status')).toContainText('lexical retrieval. Local model is unavailable')
  await results.getByRole('button', { name: /Keep ownership explicit/ }).click()
  await expect(page.getByLabel('Knowledge record title')).toHaveValue('Keep ownership explicit')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await results.getByRole('button', { name: /Request adapter/ }).click()
  await expect(page.getByLabel('Directory canonical name')).toHaveValue('Request adapter')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Search knowledge', { exact: true })).toHaveValue('adapter ownership')
})

test('directory lookup preserves ambiguous names and failed edits before splitting an approved alias', async ({ page }, testInfo) => {
  await installProjectKnowledge(page)
  await page.getByRole('button', { name: 'Components and glossary', exact: true }).click()
  await page.getByLabel('Find component or glossary term').fill('Adapter')
  await expect(page.getByText('This name matches more than one entry.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Request adapter', exact: true }).click()
  await page.getByLabel('Directory definition').fill('Owns and traces incoming requests.')
  await page.getByLabel('Directory change reason').fill('Document the tracing responsibility.')
  await page.getByRole('button', { name: 'Save directory entry' }).click()
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable')
  await expect(page.getByLabel('Directory definition')).toHaveValue('Owns and traces incoming requests.')
  await page.getByRole('button', { name: 'Save directory entry' }).click()
  await expect(page.getByRole('status')).toHaveText('Directory entry saved.')
  await page.getByText('Correct names, matches, or duplicate entries', { exact: true }).click()
  await page.getByLabel('Directory correction reason').fill('The alias names a separate helper.')
  await page.getByLabel('Split entry name').fill('Adapter helper')
  await page.getByLabel('Split entry definition').fill('Maps helper requests to the owner.')
  await page.getByLabel('Move alias Adapter', { exact: true }).check()
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('directory-correction.png') })
  await page.getByRole('button', { name: 'Create separate identity' }).click()
  await expect(page.getByRole('dialog', { name: 'Adapter helper' })).toBeVisible()
  expect(await page.evaluate('window.projectKnowledgeFixture.splits[0]')).toMatchObject({ aliases: ['Adapter'], expectedVersion: 2, reason: 'The alias names a separate helper.' })
})

test('a directory merge keeps the selected target and reason after a stale-version error', async ({ page }) => {
  await installProjectKnowledge(page)
  await page.getByRole('button', { name: 'Components and glossary', exact: true }).click()
  await page.getByRole('button', { name: 'Legacy adapter', exact: true }).click()
  await page.getByText('Correct names, matches, or duplicate entries', { exact: true }).click()
  await page.getByLabel('Directory correction reason').fill('These names identify the same component.')
  await page.getByLabel('Surviving directory entry').selectOption('entity:one')
  await page.getByRole('button', { name: 'Merge into selected entry' }).click()
  await expect(page.getByRole('alert')).toContainText('surviving entry changed')
  await expect(page.getByLabel('Surviving directory entry')).toHaveValue('entity:one')
  await expect(page.getByLabel('Directory correction reason')).toHaveValue('These names identify the same component.')
  await page.getByRole('button', { name: 'Merge into selected entry' }).click()
  await expect(page.getByRole('dialog', { name: 'Request adapter' })).toBeVisible()
})

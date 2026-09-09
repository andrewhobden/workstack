import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function installCatalogFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = '2026-09-09T00:00:00.000Z'
    const project = { id: 'catalog-project', name: 'Context project', rootPath: '/tmp/context', description: '', createdAt: now, updatedAt: now, settings: { workItemPrefix: 'CTX', defaultLeaseSeconds: 600, heartbeatSeconds: 30, autoReleaseExpiredClaims: true, autoUpdateKnowledgeOnCompletion: false } }
    const source = { id: 'source-1', kind: 'repo_file', title: 'Architecture evidence', canonicalUri: 'repo://context/README.md', repositoryPath: 'README.md', policy: 'tracked_content', state: 'stale', currentRevisionId: 'revision-2', refreshSeconds: 3600, lastAttemptAt: now, lastSuccessfulCheckAt: now, lastContentChangeAt: now, nextRefreshAt: now, staleReason: 'Origin changed after the last successful content import.', createdAt: now, updatedAt: now }
    const citation = { sourceId: source.id, revisionId: 'revision-1', passageId: 'passage-1', contentHash: 'a'.repeat(64), normalizedHash: 'b'.repeat(64), passageHash: 'c'.repeat(64), headingTrail: ['Architecture', 'Claim ownership'], startLine: 801, endLine: 805, startOffset: 5000, endOffset: 5100, locator: 'source://source-1/revisions/revision-1/passages/0#L801-L805' }
    const passage = { citation, title: source.title, text: 'Exact historical ownership evidence. Lease tokens fence concurrent writes.', sourceKind: source.kind, canonicalUri: source.canonicalUri, historical: true, readiness: 'stale', structure: { kind: 'markdown', continued: false }, relevance: 1, trust: 'untrusted_reference' }
    const job = { id: 'job-1', sourceId: source.id, processor: 'catalog', stage: 'fetch', payload: {}, status: 'failed', attempts: 2, owner: null, leaseExpiresAt: null, nextAttemptAt: null, errorMessage: 'Access to the source was interrupted.', createdAt: now, updatedAt: now }
    const revision = { id: 'revision-1', sourceId: source.id, contentHash: citation.contentHash, normalizedHash: citation.normalizedHash, upstreamRevision: 'commit-original', acquiredBy: 'fixture-import', acquiredAt: now, converter: 'workstack-text', converterVersion: '1', outcome: 'complete', manifest: { originalCharacters: 100, normalizedCharacters: 100, passages: 1, redacted: false, completeness: 'complete', limitations: [], metadata: {}, originalLocator: 'source://original', normalizedLocator: 'source://normalized', trust: 'untrusted_reference' } }
    const wiki = { id: 'wiki-1', requestKey: 'proposal-1', title: 'Document claim ownership', baseRevisionId: 'wiki-base', status: 'proposed', author: 'wiki-worker', rationale: 'Record the verified ownership behavior.', evidence: { source: citation.locator }, actor: null, reviewNote: null, createdAt: now, reviewedAt: null }
    const state = { imports: [] as unknown[], retries: [] as string[], cancelled: [] as string[], citationReads: [] as number[], publications: 0, staleWiki: true, articleVisible: false }
    const bridge = {
      system: { appVersion: async () => 'test' }, ai: { cancel: async () => true },
      projects: { list: async () => [{ ...project, lastOpenedAt: now, backlogCount: 0, inProgressCount: 0, completedCount: 0 }], get: async () => project },
      workItems: { list: async () => [] }, claims: { list: async () => [] },
      knowledge: { listSources: async () => [], listWiki: async () => state.articleVisible ? [{ slug: 'generated-ownership', content: '# Ownership\nVerified claim fencing.' }] : [] },
      sourceCatalog: {
        list: async () => [structuredClone(source)],
        detail: async () => ({ source: structuredClone(source), revisions: [revision], jobs: [structuredClone(job)], attempts: [{ id: 1, sourceId: source.id, jobId: job.id, attempt: 2, stage: 'fetch', outcome: 'failed', message: job.errorMessage, createdAt: now }] }),
        setPolicy: async (_projectId: string, _sourceId: string, policy: string, refreshSeconds: number) => { Object.assign(source, { policy, refreshSeconds }); return structuredClone(source) },
        retry: async (_projectId: string, id: string) => { state.retries.push(id); Object.assign(job, { status: 'pending', attempts: 0 }); return structuredClone(job) },
        cancel: async (_projectId: string, id: string) => { state.cancelled.push(id); Object.assign(job, { status: 'failed', stage: 'cancelled', errorMessage: 'Cancelled by user' }) },
        refresh: async () => structuredClone(job),
        search: async () => [passage],
        readCitation: async (_projectId: string, _citation: unknown, neighbors: number) => { state.citationReads.push(neighbors); return { passage, neighbors: neighbors ? [{ ...passage, citation: { ...citation, passageId: 'neighbor-1', startLine: 799, endLine: 800, startOffset: 4900 }, text: 'Neighboring evidence preserves the architectural rationale.' }] : [], truncated: false, maxCharacters: 16000 } },
        readRevision: async (_projectId: string, _sourceId: string, _revisionId: string, representation: string) => ({ revision, representation, text: representation === 'original' ? 'Original unmodified evidence.' : 'Normalized evidence for exact citations.', offset: 0, totalCharacters: 100, truncated: false, trust: 'untrusted_reference' }),
        previewRepository: async () => ({ entries: [{ path: 'README.md', kind: 'documentation', sizeBytes: 100, suggested: true }, { path: 'src/claims.ts', kind: 'code', sizeBytes: 200, suggested: false }, { path: '.env', kind: 'other', sizeBytes: 20, suggested: false, excludedReason: 'Sensitive configuration is excluded.' }], commit: 'commit-preview', limited: true, diagnostics: ['Ignored dependency and generated directories.'], limits: { maxInventoryFiles: 1000, maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 2048, maxGithubSources: 3, maxGithubComments: 50, maxGithubPages: 2, maxTextCharacters: 20000 } }),
        importSelection: async (_projectId: string, selection: unknown) => { state.imports.push(selection); return [job] }
      },
      wikiAutomation: { listReports: async () => [] },
      wikiRevisions: {
        list: async () => [structuredClone(wiki)],
        review: async () => ({ revision: structuredClone(wiki), pages: [], changes: [{ slug: 'generated-ownership', before: '# Ownership\nOld ownership behavior.', after: '# Ownership\nVerified claim fencing.' }] }),
        publish: async (_projectId: string, _id: string, actor: string, note: string) => { state.publications++; if (state.staleWiki) throw new Error('The wiki changed after this proposal. Regenerate against the current revision.'); Object.assign(wiki, { status: 'published', actor, reviewNote: note }); state.articleVisible = true; return bridge.wikiRevisions.review(project.id, wiki.id) },
        reject: async () => { wiki.status = 'rejected'; return wiki },
        restore: async () => bridge.wikiRevisions.review(project.id, wiki.id)
      }
    } as unknown as DesktopApi
    Object.assign(window, { workstack: bridge, catalogFixture: state })
  })
}

async function openKnowledge(page: Page): Promise<void> { await page.goto('/'); await page.getByRole('button', { name: 'Knowledge', exact: true }).click() }

test('previews scoped source intake, exclusions and selected GitHub evidence before queueing', async ({ page }, testInfo) => {
  await installCatalogFixture(page); await openKnowledge(page)
  await page.getByRole('button', { name: 'Import project sources', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import project sources' })
  await expect(dialog.getByText('The inventory limit was reached.', { exact: false })).toBeVisible()
  await expect(dialog.getByLabel('Import .env')).toBeDisabled()
  await expect(dialog.getByText('Excluded: Sensitive configuration is excluded.')).toBeVisible()
  await expect(dialog.getByLabel('Import README.md')).toBeChecked()
  await dialog.getByLabel('Import src/claims.ts').check()
  await dialog.getByLabel('GitHub source URLs').fill('https://github.com/example/context/issues/12')
  await page.screenshot({ path: testInfo.outputPath('source-intake-preview.png') })
  await dialog.getByRole('button', { name: 'Import selected sources' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate('window.catalogFixture.imports')).toEqual([{ paths: ['README.md', 'src/claims.ts'], githubUrls: ['https://github.com/example/context/issues/12'], policy: 'tracked_content' }])
})

test('inspects freshness, retries and cancels a specific intake, and reads retained originals', async ({ page }, testInfo) => {
  await installCatalogFixture(page); await openKnowledge(page)
  await page.getByRole('button', { name: 'Architecture evidence', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Architecture evidence' })
  await expect(dialog.getByText('Origin changed after the last successful content import.')).toBeVisible()
  await expect(dialog.locator('.inline-error').filter({ hasText: 'Access to the source was interrupted.' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('source-detail.png') })
  await dialog.getByRole('button', { name: 'Retry this intake' }).click()
  await expect(dialog.getByText('fetch · pending')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel intake' }).click()
  await expect(dialog.getByText('cancelled · failed')).toBeVisible()
  expect(await page.evaluate('window.catalogFixture.retries')).toEqual(['job-1'])
  expect(await page.evaluate('window.catalogFixture.cancelled')).toEqual(['job-1'])
  await dialog.getByRole('button', { name: 'Inspect retained evidence' }).click()
  await expect(page.getByText('Normalized evidence for exact citations.', { exact: true })).toBeVisible()
  await page.getByLabel('Evidence representation').selectOption('original')
  await expect(page.getByText('Original unmodified evidence.', { exact: true })).toBeVisible()
})

test('reads an exact historical citation and bounded neighbors with keyboard and dark appearance', async ({ page }, testInfo) => {
  await installCatalogFixture(page); await openKnowledge(page)
  await page.getByLabel('Search source passages').fill('ownership')
  await page.getByRole('button', { name: 'Architecture evidence Architecture', exact: false }).click()
  const dialog = page.getByRole('dialog', { name: 'Architecture evidence' })
  await expect(dialog.getByText('Historical revision.', { exact: false })).toBeVisible()
  await expect(dialog.getByText('Source is stale.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Cited passage' })).toContainText('Lease tokens fence concurrent writes.')
  await dialog.getByRole('button', { name: 'Show neighboring passages' }).click()
  await expect(dialog.getByRole('region', { name: 'Neighboring passage' })).toContainText('architectural rationale')
  expect(await page.evaluate('window.catalogFixture.citationReads')).toEqual([0, 1])
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('source-citation.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('source-citation-dark.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('Search source passages')).toHaveValue('ownership')
})

test('wiki review retains stale-base failure and publishes only after a successful review', async ({ page }, testInfo) => {
  await installCatalogFixture(page); await openKnowledge(page)
  await page.getByRole('button', { name: 'Document claim ownership', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Document claim ownership' })
  await expect(dialog.getByRole('region', { name: 'Previous article' })).toContainText('Old ownership behavior.')
  await expect(dialog.getByRole('region', { name: 'Proposed article' })).toContainText('Verified claim fencing.')
  await dialog.getByLabel('Review note or reason').fill('Verified against the source revision.')
  await page.screenshot({ path: testInfo.outputPath('wiki-revision-review.png') })
  await dialog.getByRole('button', { name: 'Publish reviewed revision' }).click()
  await expect(dialog.getByRole('alert')).toContainText('wiki changed after this proposal')
  await expect(dialog.getByLabel('Review note or reason')).toHaveValue('Verified against the source revision.')
  await page.evaluate('window.catalogFixture.staleWiki = false')
  await dialog.getByRole('button', { name: 'Publish reviewed revision' }).click()
  await expect(dialog.getByRole('button', { name: 'Publish reviewed revision' })).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'generated-ownership', exact: true })).toBeVisible()
  expect(await page.evaluate('window.catalogFixture.publications')).toBe(2)
})

import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { ContextApproval, ContextPacket, ContextPolicyInput, ContextPreferencesInput } from '../../src/core/context-packet-contracts'
import type { ContextFeedback, ContextFeedbackInput, ContextFeedbackTriage } from '../../src/core/context-feedback-contracts'

async function installContextFixture(page: Page, gap: 'hard' | 'soft' | 'none' = 'none', preflightFails = false): Promise<void> {
  await page.addInitScript(({ gap, preflightFails }) => {
    const now = '2026-09-09T00:00:00.000Z'
    const project = { id: 'context-project', name: 'Context project', rootPath: '/tmp/context', description: '', createdAt: now, updatedAt: now, settings: { workItemPrefix: 'CTX', defaultLeaseSeconds: 600, heartbeatSeconds: 30, autoReleaseExpiredClaims: true, autoUpdateKnowledgeOnCompletion: false, copilotLaunchPrompt: 'Implement with the reviewed project evidence.' } }
    const item = { id: 'task-one', projectId: project.id, displayId: 'CTX-1', title: 'Trace request ownership', descriptionMarkdown: 'Keep request ownership explicit.', acceptanceCriteriaMarkdown: 'Ownership remains visible.', type: 'feature', status: 'backlog', priority: 'medium', source: 'human', createdAt: now, updatedAt: now, labels: [] }
    const source = { id: 'source-one', kind: 'repo_file', title: 'Architecture evidence', canonicalUri: 'repo://context/README.md', repositoryPath: 'README.md', policy: 'tracked_content', state: 'ready', currentRevisionId: 'revision-one', refreshSeconds: 3600, createdAt: now, updatedAt: now }
    const citation = { sourceId: source.id, revisionId: 'revision-one', passageId: 'passage-one', contentHash: 'a'.repeat(64), normalizedHash: 'b'.repeat(64), passageHash: 'c'.repeat(64), headingTrail: ['Architecture'], startLine: 1, endLine: 3, startOffset: 0, endOffset: 100, locator: 'source://source-one/revisions/revision-one/passages/0#L1-L3' }
    let policy = { version: 1, requirements: gap === 'none' ? [] : [{ category: 'architecture', severity: gap }], sourcePins: [], requiredRecordIds: ['record:missing'], allowSoftOverride: true, tokenBudget: 8000, operatorInstructions: '' } as ContextPacket['policy']
    let preferences: ContextPacket['preferences'] = { version: 0, sourcePins: [], excludedSourceIds: [] }
    const packets: ContextPacket[] = []
    const reports: ContextFeedback[] = []
    const state = { previews: 0, failPreview: false, failLaunch: false, launches: [] as unknown[], preferenceSaves: [] as unknown[], policySaves: [] as unknown[], sectionReads: [] as number[], citationReads: 0, feedbackAttempts: 0, reviewAttempts: 0, feedbackInputs: [] as unknown[], reviewInputs: [] as unknown[] }
    const build = (approval?: ContextApproval): ContextPacket => {
      if (state.failPreview) throw new Error('Context index is busy. Rebuild the preview again.')
      const version = ++state.previews
      const canExecute = gap === 'none' || (gap === 'soft' && !!approval?.softOverrideReason)
      const packet: ContextPacket = { schemaVersion: 1, id: `packet-${version}`, projectId: project.id, workItemId: item.id, version, previousPacketId: packets.at(-1)?.id ?? null, taskRevision: 'task-revision-one', ownership: { status: 'backlog', activeClaimId: null }, createdAt: now, fingerprint: `fingerprint-${version}`, policy: structuredClone(policy), preferences: structuredClone(preferences), repository: { kind: 'git', rootPath: project.rootPath, head: 'commit-one', branch: 'main', workingTreeHash: 'tree-one', complete: true, limitations: [] }, sections: [{ category: 'task', title: 'Task details', state: 'included', markdown: 'Exact task context.', citations: [], required: true, locator: `context://${version}/task` }, { category: 'architecture', title: 'Architecture', state: 'included', markdown: 'Architecture brief.', citations: [citation], required: gap === 'hard', locator: `context://${version}/architecture` }], manifest: [{ sourceId: source.id, revisionId: citation.revisionId, contentHash: citation.contentHash, normalizedHash: citation.normalizedHash }], recordVersions: [], artifacts: [], gaps: gap === 'none' ? [] : [{ id: 'architecture-gap', category: 'architecture', severity: gap, reason: 'The architecture evidence needs review.', action: 'Confirm the architecture before implementation.' }], readiness: canExecute ? 'ready' : 'needs_attention', canExecute, softOverrideReason: approval?.softOverrideReason ?? null, budget: { limit: 8000, used: 3200, estimator: 'utf8_bytes_upper_bound', omissions: [{ category: 'architecture', characters: 2000, reason: 'The full evidence is retained for on-demand reading.', locator: `context://${version}/architecture` }] }, retrieval: { mode: 'lexical', corpusRevision: 'corpus-one', configFingerprint: 'config-one', fallbackReason: null }, launchMarkdown: 'Saved exact brief with architecture evidence.' }
      packets.push(packet); return structuredClone(packet)
    }
    const api = {
      system: { appVersion: async () => 'test' }, ai: { cancel: async () => true }, projects: { list: async () => [{ ...project, lastOpenedAt: now, backlogCount: 1, inProgressCount: 0, completedCount: 0 }], get: async () => project }, claims: { list: async () => [] }, attachments: { list: async () => [] },
      knowledge: { listSources: async () => [], listWiki: async () => [] }, knowledgeRecords: { list: async () => [] }, wikiAutomation: { listReports: async () => [] },
      workItems: { list: async () => [item], get: async () => item, preflight: async () => { if (preflightFails) throw new Error('The agent capability check failed.'); return { profile: 'advanced', supported: true, workspacePath: project.rootPath, capabilities: { readFiles: true, writeFiles: true, network: true, externalProcesses: true, scope: 'user' } } }, launchCopilot: async (_projectId: string, _workItemId: string, prompt: string, approval: ContextApproval) => { state.launches.push({ prompt, approval }); if (state.failLaunch) throw new Error('Project context changed. Rebuild and review the new packet.'); return { started: true, workItem: item, contextPacketId: approval.packetId } } },
      sourceCatalog: { list: async () => [source], readCitation: async () => { state.citationReads++; return { passage: { citation, title: source.title, text: 'Exact retained architecture evidence.', sourceKind: source.kind, canonicalUri: source.canonicalUri, historical: false, readiness: 'ready', structure: { kind: 'markdown', continued: false }, relevance: 1, trust: 'untrusted_reference' }, neighbors: [], truncated: false, maxCharacters: 16000 } } },
      contextPackets: {
        policy: async () => structuredClone(policy), updatePolicy: async (_projectId: string, input: ContextPolicyInput) => { state.policySaves.push(input); const { expectedVersion, ...rest } = input; policy = { ...rest, version: expectedVersion + 1 }; return structuredClone(policy) },
        preferences: async () => structuredClone(preferences), updatePreferences: async (_projectId: string, _workItemId: string, input: ContextPreferencesInput) => { if (input.expectedVersion !== preferences.version) throw new Error('Preferences changed. Reload before saving.'); state.preferenceSaves.push(input); preferences = { version: preferences.version + 1, sourcePins: input.sourcePins, excludedSourceIds: input.excludedSourceIds }; return structuredClone(preferences) },
        preview: async (_projectId: string, _workItemId: string, approval?: ContextApproval) => build(approval), list: async () => structuredClone(packets).reverse(), get: async (_projectId: string, id: string) => structuredClone(packets.find((packet) => packet.id === id)), usage: async () => [],
        readSection: async (_projectId: string, packetId: string, category: string, offset = 0) => { state.sectionReads.push(offset); return { packetId, category, text: offset ? 'The final part of retained architecture evidence.' : 'The first page of retained architecture evidence.', offset, totalCharacters: 12050, nextOffset: offset ? null : 12000, citations: [citation] } }
      },
      contextFeedback: {
        list: async (_projectId: string, filter: { packetId: string }) => structuredClone(reports.filter((entry) => entry.packetId === filter.packetId)),
        create: async (_projectId: string, input: ContextFeedbackInput) => { state.feedbackAttempts++; state.feedbackInputs.push(input); if (state.feedbackAttempts === 1) throw new Error('Feedback storage is temporarily unavailable.'); const report = { ...input, id: 'feedback-one', sourceReferences: (input.sourceIds ?? []).map((sourceId) => ({ sourceId, revisionId: 'revision-two', packetRevisionId: 'revision-one' })), status: 'proposed', action: null, target: null, triageNote: null, triagedBy: null, version: 1, createdAt: now, updatedAt: now, trust: 'untrusted_reference' } as ContextFeedback; reports.push(report); return structuredClone(report) },
        triage: async (_projectId: string, id: string, input: ContextFeedbackTriage) => { state.reviewAttempts++; state.reviewInputs.push(input); if (state.reviewAttempts === 1) throw new Error('The review could not be saved. Retry your decision.'); const report = reports.find((entry) => entry.id === id)!; Object.assign(report, { status: input.status, action: input.action, target: input.target ?? null, triageNote: input.note, triagedBy: input.actor, version: report.version + 1 }); return structuredClone(report) },
        history: async () => reports.map((report) => ({ id: 1, feedbackId: report.id, actor: 'local-user', note: report.triageNote, createdAt: now, snapshot: structuredClone(report) }))
      }
    } as unknown as DesktopApi
    Object.assign(window, { workstack: api, contextFixture: state })
  }, { gap, preflightFails })
  await page.goto('/')
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: /Start Copilot for CTX-1:/ }).click()
  await expect(page.getByRole('region', { name: 'Exact task context' })).toContainText('policy 1')
}

test('a ready packet cannot erase a capability check failure or enable launch', async ({ page }) => {
  await installContextFixture(page, 'none', true)
  await expect(page.getByRole('region', { name: 'Exact task context' })).toContainText('Execution requirements satisfied')
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The agent capability check failed.')
  await expect(page.getByRole('button', { name: 'Start Copilot', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Rebuild context preview' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The agent capability check failed.')
  await expect(page.getByRole('button', { name: 'Start Copilot', exact: true })).toBeDisabled()
})

test('hard context gaps block launch while policy remediation and exact citation reading retain the prompt @a11y', async ({ page }, testInfo) => {
  await installContextFixture(page, 'hard')
  await page.getByLabel('Initial Copilot prompt').fill('Preserve this hand-edited task prompt.')
  await expect(page.getByRole('button', { name: 'Start Copilot', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Context override reason')).toHaveCount(0)
  await page.getByRole('button', { name: 'Exact evidence · lines 1–3' }).click()
  await expect(page.getByRole('region', { name: 'Cited passage' })).toContainText('Exact retained architecture evidence.')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Initial Copilot prompt')).toHaveValue('Preserve this hand-edited task prompt.')
  await page.getByRole('button', { name: 'Project context requirements', exact: true }).click()
  await page.getByText('Edit context policy · version 1').click()
  await page.getByRole('button', { name: 'Remove missing guidance requirement' }).click()
  await page.getByLabel('Context requirement purpose', { exact: true }).selectOption('hard')
  await page.getByLabel('Required source Architecture evidence').selectOption('architecture')
  await page.getByLabel('Context operator instructions').fill('Explain the request ownership boundary.')
  await page.getByRole('button', { name: 'Save context requirements' }).click()
  await expect(page.getByRole('status')).toContainText('policy version 2')
  expect(await page.evaluate('window.contextFixture.policySaves[0]')).toMatchObject({ expectedVersion: 1, requiredRecordIds: [], sourcePins: [{ sourceId: 'source-one', category: 'architecture' }], operatorInstructions: 'Explain the request ownership boundary.' })
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('context-policy.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Initial Copilot prompt')).toHaveValue('Preserve this hand-edited task prompt.')
  await expect(page.getByRole('region', { name: 'Exact task context' })).toContainText('policy 2')
})

test('reviewable gaps require a recorded reason and stale launch failures require a fresh reviewed packet', async ({ page }, testInfo) => {
  await installContextFixture(page, 'soft')
  await page.getByLabel('Initial Copilot prompt').fill('Trace the request boundary.')
  await page.getByLabel('Context override reason').fill('The owner reviewed the migration; proceed with the known documentation gap.')
  await page.getByRole('button', { name: 'Record reason and rebuild context' }).click()
  const start = page.getByRole('button', { name: 'Start Copilot', exact: true })
  await expect(start).toBeEnabled()
  await page.evaluate('window.contextFixture.failLaunch = true')
  await start.click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Project context changed')
  await expect(page.getByLabel('Initial Copilot prompt')).toHaveValue('Trace the request boundary.')
  await expect(start).toBeDisabled()
  await page.evaluate('window.contextFixture.failLaunch = false')
  await page.getByRole('button', { name: 'Rebuild context preview' }).click()
  await page.getByRole('button', { name: 'Record reason and rebuild context' }).click()
  await expect(start).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('context-ready.png') })
  await start.click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await page.evaluate('window.contextFixture.launches')).toEqual([{ prompt: 'Trace the request boundary.', approval: { packetId: 'packet-2', softOverrideReason: 'The owner reviewed the migration; proceed with the known documentation gap.' } }, { prompt: 'Trace the request boundary.', approval: { packetId: 'packet-4', softOverrideReason: 'The owner reviewed the migration; proceed with the known documentation gap.' } }])
})

test('saved source choices survive a failed rebuild and historical packets cannot approve execution', async ({ page }) => {
  await installContextFixture(page)
  const start = page.getByRole('button', { name: 'Start Copilot', exact: true })
  await expect(start).toBeEnabled()
  await page.getByText('Pin or exclude task sources', { exact: true }).click()
  await page.getByLabel('Task context source Architecture evidence').selectOption('architecture')
  await expect(start).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Project context requirements', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Exact evidence · lines 1–3' }).click()
  await expect(page.getByRole('region', { name: 'Cited passage' })).toContainText('Exact retained architecture evidence.')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Task context source Architecture evidence')).toHaveValue('architecture')
  await expect(start).toBeDisabled()
  await page.evaluate('window.contextFixture.failPreview = true')
  await page.getByRole('button', { name: 'Save source choices and rebuild' }).click()
  await expect(page.getByRole('alert')).toContainText('Context index is busy')
  await expect(start).toBeDisabled()
  await page.getByLabel('Task context source Architecture evidence').selectOption('excluded')
  await page.getByRole('button', { name: 'Discard unsaved source choices' }).click()
  await expect(page.getByLabel('Task context source Architecture evidence')).toHaveValue('architecture')
  await expect(start).toBeDisabled()
  await page.evaluate('window.contextFixture.failPreview = false')
  await page.getByRole('button', { name: 'Rebuild context preview' }).click()
  await expect(start).toBeEnabled()
  expect(await page.evaluate('window.contextFixture.preferenceSaves')).toEqual([{ expectedVersion: 0, sourcePins: [{ sourceId: 'source-one', category: 'architecture' }], excludedSourceIds: [] }])
  await page.getByRole('button', { name: 'Read Architecture', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Full context section' })).toContainText('first page of retained')
  await page.getByRole('button', { name: 'Next context section' }).click()
  await expect(page.getByRole('region', { name: 'Full context section' })).toContainText('final part of retained')
  expect(await page.evaluate('window.contextFixture.sectionReads')).toEqual([0, 12000])
  await page.getByText('Packet history (2) and execution evidence', { exact: true }).click()
  await page.getByRole('button', { name: /Version 1 · ready/ }).click()
  await expect(page.getByRole('region', { name: 'Exact task context' })).toContainText('historical packet; rebuild')
  await expect(start).toBeDisabled()
  await page.getByRole('button', { name: 'Rebuild context preview' }).click()
  await expect(start).toBeEnabled()
})

test('context feedback keeps failed submissions and review decisions tied to exact source revisions @a11y', async ({ page }, testInfo) => {
  await installContextFixture(page)
  await page.getByText('Context feedback and follow-up (0)', { exact: true }).click()
  await page.getByLabel('Context feedback note').fill('The architecture section omits the retry owner.')
  await page.getByText('Related sources', { exact: true }).click()
  await page.getByLabel('Architecture evidence', { exact: true }).check()
  await page.getByRole('button', { name: 'Record context feedback' }).click()
  await expect(page.getByRole('alert')).toContainText('Feedback storage is temporarily unavailable')
  await expect(page.getByLabel('Context feedback note')).toHaveValue('The architecture section omits the retry owner.')
  await page.getByRole('button', { name: 'Record context feedback' }).click()
  await expect(page.getByLabel('Context feedback note')).toHaveValue('')
  await page.getByText('Source revisions at report time', { exact: true }).click()
  await expect(page.getByText('Architecture evidence: packet revision-one; reported current revision-two')).toBeVisible()
  await page.getByText('Review feedback', { exact: true }).click()
  await page.getByLabel('Feedback follow-up action').selectOption('fixture')
  await page.getByLabel('Feedback follow-up reference').fill('retry-owner-regression')
  await page.getByLabel('Feedback review note').fill('Add an evaluation case for retry ownership.')
  await page.getByRole('button', { name: 'Save feedback review' }).click()
  await expect(page.getByRole('alert')).toContainText('The review could not be saved')
  await expect(page.getByLabel('Feedback review note')).toHaveValue('Add an evaluation case for retry ownership.')
  await page.getByRole('button', { name: 'Save feedback review' }).click()
  await expect(page.getByText('missing context · triaged', { exact: true })).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('context-feedback-dark.png') })
  expect(await page.evaluate('window.contextFixture.feedbackInputs[1]')).toMatchObject({ packetId: 'packet-1', workItemId: 'task-one', sourceIds: ['source-one'], authorKind: 'human' })
  expect(await page.evaluate('window.contextFixture.reviewInputs[1]')).toMatchObject({ expectedVersion: 1, action: 'fixture', target: 'retry-owner-regression' })
})

import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { KnowledgeChatMessage, PlanningContext, PlanningMessage, PlanningProposal, ProjectMetadata, WorkClaim, WorkItem } from '../../src/core/types'

async function installFixture(page: Page, delayedProject = false): Promise<void> {
  await page.addInitScript(({ delayedProject }) => {
    const now = new Date().toISOString()
    const projects = ['Project A', 'Project B'].map((name, index) => ({ id: `project-${index}`, name, description: '', rootPath: `/tmp/project-${index}`, createdAt: now, updatedAt: now, settings: { workItemPrefix: `P${index}`, defaultLeaseSeconds: 600, heartbeatSeconds: 30, autoReleaseExpiredClaims: true, autoUpdateKnowledgeOnCompletion: false } })) as ProjectMetadata[]
    const newItem = (projectId: string, title = `${projectId} task`): WorkItem => ({ id: `${projectId}-item`, sequenceNumber: 1, displayId: 'P-1', title, type: 'feature', priority: 'normal', status: 'backlog', source: 'manual', descriptionMarkdown: 'Original description', acceptanceCriteriaMarkdown: '', createdBy: null, createdAt: now, updatedAt: now, completedAt: null })
    const state = {
      items: Object.fromEntries(projects.map((project) => [project.id, [newItem(project.id)]])),
      claims: Object.fromEntries(projects.map((project) => [project.id, [] as WorkClaim[]])),
      createCalls: 0, attachmentCalls: [] as string[], failSave: true, failAttachment: true, delayCreate: false,
      releaseProject: () => {}, releaseCreate: () => {},
      completion: { workItemId: 'project-0-item', summaryMarkdown: 'Agent finished while detail was open.', sessionSummaryMarkdown: '', implementationNotesMarkdown: '', validationMarkdown: 'Tests passed', knownLimitationsMarkdown: '', filesChanged: [], componentsChanged: [], commitSha: null, branch: null, prUrl: null, completedByAgentId: 'agent', completedBySessionId: null, createdAt: now }
    }
    let held = false
    const bridge = {
      system: { appVersion: async () => 'test' },
      ai: { cancel: async () => true },
      projects: {
        list: async () => projects.map((project) => ({ ...project, lastOpenedAt: now, backlogCount: 1, inProgressCount: 0, completedCount: 0 })),
        get: async (id: string) => { if (delayedProject && id === 'project-0' && !held) { held = true; await new Promise<void>((resolve) => { state.releaseProject = resolve }) } return projects.find((project) => project.id === id) },
        chooseFolder: async () => '/tmp/reconnected', reconnect: async () => projects[0]
      },
      workItems: {
        list: async (id: string) => structuredClone(state.items[id]),
        get: async (projectId: string, id: string) => structuredClone(state.items[projectId].find((item) => item.id === id)),
        create: async (projectId: string, input: { title: string; requestId: string }) => {
          state.createCalls++
          if (state.delayCreate) await new Promise<void>((resolve) => { state.releaseCreate = resolve })
          const item = { ...newItem(projectId, input.title), id: input.requestId }
          state.items[projectId].push(item)
          return structuredClone(item)
        },
        update: async (projectId: string, id: string, patch: Partial<WorkItem>) => {
          if (state.failSave) throw new Error('Disk temporarily unavailable; retry your changes.')
          const item = state.items[projectId].find((item) => item.id === id)!
          Object.assign(item, patch)
          return structuredClone(item)
        },
        checkpoints: async () => [], completionHistory: async () => []
      },
      claims: { list: async (projectId: string) => structuredClone(state.claims[projectId]), getCompletion: async () => state.completion },
      knowledge: { listSources: async () => [], listWiki: async () => [] },
      attachments: { list: async () => [], pasteImage: async (_projectId: string, _itemId: string, input: { originalFilename: string }) => {
        state.attachmentCalls.push(input.originalFilename)
        if (input.originalFilename === 'second.png' && state.failAttachment) { state.failAttachment = false; throw new Error('Second image upload failed.') }
        return { id: input.originalFilename }
      } },
      wikiAutomation: { listReports: async () => [] }
    } as unknown as DesktopApi
    Object.assign(window, { workstack: bridge, reliabilityFixture: state })
  }, { delayedProject })
}

async function fixtureValue<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(`window.reliabilityFixture.${expression}`) as Promise<T>
}

async function openItem(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: 'project-0 task', exact: true }).click()
}

test('cancelling planning and chat requests retains the current draft and saved conversation', async ({ page }) => {
  await installFixture(page)
  await page.addInitScript(() => {
    const bridge = (window as unknown as { workstack: DesktopApi }).workstack
    const now = new Date().toISOString()
    const pending = new Map<string, (error: Error) => void>()
    const state = { cancelled: [] as string[], requested: [] as string[], snapshots: [] as PlanningContext[] }
    let proposal: PlanningProposal = { planningSessionId: 'plan-cancel', title: '', type: 'feature', priority: 'normal', descriptionMarkdown: '', requirementsMarkdown: '', acceptanceCriteriaMarkdown: '', implementationContextMarkdown: '', relatedReferences: [], userModifiedFields: [], revision: 1, updatedAt: now }
    const messages: PlanningMessage[] = [{ id: 'earlier-plan-message', planningSessionId: proposal.planningSessionId, role: 'user', contentMarkdown: 'Earlier decision: preserve immutable context.', createdAt: now }]
    const chatSession = { id: 'chat-cancel', projectId: 'project-0', title: 'Project chat', status: 'open' as const, createdAt: now, updatedAt: now }
    const chatMessages: KnowledgeChatMessage[] = [{ id: 'earlier-chat-message', sessionId: chatSession.id, role: 'assistant', contentMarkdown: 'Earlier answer: revisions remain immutable.', toolCallId: null, metadata: {}, createdAt: now }]
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected operation in the cancellation fixture.') }
    bridge.planning = {
      listSessions: async () => [], create: async () => structuredClone(proposal), listAttachments: async () => [], listMessages: async () => structuredClone(messages),
      get: async () => structuredClone(proposal), convert: unavailable, attachBytes: unavailable, pasteImage: unavailable, removeAttachment: unavailable, previewAttachmentUrl: unavailable,
      update: async (_projectId, _sessionId, patch) => { proposal = { ...proposal, ...patch, revision: proposal.revision + 1 }; return structuredClone(proposal) },
      context: async (projectId, _sessionId, query) => {
        const project = await bridge.projects.get(projectId)
        const context = { id: `context-${state.snapshots.length + 1}`, query, assembledAt: now, project, proposal: structuredClone(proposal), messages: structuredClone(messages), knowledge: [], completedWork: [], backlogOverlap: [], planningAttachments: [], omissions: [] }
        state.snapshots.push(context); return structuredClone(context)
      },
      addMessage: async (_projectId, planningSessionId, role, contentMarkdown) => { const message = { id: crypto.randomUUID(), planningSessionId, role, contentMarkdown, createdAt: now }; messages.push(message); return message }
    }
    bridge.ai.proposePlanning = async (_projectId, _sessionId, _prompt, _contextId, requestId) => {
      state.requested.push(requestId!); return new Promise((_resolve, reject) => { pending.set(requestId!, reject) })
    }
    bridge.ai.cancel = async (requestId) => {
      state.cancelled.push(requestId)
      pending.get(requestId)?.(new Error('Request cancelled. Your saved draft and history are retained.'))
      return pending.delete(requestId)
    }
    bridge.knowledgeChat = {
      listSessions: async () => [chatSession], listMessages: async () => structuredClone(chatMessages), listToolCalls: async () => [], listPendingActions: async () => [],
      createSession: async () => chatSession, approvePendingAction: unavailable, rejectPendingAction: unavailable,
      sendMessage: async (_projectId, sessionId, contentMarkdown, requestId) => {
        chatMessages.push({ id: crypto.randomUUID(), sessionId, role: 'user', contentMarkdown, toolCallId: null, metadata: {}, createdAt: now })
        state.requested.push(requestId!); return new Promise((_resolve, reject) => { pending.set(requestId!, reject) })
      }
    }
    Object.assign(window, { cancellationFixture: state })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI', exact: true })
  await dialog.getByLabel('Proposal title').fill('Retain this draft after cancellation')
  await dialog.getByLabel('Proposal requirements').fill('Keep the manually edited requirements.')
  await dialog.getByLabel('Proposal implementation context').fill('Use the reviewed revision pointer.')
  await dialog.getByRole('button', { name: 'Request suggestion' }).click()
  await expect.poll(() => page.evaluate('window.cancellationFixture.requested.length')).toBe(1)
  await dialog.getByRole('button', { name: 'Cancel suggestion' }).click()
  await expect(dialog.getByRole('alert')).toContainText('cancelled')
  await expect(dialog.getByLabel('Proposal title')).toHaveValue('Retain this draft after cancellation')
  await expect(dialog.getByLabel('Proposal requirements')).toHaveValue('Keep the manually edited requirements.')
  await expect(dialog.getByRole('list', { name: 'Planning conversation' })).toContainText('Earlier decision: preserve immutable context.')
  await expect(dialog.getByRole('list', { name: 'Planning conversation' })).toContainText('Create a concise implementation suggestion')
  await expect(dialog.getByRole('button', { name: 'Request suggestion' })).toBeEnabled()
  expect(await page.evaluate('window.cancellationFixture.snapshots[0].proposal')).toMatchObject({ requirementsMarkdown: 'Keep the manually edited requirements.', implementationContextMarkdown: 'Use the reviewed revision pointer.' })
  await dialog.getByRole('button', { name: 'Save and close' }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByLabel('Message project AI chat').fill('Keep my cancelled follow-up question.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate('window.cancellationFixture.requested.length')).toBe(2)
  await page.getByRole('button', { name: 'Cancel request', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cancelled')
  await expect(page.getByLabel('Message project AI chat')).toHaveValue('Keep my cancelled follow-up question.')
  await expect(page.getByText('Earlier answer: revisions remain immutable.', { exact: true })).toBeVisible()
  await expect(page.getByText('Keep my cancelled follow-up question.', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(await page.evaluate('window.cancellationFixture.cancelled')).toEqual(await page.evaluate('window.cancellationFixture.requested'))
})

test('task dependency edits retain a failed draft and reveal blocking prerequisites after retry', async ({ page }) => {
  await installFixture(page)
  await page.addInitScript(() => {
    const bridge = (window as unknown as { workstack: DesktopApi }).workstack
    const fixture = (window as unknown as { reliabilityFixture: { items: Record<string, WorkItem[]> } }).reliabilityFixture
    const prerequisite = { ...fixture.items['project-0'][0], id: 'prerequisite-task', displayId: 'P-2', title: 'Prerequisite contract' }
    fixture.items['project-0'].push(prerequisite)
    const coordination = { workItemId: 'project-0-item', readiness: { ready: true, blockers: [] as unknown[] }, prerequisites: [] as unknown[], related: [], declaredPaths: [] as string[], declaredComponents: [] as string[], activeOverlaps: [] }
    let fail = true
    bridge.taskDependencies = {
      get: async () => structuredClone(coordination),
      update: async (_projectId: string, _id: string, input: { declaredPaths: string[] }) => {
        if (fail) { fail = false; throw new Error('Dependency storage temporarily unavailable.') }
        Object.assign(coordination, { declaredPaths: input.declaredPaths, readiness: { ready: false, blockers: [{ workItemId: prerequisite.id, displayId: prerequisite.displayId, reason: 'Prerequisite is still in the backlog.' }] }, prerequisites: [{ workItemId: prerequisite.id, displayId: prerequisite.displayId, title: prerequisite.title, status: 'backlog', satisfied: false, reason: 'Prerequisite is still in the backlog.', outcome: null }] })
        return structuredClone(coordination)
      }
    } as unknown as DesktopApi['taskDependencies']
  })
  await page.goto('/'); await openItem(page)
  const panel = page.getByRole('region', { name: 'Dependencies and overlapping work' })
  await expect(panel.getByText('Prerequisites ready')).toBeVisible()
  await panel.getByRole('button', { name: 'Edit task dependencies' }).click()
  await panel.getByLabel('Prerequisite task IDs').fill('P-2')
  await panel.getByLabel('Declared paths').fill('src/claims.ts')
  await panel.getByRole('button', { name: 'Save task dependencies' }).click()
  await expect(panel.getByRole('alert')).toContainText('temporarily unavailable')
  await expect(panel.getByLabel('Declared paths')).toHaveValue('src/claims.ts')
  await panel.getByRole('button', { name: 'Save task dependencies' }).click()
  await expect(panel.getByText('Blocked by prerequisites')).toBeVisible()
  await panel.getByRole('button', { name: 'P-2: Prerequisite contract' }).click()
  await expect(page.getByRole('heading', { name: 'Prerequisite contract', exact: true })).toBeVisible()
})

test('failed completion delivery shows its cause and retries only that update', async ({ page }) => {
  await installFixture(page)
  await page.addInitScript(() => {
    const now = new Date().toISOString()
    const events = [1, 2].map((id) => ({ id, eventKey: `merge-${id}`, workItemId: 'project-0-item', prUrl: `https://github.com/example/project/pull/${id}`, status: 'failed', attempts: 5, errorMessage: `Delivery ${id} could not read merge evidence`, nextAttemptAt: null, owner: null, leaseExpiresAt: null, createdAt: now, updatedAt: now }))
    const retried: number[] = []
    const bridge = (window as unknown as { workstack: DesktopApi }).workstack
    bridge.knowledgeDelivery = {
      list: async () => structuredClone(events),
      retry: async (_projectId, id) => {
        retried.push(id)
        const event = events.find((candidate) => candidate.id === id)!
        Object.assign(event, { status: 'pending', attempts: 0 })
        return structuredClone(event)
      }
    } as DesktopApi['knowledgeDelivery']
    Object.assign(window, { deliveryRetries: retried })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Completion knowledge delivery' })
  await expect(panel.getByText('Delivery 1 could not read merge evidence')).toBeVisible()
  await expect(panel.getByText('Automatic retries stopped. Correct the cause, then retry this delivery.')).toHaveCount(2)
  await panel.getByRole('button', { name: 'Retry delivery' }).first().click()
  await expect(panel.getByText('pending · 0 attempts')).toBeVisible()
  expect(await page.evaluate('window.deliveryRetries')).toEqual([1])
  await expect(panel.getByRole('button', { name: 'Retry delivery' })).toHaveCount(1)
})

test('late project A responses cannot replace loaded project B records', async ({ page }) => {
  await installFixture(page, true)
  await page.goto('/')
  await page.getByRole('button', { name: 'Project B', exact: true }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await expect(page.getByRole('button', { name: 'project-1 task', exact: true })).toBeVisible()
  await fixtureValue(page, 'releaseProject()')
  await expect(page.getByRole('button', { name: 'project-0 task', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'project-1 task', exact: true })).toBeVisible()
})

test('failed edits remain open and live completion refresh preserves a dirty draft', async ({ page }) => {
  await installFixture(page)
  await page.goto('/')
  await openItem(page)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Work item title').fill('My unsaved title')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert')).toContainText('Disk temporarily unavailable')
  await expect(page.getByLabel('Work item title')).toHaveValue('My unsaved title')
  await fixtureValue(page, `items['project-0'][0] = { ...window.reliabilityFixture.items['project-0'][0], status: 'completed', title: 'Agent updated title', updatedAt: new Date().toISOString() }`)
  await expect(page.getByLabel('Work item details').getByText('Completed', { exact: true })).toBeVisible({ timeout: 8_000 })
  await expect(page.getByLabel('Work item title')).toHaveValue('My unsaved title')
  await page.getByRole('button', { name: 'Cancel edit' }).click()
  await expect(page.getByRole('heading', { name: 'Agent updated title' })).toBeVisible()
  await expect(page.getByText('Agent finished while detail was open.')).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await fixtureValue(page, 'failSave = false')
  await page.getByLabel('Work item title').fill('Saved after retry')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'Saved after retry' })).toBeVisible()
})

test('a new agent claim refreshes open task details without overwriting a dirty draft', async ({ page }) => {
  await installFixture(page)
  await page.goto('/')
  await openItem(page)
  const details = page.getByLabel('Work item details')
  await expect(details.getByText('Backlog', { exact: true })).toBeVisible()
  await expect(details.getByText('Copilot', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Work item title').fill('Keep my local draft during the claim')
  await page.getByLabel('Work item description').fill('Unsaved implementation notes')
  await page.evaluate(() => {
    const fixture = (window as unknown as { reliabilityFixture: { items: Record<string, WorkItem[]>; claims: Record<string, WorkClaim[]> } }).reliabilityFixture
    const now = new Date().toISOString()
    fixture.items['project-0'][0] = { ...fixture.items['project-0'][0], status: 'in_progress', updatedAt: now }
    fixture.claims['project-0'] = [{
      id: 'arriving-claim', workItemId: 'project-0-item', agentId: 'copilot', agentDisplayName: 'Copilot', sessionId: 'arriving-session',
      claimedAt: now, lastHeartbeatAt: now, leaseExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      state: 'active', releaseReason: null, blockedReason: null, releasedAt: null, completedAt: null
    }]
  })
  await expect(details.getByText('In Progress', { exact: true })).toBeVisible({ timeout: 8_000 })
  await expect(details.getByText('Copilot', { exact: true })).toBeVisible()
  await expect(details.getByText('arriving-session', { exact: true })).toBeVisible()
  await expect(details.getByText('Healthy', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Work item title')).toHaveValue('Keep my local draft during the claim')
  await expect(page.getByLabel('Work item description')).toHaveValue('Unsaved implementation notes')
  await page.getByRole('button', { name: 'Cancel edit' }).click()
  await expect(page.getByRole('heading', { name: 'project-0 task', exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Active claim for Copilot' })).toBeVisible()
  await expect(page.getByText('Copilot · Session arriving-session', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Force release' })).toBeVisible()
  await expect(page.getByLabel('Recovery reason')).toHaveCount(0)
})

test('repeated submission is locked and an attachment retry resumes the saved item', async ({ page }) => {
  await installFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Backlog', exact: true }).click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Work Item' })
  await dialog.getByLabel('Work item title').fill('One durable task')
  await dialog.getByLabel('Paste screenshots here').evaluate((element) => {
    for (const name of ['first.png', 'second.png']) {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File(['image'], name, { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
    }
  })
  await fixtureValue(page, 'delayCreate = true')
  await dialog.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect(dialog.getByRole('button', { name: 'Saving work item...' })).toBeDisabled()
  expect(await fixtureValue(page, 'createCalls')).toBe(1)
  await fixtureValue(page, 'releaseCreate()')
  await expect(dialog.getByRole('alert')).toContainText('Second image upload failed')
  await expect(dialog.locator('li').filter({ hasText: 'first.png' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Retry and continue' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await fixtureValue(page, 'createCalls')).toBe(1)
  expect(await fixtureValue(page, 'attachmentCalls')).toEqual(['first.png', 'second.png', 'second.png'])
  await expect(page.getByRole('button', { name: 'One durable task', exact: true })).toHaveCount(1)
})

test('manual and generated wiki articles open in a complete keyboard-accessible reader', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByLabel('Project name').fill('Wiki reader')
  await page.getByLabel('Project folder').fill('/tmp/wiki-reader')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('workstack-browser-state')!)
    state.wikiByProject[state.projects[0].id] = [
      { slug: 'generated-architecture', content: '# Full architecture\n\n- Durable data\n- Scoped context\n\n```ts\nconst safe = true\n```\n\n[Reference](https://example.test/docs)\n\n' + 'Long article paragraph.\n\n'.repeat(60) + 'Final evidence appears here.' },
      { slug: 'manual-guide', content: '# Human guide\n\nEditable instructions.' }
    ]
    localStorage.setItem('workstack-browser-state', JSON.stringify(state))
  })
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
  const article = page.getByRole('button', { name: 'generated-architecture', exact: true })
  await article.focus()
  await page.keyboard.press('Enter')
  const reader = page.getByRole('dialog', { name: 'generated-architecture' })
  await expect(reader.getByRole('heading', { name: 'Full architecture' })).toBeVisible()
  await expect(reader.locator('li').first()).toHaveText('Durable data')
  await expect(reader.locator('pre code')).toHaveText('const safe = true')
  await expect(reader.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.test/docs')
  await expect(reader.getByText('Final evidence appears here.')).toBeAttached()
  await expect(reader.getByRole('button', { name: 'Edit article' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('generated-wiki-reader.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('generated-wiki-reader-dark.png') })
  await page.keyboard.press('Escape')
  await expect(article).toBeFocused()
  await page.getByLabel('Search knowledge').fill('Final evidence')
  await page.getByRole('button', { name: /Wiki: Full architecture/ }).click()
  await expect(reader).toBeVisible()
  await reader.getByRole('button', { name: 'Back to knowledge' }).click()
  await expect(page.getByLabel('Search knowledge')).toHaveValue('Final evidence')
  await page.getByLabel('Search knowledge').fill('')
  await page.getByRole('button', { name: 'manual-guide', exact: true }).click()
  await page.getByRole('button', { name: 'Edit article' }).click()
  await expect(page.getByLabel('Article content')).toHaveValue('# Human guide\n\nEditable instructions.')
})

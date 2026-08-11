import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore, projectPaths } from '../../src/core/project-store'
import { WorkItemRepository, renderWorkItemMirror } from '../../src/core/work-items'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRepository(): Promise<{
  repository: WorkItemRepository
  store: ProjectStore
  clock: FrozenClock
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-items-'))
  cleanupPaths.push(rootPath)
  const clock = new FrozenClock(new Date('2026-08-11T00:00:00.000Z'))
  const ids = [
    '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
    'd870873c-eaeb-48c1-8f07-8c3dba48d6cc',
    'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f',
    'cf2e9d1f-457a-4d5f-8600-52e8c9523d62',
    'f334215d-dfbf-477a-83e3-431560c5b4d5',
    '0a9e2f42-b9c4-44e1-bb71-31d1ac438fe2'
  ]
  const nextId = (): string => {
    const id = ids.shift()
    if (!id) {
      throw new Error('Test ID sequence exhausted.')
    }
    return id
  }
  const store = await ProjectStore.initialize(
    { rootPath, name: 'Workstack', workItemPrefix: 'WS' },
    { clock, id: nextId }
  )
  return {
    repository: new WorkItemRepository(store, { clock, id: nextId }),
    store,
    clock
  }
}

describe('WorkItemRepository', () => {
  it('creates a stable backlog item, searchable record, mirror, and history event', async () => {
    const { repository, store } = await createRepository()
    const workItem = repository.create({
      title: 'Support pasted screenshots',
      descriptionMarkdown: 'Paste images into the editor.',
      acceptanceCriteriaMarkdown: '- [ ] Images persist',
      priority: 'high',
      createdBy: 'andrew'
    })

    expect(workItem).toMatchObject({
      displayId: 'WS-1',
      type: 'feature',
      status: 'backlog',
      source: 'manual',
      priority: 'high'
    })
    expect(repository.get(workItem.id)).toEqual(workItem)
    expect(
      store.database.prepare('SELECT title FROM work_item_search WHERE work_item_id = ?').get(workItem.id)
    ).toEqual({ title: 'Support pasted screenshots' })
    expect(repository.listActivity(workItem.id)).toMatchObject([
      { eventType: 'work_item_created', payload: { displayId: 'WS-1' } }
    ])
    await expect(readFile(path.join(projectPaths(store.paths.rootPath).workItemsPath, workItem.id, 'work-item.md'), 'utf8')).resolves.toContain(
      '# Support pasted screenshots'
    )
    store.close()
  })

  it('allocates display IDs in one sequence and supports filtered search', async () => {
    const { repository, store, clock } = await createRepository()
    const first = repository.create({ type: 'bug', title: 'Fix claim race', priority: 'high', source: 'mcp' })
    clock.advance(1_000)
    const second = repository.create({ type: 'chore', title: 'Update fixtures', priority: 'low', source: 'ai_plan' })

    expect([first.displayId, second.displayId]).toEqual(['WS-1', 'WS-2'])
    expect(repository.list({ type: 'bug', priority: 'high', source: 'mcp', query: 'claim', limit: 1 })).toEqual([
      first
    ])
    expect(repository.list({ status: 'backlog' })).toEqual([second, first])
    expect(repository.list()).toEqual([second, first])
    expect(repository.list({ query: 'missing' })).toEqual([])
    store.close()
  })

  it('updates editable work fields while retaining both identities and mirrors', async () => {
    const { repository, store, clock } = await createRepository()
    const original = repository.create({ title: 'Initial title' })
    clock.advance(1_000)

    const updated = repository.update(original.id, {
      type: 'bug',
      title: ' Updated title ',
      descriptionMarkdown: 'Updated description',
      acceptanceCriteriaMarkdown: 'Updated criteria',
      priority: 'low'
    })

    expect(updated).toMatchObject({
      id: original.id,
      displayId: original.displayId,
      type: 'bug',
      title: 'Updated title',
      descriptionMarkdown: 'Updated description',
      acceptanceCriteriaMarkdown: 'Updated criteria',
      priority: 'low',
      updatedAt: '2026-08-11T00:00:01.000Z'
    })
    expect(repository.listActivity(original.id).map((event) => event.eventType)).toEqual([
      'work_item_updated',
      'work_item_created'
    ])
    await expect(readFile(path.join(store.paths.workItemsPath, original.id, 'work-item.md'), 'utf8')).resolves.toContain(
      'Updated criteria'
    )
    clock.advance(1_000)
    expect(repository.update(original.id, { priority: 'high' })).toMatchObject({
      type: 'bug',
      title: 'Updated title',
      descriptionMarkdown: 'Updated description',
      acceptanceCriteriaMarkdown: 'Updated criteria',
      priority: 'high',
      updatedAt: '2026-08-11T00:00:02.000Z'
    })
    clock.advance(1_000)
    expect(repository.update(original.id, { descriptionMarkdown: 'Final description' })).toMatchObject({
      descriptionMarkdown: 'Final description',
      priority: 'high',
      updatedAt: '2026-08-11T00:00:03.000Z'
    })
    store.close()
  })

  it('deletes only backlog work and cleans its exported directory', async () => {
    const { repository, store } = await createRepository()
    const workItem = repository.create({ title: 'Remove me' })

    repository.delete(workItem.id)

    expectErrorCode(() => repository.get(workItem.id), 'WORK_ITEM_NOT_FOUND')
    await expect(stat(path.join(store.paths.workItemsPath, workItem.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(repository.listActivity().map((event) => event.eventType)).toContain('work_item_deleted')
    store.close()
  })

  it('rejects invalid data, missing items, and deletion outside the backlog', async () => {
    const { repository, store } = await createRepository()

    expect(() => repository.create({ title: ' ' })).toThrow()
    expectErrorCode(() => repository.get('missing'), 'WORK_ITEM_NOT_FOUND')
    expectErrorCode(() => repository.update('missing', { title: 'Missing' }), 'WORK_ITEM_NOT_FOUND')
    const workItem = repository.create({ title: 'Claimed work' })
    store.database.prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ?").run(workItem.id)
    expectErrorCode(() => repository.delete(workItem.id), 'INVALID_STATE_TRANSITION')
    expectErrorCode(() => repository.update(workItem.id, { title: '   ' }), 'VALIDATION_ERROR')
    store.close()
  })

  it('renders a human-readable Markdown mirror', () => {
    expect(
      renderWorkItemMirror({
        id: '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
        sequenceNumber: 1,
        displayId: 'WS-1',
        type: 'feature',
        title: 'A work item',
        descriptionMarkdown: 'Description',
        acceptanceCriteriaMarkdown: 'Criteria',
        priority: 'normal',
        status: 'backlog',
        source: 'manual',
        createdBy: null,
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        completedAt: null
      })
    ).toContain('display_id: WS-1')
  })

  it('uses system dependencies when no deterministic test dependencies are supplied', async () => {
    const { store } = await createRepository()
    const repository = new WorkItemRepository(store)

    expect(repository.create({ title: 'Production dependencies' }).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    store.close()
  })
})

function expectErrorCode(action: () => unknown, code: string): void {
  let received: unknown

  try {
    action()
  } catch (error) {
    received = error
  }

  expect(received).toMatchObject({ code })
}

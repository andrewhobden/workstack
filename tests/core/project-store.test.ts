import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore, projectPaths } from '../../src/core/project-store'
import { atomicWriteText } from '../../src/core/project-lifecycle'
import { DEFAULT_COPILOT_LAUNCH_PROMPT, LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT } from '../../src/core/types'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-project-'))
  cleanupPaths.push(root)
  return root
}

describe('ProjectStore', () => {
  it('repairs an export interruption from authoritative SQLite without losing identity or settings', async () => {
    const rootPath = await temporaryProjectRoot()
    let failExport = false
    const store = await ProjectStore.initialize({ rootPath, name: 'Original' }, {
      writeMetadata: (filePath, content) => {
        if (failExport) throw new Error('simulated export interruption')
        atomicWriteText(filePath, content)
      }
    })
    const id = store.project.id
    failExport = true
    await expect(store.updateMetadata({ name: 'Committed', settings: { heartbeatSeconds: 90 } })).rejects.toThrow('committed in SQLite')
    expect(JSON.parse(await readFile(store.paths.projectPath, 'utf8')).name).toBe('Original')
    store.close()

    const reopened = await ProjectStore.open(rootPath)
    try {
      expect(reopened.project).toMatchObject({ id, name: 'Committed', settings: { heartbeatSeconds: 90 } })
      expect(JSON.parse(await readFile(reopened.paths.projectPath, 'utf8'))).toMatchObject({ id, name: 'Committed', heartbeatSeconds: 90 })
    } finally { reopened.close() }
  })

  it('merges independent patches from stale handles and rejects unsafe heartbeat settings', async () => {
    const rootPath = await temporaryProjectRoot()
    const first = await ProjectStore.initialize({ rootPath, name: 'Original' })
    const second = await ProjectStore.open(rootPath)
    try {
      await Promise.all([first.updateMetadata({ name: 'Renamed' }), second.updateMetadata({ description: 'Added description' })])
      expect(first.project).toMatchObject({ name: 'Renamed', description: 'Added description' })
      expect(second.project).toEqual(first.project)
      await expect(first.updateMetadata({ settings: { defaultLeaseSeconds: 300, heartbeatSeconds: 300 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      await expect(first.updateMetadata({ settings: { defaultLeaseSeconds: 120, heartbeatSeconds: 300 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    } finally { first.close(); second.close() }
  })
  it('initializes a durable local project layout and schema', async () => {
    const rootPath = await temporaryProjectRoot()
    const store = await ProjectStore.initialize(
      { rootPath, name: 'Workstack', description: 'Coordination' },
      {
        clock: new FrozenClock(new Date('2026-08-11T00:00:00.000Z')),
        id: () => '5f03c679-76e8-4ea8-a8bc-9ec31f367a76'
      }
    )

    expect(store.project).toMatchObject({
      id: '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
      name: 'Workstack',
      description: 'Coordination',
      settings: {
        workItemPrefix: 'WORKST',
        copilotLaunchPrompt: DEFAULT_COPILOT_LAUNCH_PROMPT
      }
    })
    expect(store.database.prepare('SELECT version FROM schema_migrations').all()).toEqual(expect.arrayContaining([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 20 },
      { version: 21 },
      { version: 30 }
    ]))
    expect(JSON.parse(await readFile(projectPaths(rootPath).projectPath, 'utf8'))).toMatchObject({
      name: 'Workstack',
      workItemPrefix: 'WORKST',
      defaultLeaseSeconds: 1800
    })
    store.close()
  })

  it('reopens an existing project without recreating its identity', async () => {
    const rootPath = await temporaryProjectRoot()
    const created = await ProjectStore.initialize(
      { rootPath, name: 'Workstack' },
      { id: () => '5f03c679-76e8-4ea8-a8bc-9ec31f367a76' }
    )
    created.close()

    const reopened = await ProjectStore.initialize({ rootPath, name: 'Renamed' })

    expect(reopened.project.id).toBe('5f03c679-76e8-4ea8-a8bc-9ec31f367a76')
    expect(reopened.project.name).toBe('Workstack')
    reopened.close()
  })

  it('upgrades the legacy Copilot prompt default when reopening a project', async () => {
    const rootPath = await temporaryProjectRoot()
    const created = await ProjectStore.initialize({ rootPath, name: 'Workstack' })
    created.close()
    const paths = projectPaths(rootPath)
    const metadata = JSON.parse(await readFile(paths.projectPath, 'utf8')) as Record<string, unknown>
    await writeFile(paths.projectPath, `${JSON.stringify({ ...metadata, copilotLaunchPrompt: LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT }, null, 2)}\n`)

    const reopened = await ProjectStore.open(rootPath)

    expect(reopened.project.settings.copilotLaunchPrompt).toBe(DEFAULT_COPILOT_LAUNCH_PROMPT)
    reopened.close()
  })

  it('supports deterministic metadata, custom prefixes, and checksum generation', async () => {
    const rootPath = await temporaryProjectRoot()
    const store = await ProjectStore.initialize(
      { rootPath, name: '###', workItemPrefix: 'WS2' },
      {
        clock: new FrozenClock(new Date('2026-08-11T00:00:00.000Z')),
        id: () => '5f03c679-76e8-4ea8-a8bc-9ec31f367a76'
      }
    )

    expect(store.project).toMatchObject({
      description: '',
      settings: { workItemPrefix: 'WS2' }
    })
    expect(store.checksum('workstack')).toBe('13d5bfc472e5d315fb3e5d18261a0ea70ade05e47f1d2176cc23752654ff0c39')
    store.close()

    const fallbackRootPath = await temporaryProjectRoot()
    const fallback = await ProjectStore.initialize({ rootPath: fallbackRootPath, name: '###' })
    expect(fallback.project.settings.workItemPrefix).toBe('WS')
    fallback.close()
  })

  it('updates project metadata in SQLite and the public project document', async () => {
    const rootPath = await temporaryProjectRoot()
    const store = await ProjectStore.initialize(
      { rootPath, name: 'Workstack', description: 'Original' },
      { id: () => '5f03c679-76e8-4ea8-a8bc-9ec31f367a76', clock: new FrozenClock(new Date('2026-08-11T00:00:00.000Z')) }
    )
    const clock = new FrozenClock(new Date('2026-08-11T01:00:00.000Z'))

    await expect(store.updateMetadata({
      name: ' Updated Workstack ',
      description: ' Updated description ',
      settings: {
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false,
        agentExecutionProfile: 'inspection',
        knowledgeChatProfile: 'inspection',
        copilotLaunchPrompt: 'Claim this work item first.'
      }
    }, clock)).resolves.toMatchObject({
      name: 'Updated Workstack',
      description: 'Updated description',
      settings: {
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false,
        copilotLaunchPrompt: 'Claim this work item first.'
      },
      updatedAt: '2026-08-11T01:00:00.000Z'
    })
    await expect(store.updateMetadata({}, clock)).resolves.toMatchObject({
      name: 'Updated Workstack',
      description: 'Updated description'
    })
    await expect(store.updateMetadata({ name: ' ' }, clock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    await expect(store.updateMetadata({ settings: { heartbeatSeconds: 10 } }, clock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    expect(store.database.prepare('SELECT name, description, settings_json FROM projects').get()).toEqual({
      name: 'Updated Workstack',
      description: 'Updated description',
      settings_json: JSON.stringify({
        workItemPrefix: 'WORKST',
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false,
        agentExecutionProfile: 'inspection',
        knowledgeChatProfile: 'inspection',
        copilotLaunchPrompt: 'Claim this work item first.'
      })
    })
    store.close()

    const reopened = await ProjectStore.open(rootPath)
    expect(reopened.project).toMatchObject({
      name: 'Updated Workstack',
      description: 'Updated description',
      settings: {
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false,
        copilotLaunchPrompt: 'Claim this work item first.'
      }
    })
    reopened.close()
  })

  it('rejects an empty project name before persisting a project record', async () => {
    const rootPath = await temporaryProjectRoot()

    await expect(ProjectStore.initialize({ rootPath, name: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    await expect(ProjectStore.initialize({ rootPath, name: 'Workstack', workItemPrefix: 'lowercase' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
  })

  it('reports a missing or invalid project safely', async () => {
    const rootPath = await temporaryProjectRoot()

    await expect(ProjectStore.open(rootPath)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND'
    })
    await expect(ProjectStore.open('\0')).rejects.toBeInstanceOf(TypeError)

    const created = await ProjectStore.initialize({ rootPath, name: 'Workstack' })
    created.close()
    await writeFile(projectPaths(rootPath).projectPath, '{"id":"not-a-uuid"}\n')

    await expect(ProjectStore.open(rootPath)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
  })

  it('detects inconsistent project metadata and database state', async () => {
    const rootPath = await temporaryProjectRoot()
    const created = await ProjectStore.initialize({ rootPath, name: 'Workstack' })
    created.database.prepare('DELETE FROM projects').run()
    created.close()

    await expect(ProjectStore.open(rootPath)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND'
    })
  })

  it('repairs interrupted initialization when creating an existing project again', async () => {
    const rootPath = await temporaryProjectRoot()
    const created = await ProjectStore.initialize({ rootPath, name: 'Workstack' })
    const projectId = created.project.id
    created.database.prepare('DELETE FROM projects').run()
    created.close()

    const recovered = await ProjectStore.initialize({ rootPath, name: 'Workstack' })

    expect(recovered.project.id).toBe(projectId)
    expect(recovered.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toMatchObject({ id: projectId })
    recovered.close()
  })
})

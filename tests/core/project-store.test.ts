import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore, projectPaths } from '../../src/core/project-store'

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
        workItemPrefix: 'WORKST'
      }
    })
    expect(store.database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 }
    ])
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
      { id: () => '5f03c679-76e8-4ea8-a8bc-9ec31f367a76' }
    )
    const clock = new FrozenClock(new Date('2026-08-11T01:00:00.000Z'))

    await expect(store.updateMetadata({
      name: ' Updated Workstack ',
      description: ' Updated description ',
      settings: {
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false
      }
    }, clock)).resolves.toMatchObject({
      name: 'Updated Workstack',
      description: 'Updated description',
      settings: {
        defaultLeaseSeconds: 900,
        heartbeatSeconds: 120,
        autoReleaseExpiredClaims: false,
        autoUpdateKnowledgeOnCompletion: false
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
        autoUpdateKnowledgeOnCompletion: false
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
        autoUpdateKnowledgeOnCompletion: false
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
})

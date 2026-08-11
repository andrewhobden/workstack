import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectRegistry } from '../../src/core/project-registry'
import type { ProjectMetadata } from '../../src/core/types'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRegistry(): Promise<{ registry: ProjectRegistry; filePath: string; clock: FrozenClock }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-registry-'))
  cleanupPaths.push(directory)
  const clock = new FrozenClock(new Date('2026-08-11T00:00:00.000Z'))
  return {
    registry: new ProjectRegistry(path.join(directory, 'projects.json'), clock),
    filePath: path.join(directory, 'projects.json'),
    clock
  }
}

function project(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
    name: 'Workstack',
    description: 'Coordination',
    rootPath: '/tmp/workstack',
    settings: {
      workItemPrefix: 'WS',
      defaultLeaseSeconds: 1800,
      heartbeatSeconds: 300,
      autoReleaseExpiredClaims: true,
      autoUpdateKnowledgeOnCompletion: true
    },
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides
  }
}

describe('ProjectRegistry', () => {
  it('starts empty, registers projects, and sorts them by the last-opened time', async () => {
    const { registry, clock } = await createRegistry()
    expect(await registry.list()).toEqual([])

    await registry.register(project())
    clock.advance(1_000)
    await registry.register(
      project({
        id: 'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f',
        name: 'Nanotables',
        rootPath: '/tmp/nanotables'
      })
    )

    expect((await registry.list()).map((record) => record.name)).toEqual(['Nanotables', 'Workstack'])
    expect((await registry.find('5f03c679-76e8-4ea8-a8bc-9ec31f367a76'))?.rootPath).toBe('/tmp/workstack')
    expect(await registry.find('missing')).toBeUndefined()
  })

  it('refreshes an existing registration without changing its identity', async () => {
    const { registry, clock } = await createRegistry()
    await registry.register(project())
    clock.advance(1_000)

    const refreshed = await registry.register(project({ description: 'Updated coordination' }))

    expect(refreshed).toMatchObject({
      id: '5f03c679-76e8-4ea8-a8bc-9ec31f367a76',
      description: 'Updated coordination',
      lastOpenedAt: '2026-08-11T00:00:01.000Z'
    })
  })

  it('protects one project folder from duplicate registrations', async () => {
    const { registry } = await createRegistry()
    await registry.register(project())

    await expect(
      registry.register(
        project({
          id: 'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f'
        })
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('edits registered presentation metadata and validates names', async () => {
    const { registry, clock } = await createRegistry()
    await registry.register(project())
    clock.advance(1_000)

    await expect(
      registry.update('5f03c679-76e8-4ea8-a8bc-9ec31f367a76', {
        name: '  Updated Workstack  ',
        description: '  Better coordination  '
      })
    ).resolves.toMatchObject({
      name: 'Updated Workstack',
      description: 'Better coordination',
      lastOpenedAt: '2026-08-11T00:00:01.000Z'
    })
    await expect(
      registry.update('5f03c679-76e8-4ea8-a8bc-9ec31f367a76', { name: ' ', description: '' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(registry.update('missing', { name: 'Missing', description: '' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND'
    })
  })

  it('detaches without touching the project and reports absent records', async () => {
    const { registry } = await createRegistry()
    await registry.register(project())

    await expect(registry.detach('missing')).resolves.toBe(false)
    await expect(registry.detach('5f03c679-76e8-4ea8-a8bc-9ec31f367a76')).resolves.toBe(true)
    await expect(registry.list()).resolves.toEqual([])
  })

  it('fails clearly when the registry document is corrupt', async () => {
    const { registry, filePath } = await createRegistry()
    await writeFile(filePath, '{"version":2,"projects":[]}\n')

    await expect(registry.list()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('propagates unexpected filesystem errors instead of treating them as empty state', async () => {
    const registry = new ProjectRegistry('\0')

    await expect(registry.list()).rejects.toBeInstanceOf(TypeError)
  })
})

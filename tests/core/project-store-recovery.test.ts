import * as filesystem from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore, projectPaths } from '../../src/core/project-store'
import { projectLifecyclePath } from '../../src/core/project-lifecycle'
import { DEFAULT_COPILOT_LAUNCH_PROMPT, LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT } from '../../src/core/types'

vi.mock('node:fs/promises', async (load) => ({ ...await load<typeof import('node:fs/promises')>() }))

const roots: string[] = []
const stores: ProjectStore[] = []
afterEach(async () => { vi.restoreAllMocks(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => filesystem.rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await filesystem.mkdtemp(path.join(os.tmpdir(), 'workstack-store-recovery-')); roots.push(root); return root }
async function fixture() { const root = await directory(); const store = await ProjectStore.initialize({ rootPath: root, name: 'Recovery' }); stores.push(store); return { root, store } }

describe('project-store integrity and interrupted initialization', () => {
  it('reopens a SQLite identity after its initial projection failed and leaves no admitted operation behind', async () => {
    const root = await directory()
    await expect(ProjectStore.initialize({ rootPath: root, name: 'Committed identity' }, { writeMetadata: () => { throw new Error('disk full') } })).rejects.toThrow('committed in SQLite')
    const coordination = new Database(projectLifecyclePath(root))
    expect(coordination.prepare('SELECT * FROM operations').all()).toEqual([])
    coordination.close()
    const recovered = await ProjectStore.open(root); stores.push(recovered)
    expect(recovered.project.name).toBe('Committed identity')
    expect(await ProjectStore.readMetadataDocument(root)).toEqual(recovered.project)
  })

  it('refuses to invent a missing database identity and recovers only from the preserved metadata document', async () => {
    const { root, store } = await fixture()
    const document = await filesystem.readFile(store.paths.projectPath, 'utf8')
    const id = store.project.id
    store.database.prepare('DELETE FROM projects').run()
    store.close()
    await expect(ProjectStore.openReadOnly(root)).rejects.toThrow('inconsistent')
    await filesystem.rm(projectPaths(root).projectPath)
    await expect(ProjectStore.initialize({ rootPath: root, name: 'Must not replace identity' })).rejects.toThrow('Restore a backup')
    await filesystem.writeFile(projectPaths(root).projectPath, document)
    const recovered = await ProjectStore.initialize({ rootPath: root, name: 'Ignored replacement' }); stores.push(recovered)
    expect(recovered.project.id).toBe(id)
    const reader = await ProjectStore.openReadOnly(root); stores.push(reader)
    expect(reader.runInOperation(() => reader.project.id)).toBe(id)
    reader.close(); reader.close()
  })

  it('rejects conflicting document identities and multiple database identities without rewriting either', async () => {
    const { root, store } = await fixture()
    const original = store.project
    const document = JSON.parse(await filesystem.readFile(store.paths.projectPath, 'utf8'))
    await filesystem.writeFile(store.paths.projectPath, JSON.stringify({ ...document, id: randomUUID() }))
    await expect(ProjectStore.open(root)).rejects.toThrow('identities are inconsistent')
    await expect(ProjectStore.openReadOnly(root)).rejects.toThrow('identities are inconsistent')
    await expect(ProjectStore.initialize({ rootPath: root, name: 'Ignore conflict' })).rejects.toThrow('identities are inconsistent')
    expect(store.project.id).toBe(original.id)
    await filesystem.writeFile(store.paths.projectPath, JSON.stringify(document))
    store.database.prepare('INSERT INTO projects SELECT ?,name,description,?,settings_json,created_at,updated_at FROM projects').run(randomUUID(), `${root}-other`)
    await expect(ProjectStore.openReadOnly(root)).rejects.toThrow('conflicting project identities')
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 2 })
  })

  it('rejects malformed SQLite settings and upgrades only the exact legacy default prompt', async () => {
    const { root, store } = await fixture()
    const settings = store.project.settings
    store.database.prepare('UPDATE projects SET settings_json=?').run(JSON.stringify({ ...settings, workItemPrefix: 'invalid-prefix' }))
    await expect(ProjectStore.openReadOnly(root)).rejects.toThrow('Invalid project database metadata')
    store.database.prepare('UPDATE projects SET settings_json=?').run(JSON.stringify({ ...settings, copilotLaunchPrompt: LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT }))
    const upgraded = await ProjectStore.open(root); stores.push(upgraded)
    expect(upgraded.project.settings.copilotLaunchPrompt).toBe(DEFAULT_COPILOT_LAUNCH_PROMPT)
    expect((await ProjectStore.readMetadataDocument(root)).settings.copilotLaunchPrompt).toBe(DEFAULT_COPILOT_LAUNCH_PROMPT)
    const customized = `${LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT}\nKeep my team's specific validation instructions.`
    store.database.prepare('UPDATE projects SET settings_json=?').run(JSON.stringify({ ...settings, copilotLaunchPrompt: customized }))
    const preserved = await ProjectStore.open(root); stores.push(preserved)
    expect(preserved.project.settings.copilotLaunchPrompt).toBe(customized)
    expect((await ProjectStore.readMetadataDocument(root)).settings.copilotLaunchPrompt).toBe(customized)
  })

  it('reinitializes a moved project while allowing a different identity at its former location', async () => {
    const parent = await directory()
    const originalRoot = path.join(parent, 'original')
    const movedRoot = path.join(parent, 'moved')
    const store = await ProjectStore.initialize({ rootPath: originalRoot, name: 'Moved' }); stores.push(store)
    const original = store.project; store.close()
    await filesystem.rename(originalRoot, movedRoot)
    const replacement = await ProjectStore.initialize({ rootPath: originalRoot, name: 'Different project' }); stores.push(replacement)
    const moved = await ProjectStore.initialize({ rootPath: movedRoot, name: 'Keep original name' }); stores.push(moved)
    expect(moved.project).toMatchObject({ id: original.id, name: original.name, rootPath: movedRoot })
    expect(replacement.project.id).not.toBe(moved.project.id)
    expect((await ProjectStore.readMetadataDocument(movedRoot)).rootPath).toBe(movedRoot)
  })

  it('closes failed database opens and propagates layout write failures so repairs can proceed', async () => {
    const { root, store } = await fixture()
    store.close()
    await filesystem.writeFile(store.paths.databasePath, 'not a database')
    await expect(ProjectStore.open(root)).rejects.toThrow()
    const newRoot = await directory()
    const actualWrite = filesystem.writeFile
    const failing = vi.spyOn(filesystem, 'writeFile').mockImplementation((file, data, options) => {
      if (String(file).endsWith('schema.md')) return Promise.reject(Object.assign(new Error('layout write denied'), { code: 'EACCES' }))
      return actualWrite(file, data, options)
    })
    await expect(ProjectStore.initialize({ rootPath: newRoot, name: 'Retriable layout' })).rejects.toThrow('layout write denied')
    failing.mockRestore()
    const repaired = await ProjectStore.initialize({ rootPath: newRoot, name: 'Retriable layout' }); stores.push(repaired)
    expect(repaired.project.name).toBe('Retriable layout')
  })
})

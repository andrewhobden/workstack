import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/core/artifact-store'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createFixture(): Promise<{
  artifacts: ArtifactStore
  itemId: string
  store: ProjectStore
  sourceDirectory: string
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-artifacts-'))
  cleanupPaths.push(rootPath)
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'workstack-source-'))
  cleanupPaths.push(sourceDirectory)
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
    { rootPath, name: 'Workstack' },
    { clock: new FrozenClock(new Date('2026-08-11T00:00:00.000Z')), id: nextId }
  )
  const item = new WorkItemRepository(store, {
    clock: new FrozenClock(new Date('2026-08-11T00:00:00.000Z')),
    id: nextId
  }).create({ title: 'Support artifacts', descriptionMarkdown: 'Context before image.' })

  return {
    artifacts: new ArtifactStore(store, nextId),
    itemId: item.id,
    store,
    sourceDirectory
  }
}

describe('ArtifactStore', () => {
  it('copies an attachment into controlled storage and preserves it after the source disappears', async () => {
    const { artifacts, itemId, sourceDirectory, store } = await createFixture()
    const source = path.join(sourceDirectory, 'source.png')
    await writeFile(source, 'diagram bytes')

    const attachment = artifacts.attachFile(itemId, {
      sourcePath: source,
      originalFilename: '../../design diagram.png',
      mimeType: 'image/png'
    })
    await rm(source)

    expect(attachment).toMatchObject({
      originalFilename: '../../design diagram.png',
      storedRelativePath: expect.stringMatching(/^work-items\/[^/]+\/attachments\/[^/]+-design-diagram\.png$/),
      mimeType: 'image/png',
      sizeBytes: 13
    })
    await expect(readFile(artifacts.resolvePath(itemId, attachment.id), 'utf8')).resolves.toBe('diagram bytes')
    expect(artifacts.list(itemId)).toEqual([attachment])
    store.close()
  })

  it('persists pasted image bytes and inserts a relative Markdown reference', async () => {
    const { artifacts, itemId, store } = await createFixture()

    const attachment = artifacts.pasteImage(itemId, {
      data: Buffer.from([137, 80, 78, 71])
    })
    const item = new WorkItemRepository(store).get(itemId)

    expect(attachment.mimeType).toBe('image/png')
    expect(item.descriptionMarkdown).toContain('![screenshot.png](attachments/')
    await expect(readFile(path.join(store.paths.workItemsPath, itemId, 'work-item.md'), 'utf8')).resolves.toContain(
      '![screenshot.png](attachments/'
    )
    const blankItem = new WorkItemRepository(store).create({ title: 'Blank image description' })
    const sanitized = artifacts.pasteImage(blankItem.id, {
      data: Buffer.from([137, 80, 78, 71]),
      originalFilename: '---'
    })
    expect(sanitized.storedRelativePath).toMatch(/-attachment$/)
    expect(new WorkItemRepository(store).get(blankItem.id).descriptionMarkdown).toMatch(/^!\[---\]\(attachments\//)
    store.close()
  })

  it('stores generic byte uploads without treating them as Markdown images', async () => {
    const { artifacts, itemId, store } = await createFixture()

    const attachment = artifacts.attachBytes(itemId, {
      data: Buffer.from('specification'),
      originalFilename: 'spec.md'
    })

    expect(attachment).toMatchObject({
      originalFilename: 'spec.md',
      mimeType: 'application/octet-stream',
      sizeBytes: 13
    })
    expect(artifacts.read(itemId, attachment.id).toString()).toBe('specification')
    expect(new WorkItemRepository(store).get(itemId).descriptionMarkdown).toBe('Context before image.')
    store.close()
  })

  it('removes an attachment and rejects missing or escaped records', async () => {
    const { artifacts, itemId, sourceDirectory, store } = await createFixture()
    const source = path.join(sourceDirectory, 'notes.txt')
    await writeFile(source, 'notes')
    const attachment = artifacts.attachFile(itemId, { sourcePath: source })

    artifacts.remove(itemId, attachment.id)

    expectErrorCode(() => artifacts.get(itemId, attachment.id), 'ATTACHMENT_NOT_FOUND')
    await expect(stat(path.join(store.paths.workItemsPath, itemId, 'attachments'))).resolves.toBeDefined()
    store.database
      .prepare(
        `INSERT INTO attachments (
          id, work_item_id, original_filename, stored_relative_path, mime_type, size_bytes, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f',
        itemId,
        'unsafe.txt',
        '../unsafe.txt',
        'text/plain',
        1,
        null,
        '2026-08-11T00:00:00.000Z'
      )
    expectErrorCode(
      () => artifacts.resolvePath(itemId, 'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f'),
      'ATTACHMENT_NOT_FOUND'
    )
    store.close()
  })

  it('validates invalid sources, image data, and filenames', async () => {
    const { artifacts, itemId, sourceDirectory, store } = await createFixture()

    expectErrorCode(() => artifacts.attachFile(itemId, { sourcePath: sourceDirectory }), 'VALIDATION_ERROR')
    expectErrorCode(
      () => artifacts.attachBytes(itemId, { data: Buffer.alloc(0), originalFilename: 'empty.txt' }),
      'VALIDATION_ERROR'
    )
    expectErrorCode(() => artifacts.pasteImage(itemId, { data: Buffer.alloc(0) }), 'VALIDATION_ERROR')
    const source = path.join(sourceDirectory, 'valid.txt')
    await writeFile(source, 'valid')
    expectErrorCode(() => artifacts.attachFile(itemId, { sourcePath: source, originalFilename: '   ' }), 'VALIDATION_ERROR')
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

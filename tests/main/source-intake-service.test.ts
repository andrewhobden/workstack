import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceIntakeService, SOURCE_INTAKE_LIMITS, parseGithubTarget } from '../../src/main/source-intake-service'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'

const execute = promisify(execFile)
const roots: string[] = []
const running: Array<Promise<void>> = []
afterEach(async () => { await Promise.allSettled(running.splice(0)); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(github?: (args: string[]) => unknown | Promise<unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workstack-source-intake-'))
  roots.push(root)
  const repository = path.join(root, 'repository')
  await fs.mkdir(repository)
  await execute('git', ['init', '-q', repository])
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.md\nnode_modules/\n.workstack/\n.workstack-*\n')
  await fs.writeFile(path.join(repository, 'README.md'), '# Project\nSelected project architecture.\n')
  await fs.writeFile(path.join(repository, 'ignored.md'), 'Must not import ignored evidence.')
  await fs.writeFile(path.join(repository, '.env'), 'SECRET=excluded')
  await fs.writeFile(path.join(repository, 'binary.txt'), Buffer.from([0, 1, 2]))
  await fs.mkdir(path.join(repository, 'src'))
  await fs.writeFile(path.join(repository, 'src', 'index.ts'), 'export const project_entry_point = true\n')
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', 'README.md', '.gitignore', 'src/index.ts'], { cwd: repository })
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: repository })
  const projects = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
  const project = await projects.createProject({ rootPath: repository, name: 'Intake fixture' })
  const requests: string[][] = []
  const intake = new SourceIntakeService(projects, { run: async (command, args, cwd) => {
    if (command === 'git') return (await execute('git', args, { cwd })).stdout
    requests.push(args)
    if (!github) throw new Error('Unexpected live GitHub acquisition in a local-only test.')
    return JSON.stringify(await github(args))
  } })
  const process = async () => { const current = intake.processProject(project.id); running.push(current); await current }
  const catalog = async <T>(operation: (catalog: SourceCatalogRepository) => T): Promise<T> => {
    const metadata = await projects.getProject(project.id)
    const store = await ProjectStore.open(metadata.rootPath)
    try { return operation(new SourceCatalogRepository(store)) } finally { store.close() }
  }
  return { root, repository, projects, project, intake, requests, process, catalog }
}

describe('selected source intake', () => {
  it('previews ignore/format diagnostics and imports only selected repository paths', async () => {
    const context = await fixture()
    const preview = await context.intake.previewRepository(context.project.id)
    expect(preview.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(preview.limits).toEqual(SOURCE_INTAKE_LIMITS)
    expect(preview.entries.find((entry) => entry.path === 'README.md')).toMatchObject({ kind: 'documentation', suggested: true })
    expect(preview.entries.find((entry) => entry.path === 'src/index.ts')).toMatchObject({ kind: 'code', suggested: false })
    expect(preview.entries.find((entry) => entry.path === 'ignored.md')).toBeUndefined()
    expect(preview.entries.find((entry) => entry.path === '.env')?.excludedReason).toContain('Excluded')
    expect(preview.entries.find((entry) => entry.path === 'binary.txt')?.excludedReason).toContain('Binary')
    await expect(context.intake.importSelection(context.project.id, { paths: ['ignored.md'] })).rejects.toThrow('excluded')
    await expect(context.intake.importSelection(context.project.id, { paths: ['../outside.md'] })).rejects.toThrow('outside')
    await context.intake.importSelection(context.project.id, { paths: ['README.md'] })
    await context.process()
    const sources = await context.catalog((catalog) => catalog.listSources())
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ repositoryPath: 'README.md', state: 'ready' })
    expect(context.requests).toEqual([])
    const revision = await context.catalog((catalog) => catalog.getDetail(sources[0].id).revisions[0])
    expect(revision.manifest.metadata).toMatchObject({ gitCommit: preview.commit, repositoryPath: 'README.md', workingTree: true })
    expect(revision.upstreamRevision).toMatch(/^sha256:/)
  })

  it('preserves invalid UTF-8 bytes as explicitly unsupported evidence instead of replacing them', async () => {
    const context = await fixture()
    const bytes = Buffer.from([0x61, 0xc3, 0x28, 0x62])
    await fs.writeFile(path.join(context.repository, 'invalid.md'), bytes)
    await context.intake.importSelection(context.project.id, { paths: ['invalid.md'] })
    await context.process()
    const detail = await context.catalog((catalog) => catalog.getDetail(catalog.listSources()[0].id))
    expect(detail.source.state).toBe('unavailable')
    expect(detail.revisions[0]).toMatchObject({ outcome: 'unsupported', manifest: { metadata: { originalEncoding: 'base64', originalByteHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } })
    const original = await context.catalog((catalog) => catalog.readRevision(detail.source.id, detail.revisions[0].id, { representation: 'original' }))
    expect(Buffer.from(original.text, 'base64')).toEqual(bytes)
  })

  it('retains stable repository-relative identity across relocation and unchanged rescans', async () => {
    const context = await fixture()
    await context.intake.importSelection(context.project.id, { paths: ['README.md'] })
    await context.process()
    const before = await context.catalog((catalog) => catalog.listSources()[0])
    const moved = path.join(context.root, 'moved-repository')
    await fs.rename(context.repository, moved)
    await context.projects.reconnectProject(context.project.id, moved)
    await context.intake.importSelection(context.project.id, { paths: ['README.md'] })
    await context.process()
    expect(await context.catalog((catalog) => catalog.listSources()[0].id)).toBe(before.id)
    expect(await context.catalog((catalog) => catalog.getDetail(before.id).revisions.length)).toBe(1)
  })

  it('paginates selected GitHub discussion with authors, timestamps and task provenance', async () => {
    const body = { id: 42, title: 'Lease design', body: 'Issue body evidence', updated_at: '2026-09-09T00:00:00Z', created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/example/repo/issues/42', user: { login: 'author' } }
    const comment = (id: number) => ({ id, body: `Discussion evidence ${id}`, html_url: `https://github.com/example/repo/issues/42#issuecomment-${id}`, user: { login: `reviewer-${id}` }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' })
    const context = await fixture((args) => args[1].includes('comments') ? args[1].endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => comment(index)) : [comment(100)] : body)
    const task = await context.projects.createWorkItem(context.project.id, { title: 'Use issue context' })
    await context.intake.importSelection(context.project.id, { paths: [], githubUrls: [body.html_url], workItemId: task.id })
    await context.process()
    const source = await context.catalog((catalog) => catalog.listSources()[0])
    expect(source).toMatchObject({ kind: 'github_issue', workItemId: task.id, state: 'ready' })
    expect(context.requests.map((args) => args[1])).toContain('repos/example/repo/issues/42/comments?per_page=100&page=2')
    const detail = await context.catalog((catalog) => catalog.getDetail(source.id))
    expect(detail.revisions[0].manifest.metadata).toMatchObject({ discussionCount: 101, complete: true, author: 'author' })
    const original = await context.catalog((catalog) => catalog.readRevision(source.id, detail.revisions[0].id, { limit: 24_000 }).text)
    expect(original).toContain('reviewer-0')
    expect(original).toContain('2026-09-02T00:00:00Z')
    expect((await context.projects.getWorkItem(context.project.id, task.id)).descriptionMarkdown).toBe('')
  })

  it('marks discussion limits and partial authorization failure explicitly without ready retrieval', async () => {
    const body = { id: 2, title: 'Large PR', body: 'Base evidence', updated_at: '2026-09-09T00:00:00Z', head: { sha: 'a'.repeat(40) } }
    const context = await fixture((args) => {
      if (args[1].includes('/comments?')) return Array.from({ length: 100 }, (_, index) => ({ id: index, body: 'Many discussion notes' }))
      if (args[1].includes('/reviews?')) throw new Error('HTTP 403 access denied')
      return body
    })
    await context.intake.importSelection(context.project.id, { paths: [], githubUrls: ['https://github.com/example/repo/pull/2'] })
    await context.process()
    const detail = await context.catalog((catalog) => catalog.getDetail(catalog.listSources()[0].id))
    expect(detail.source.state).toBe('unavailable')
    expect(detail.revisions[0]).toMatchObject({ outcome: 'partial', manifest: { metadata: { discussionCount: 200, complete: false } } })
    expect(detail.revisions[0].manifest.limitations.join(' ')).toContain('limited')
    expect(await context.catalog((catalog) => catalog.search('discussion'))).toEqual([])
  })

  it('resolves GitHub file content at an immutable commit and performs metadata-only refresh without fetching bodies', async () => {
    const commit = 'a'.repeat(40)
    const context = await fixture((args) => {
      if (args[1] === 'graphql') return { data: { repository: { object: { oid: commit } } } }
      if (args[1].includes('/commits/')) return { sha: commit }
      if (args[1].includes('/contents/')) return { size: 21, encoding: 'base64', content: Buffer.from('# Selected file\nText\n').toString('base64'), sha: 'b'.repeat(40) }
      throw new Error(`Unexpected request ${args[1]}`)
    })
    await context.intake.importSelection(context.project.id, { paths: [], githubUrls: ['https://github.com/example/repo/blob/main/README.md'] })
    await context.process()
    const source = await context.catalog((catalog) => catalog.listSources()[0])
    const first = await context.catalog((catalog) => catalog.getDetail(source.id).revisions[0])
    expect(first.upstreamRevision).toBe(commit)
    expect(first.manifest.metadata.canonicalRevisionUri).toBe(`https://github.com/example/repo/blob/${commit}/README.md`)
    expect(context.requests.map((args) => args[1])).toContain(`repos/example/repo/contents/README.md?ref=${commit}`)
    await context.catalog((catalog) => catalog.updatePolicy(source.id, 'metadata_only'))
    context.requests.length = 0
    await context.intake.refresh(context.project.id, source.id)
    await context.process()
    expect(context.requests).toHaveLength(1)
    expect(context.requests[0][1]).toBe('graphql')
    expect(context.requests[0].join(' ')).not.toMatch(/body|comments|contents/)
    expect(await context.catalog((catalog) => catalog.getSource(source.id).state)).toBe('ready')
    expect(await context.catalog((catalog) => catalog.getDetail(source.id).revisions.length)).toBe(1)
  })

  it('keeps unauthorized remote sources unavailable without blocking unrelated local intake', async () => {
    const context = await fixture(() => { throw new Error('HTTP 401 not logged in') })
    await context.intake.importSelection(context.project.id, { paths: ['README.md'], githubUrls: ['https://github.com/example/repo/issues/9'] })
    await context.process()
    const sources = await context.catalog((catalog) => catalog.listSources())
    expect(sources.find((source) => source.kind === 'repo_file')?.state).toBe('ready')
    const unavailable = sources.find((source) => source.kind === 'github_issue')!
    expect(unavailable.state).toBe('unavailable')
    const detail = await context.catalog((catalog) => catalog.getDetail(unavailable.id))
    expect(detail.jobs[0]).toMatchObject({ status: 'failed', nextAttemptAt: null })
    expect(detail.source.staleReason).toContain('401')
  })

  it('rejects unsupported GitHub origins and credential file selections', () => {
    expect(() => parseGithubTarget('https://example.com/org/repo/issues/1')).toThrow('github.com')
    expect(() => parseGithubTarget('https://github.com/org/repo/blob/main/.env')).toThrow('excluded')
    expect(() => parseGithubTarget('https://user:secret@github.com/org/repo/issues/1')).toThrow('github.com')
    expect(parseGithubTarget('https://github.com/org/repo/issues/1#issuecomment-2').canonicalUrl).toBe('https://github.com/org/repo/issues/1')
  })
})

import * as fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore } from '../../src/core/project-store'
import { ProjectsService } from '../../src/core/projects-service'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { KnowledgeDeliveryOutbox } from '../../src/core/knowledge-delivery'
import type { AgentChatCompletion, AgentChatProvider } from '../../src/core/knowledge-chat'

const roots: string[] = []
type ProjectDeletionFileSystem = NonNullable<ConstructorParameters<typeof ProjectsService>[2]>
const run = promisify(execFile)
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workstack-service-boundary-'))); roots.push(base)
  const registry = new ProjectRegistry(path.join(base, 'registry.json'))
  const service = new ProjectsService(registry)
  const project = await service.createProject({ rootPath: path.join(base, 'project'), name: 'Project boundary', description: 'Context and agent coordination.' })
  return { base, registry, service, project }
}
async function withStore<T>(root: string, operation: (store: ProjectStore) => T | Promise<T>): Promise<T> {
  const store = await ProjectStore.open(root)
  try { return await operation(store) } finally { store.close() }
}
const deletionFs: ProjectDeletionFileSystem = { cp: fs.cp, lstat: fs.lstat, mkdir: fs.mkdir, rm: fs.rm }

describe('project service persisted workflows', () => {
  it('recovers unfinished work and reconciles submitted delivery with retained handoff and retry evidence', async () => {
    const { service, project } = await fixture()
    const task = await service.createWorkItem(project.id, { title: 'Recover delivery' })
    const claim = await service.claimWorkItem(project.id, task.id, { agentId: 'previous-worker' })
    await service.blockWorkItem(project.id, task.id, claim.claimToken, { reason: 'Needs another attempt' })
    expect(await service.recoverWorkItem(project.id, task.id, { reason: 'Dependency repaired', actorId: 'owner' })).toMatchObject({ status: 'backlog', attentionReason: null })
    const submitted = await service.reconcileSubmittedPullRequest(project.id, task.id, { branch: 'codex/recovered', prUrl: 'https://github.com/example/project/pull/10', merged: false })
    expect(submitted.prState).toBe('OPEN')
    expect(await service.updateWorkerHandoff(project.id, task.id, { sessionSummaryMarkdown: 'Next owner should inspect the merge checks.' })).toMatchObject({ sessionSummaryMarkdown: 'Next owner should inspect the merge checks.' })
    await expect(service.reconcileSubmittedPullRequest(project.id, task.id, { branch: 'codex/recovered', prUrl: submitted.prUrl!, merged: false })).rejects.toThrow('no longer in the backlog')
    await service.reconcilePullRequestWorkItem(project.id, task.id, submitted.prUrl!, 'MERGED')
    const deliveries = await service.listKnowledgeDeliveries(project.id)
    expect(deliveries).toMatchObject([{ workItemId: task.id, prUrl: submitted.prUrl, status: 'pending' }])
    await withStore(project.rootPath, (store) => {
      const outbox = new KnowledgeDeliveryOutbox(store); const attempt = outbox.claimNext()!
      outbox.fail(attempt.id, attempt.owner!, new Error('Temporary processing failure'), false)
    })
    expect(await service.retryKnowledgeDelivery(project.id, deliveries[0].id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect((await service.getCompletion(project.id, task.id))?.sessionSummaryMarkdown).toContain('Next owner')
    const mergedTask = await service.createWorkItem(project.id, { title: 'Already merged delivery' })
    expect(await service.reconcileSubmittedPullRequest(project.id, mergedTask.id, { branch: 'codex/already-merged', prUrl: 'https://github.com/example/project/pull/11', merged: true })).toMatchObject({ prState: 'MERGED' })
    expect(await service.getWorkItem(project.id, mergedTask.id)).toMatchObject({ status: 'completed' })
  })

  it('preserves source job control, exact record reads and directory corrections across separate service operations', async () => {
    const { service, project } = await fixture()
    const { source, revision, job } = await withStore(project.rootPath, async (store) => {
      const catalog = new SourceCatalogRepository(store)
      const source = catalog.registerSource({ kind: 'manual', title: 'Queue contract', canonicalUri: 'manual://queue' })
      const revision = catalog.publishRevision({ sourceId: source.id, original: 'Queue uses durable ownership receipts.' })
      const job = catalog.queueImport(source.id, 'retryable-import')
      await catalog.processNext(async () => { throw new Error('Transient source failure') })
      return { source, revision, job }
    })
    expect(await service.getProjectSource(project.id, source.id)).toMatchObject({ source: { id: source.id, currentRevisionId: revision.id }, jobs: [{ id: job.id, status: 'failed' }] })
    expect(await service.retrySourceIntake(project.id, job.id)).toMatchObject({ status: 'pending' })
    await service.cancelSourceIntake(project.id, job.id)
    expect((await service.getProjectSource(project.id, source.id)).jobs[0]).toMatchObject({ status: 'failed', stage: 'cancelled', nextAttemptAt: null })
    const record = await service.createKnowledgeRecord(project.id, { kind: 'decision', title: 'Use durable receipts', markdown: 'Queue ownership uses durable receipts.' })
    expect(await service.searchKnowledgeRecords(project.id, 'durable')).toMatchObject([{ id: record.id }])
    expect(await service.readKnowledgeRecordMarkdown(project.id, record.id)).toContain('Queue ownership uses durable receipts')
    const entity = await service.createProjectEntity(project.id, { kind: 'component', displayName: 'Queue', definition: 'Owns agent scheduling.' })
    const updated = await service.updateProjectEntity(project.id, entity.id, { expectedVersion: entity.version, definition: 'Owns scheduling and receipt recovery.' })
    expect(updated.definition).toContain('receipt recovery')
    expect(await service.listProjectMentions(project.id, entity.id)).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: entity.id, surface: 'Queue' })]))
    expect(await service.retireProjectEntity(project.id, entity.id, updated.version, 'owner', 'The queue was replaced.')).toMatchObject({ status: 'retired' })
    expect((await service.projectDirectoryDetail(project.id, entity.id)).history.map((entry) => entry.action)).toContain('retired')
  })

  it('reviews, reconciles, rejects and restores wiki proposals through the service without losing current history', async () => {
    const { service, project } = await fixture()
    const stage = (requestKey: string, content: string, slug = 'generated-design') => withStore(project.rootPath, (store) => new WikiRevisionRepository(store).stage({ requestKey, title: requestKey, pages: [{ slug, content }] }))
    const first = await stage('initial-design', '# Initial design')
    await service.publishWikiRevision(project.id, first.revision.id, 'reviewer', 'Evidence checked.')
    const rejected = await stage('unsupported-design', '# Unsupported statement')
    expect(await service.rejectWikiRevision(project.id, rejected.revision.id, 'reviewer', 'Evidence is missing.')).toMatchObject({ status: 'rejected' })
    const independent = await stage('independent-design', '# Independent component', 'generated-component')
    const concurrent = await stage('updated-design', '# Improved design')
    await service.publishWikiRevision(project.id, concurrent.revision.id, 'reviewer')
    const reconciled = await service.reconcileWikiRevision(project.id, independent.revision.id, 'reviewer', 'Independent page change.')
    expect(reconciled.revision.id).not.toBe(independent.revision.id)
    await service.publishWikiRevision(project.id, reconciled.revision.id, 'reviewer')
    const restored = await service.restoreWikiRevision(project.id, first.revision.id, 'reviewer', 'Restore the original approved design.')
    expect(restored.revision.status).toBe('published')
    expect(await service.listWikiArticles(project.id)).toEqual([{ slug: 'generated-design', content: '# Initial design' }])
  })

  it('persists chat proposals and human dispositions together with planning and immutable packet attachment reads', async () => {
    const { service, project } = await fixture()
    const session = await service.createKnowledgeChatSession(project.id)
    const answers: AgentChatCompletion[] = [{ toolCalls: [
      { id: 'proposal-one', name: 'request_create_work_item', arguments: { title: 'Accepted proposal' } },
      { id: 'proposal-two', name: 'request_create_work_item', arguments: { title: 'Rejected proposal' } }
    ] }, { content: 'Please review these two proposals.' }]
    const provider: AgentChatProvider = { completeChat: async () => answers.shift()! }
    const turn = await service.sendKnowledgeChatMessage(project.id, session.id, 'Suggest tasks.', provider)
    expect(await service.listKnowledgeChatSessions(project.id)).toMatchObject([{ id: session.id }])
    expect(await service.listKnowledgeChatMessages(project.id, session.id)).toEqual(turn.messages)
    expect(await service.listKnowledgeChatToolCalls(project.id, session.id)).toEqual(turn.toolCalls)
    const pending = await service.listKnowledgeChatPendingActions(project.id, session.id)
    expect(pending).toHaveLength(2)
    const accepted = pending.find((entry) => entry.payload.title === 'Accepted proposal')!
    const rejected = pending.find((entry) => entry.payload.title === 'Rejected proposal')!
    expect((await service.approveKnowledgeChatPendingAction(project.id, session.id, accepted.id)).pendingActions.find((entry) => entry.id === accepted.id)?.status).toBe('approved')
    expect((await service.rejectKnowledgeChatPendingAction(project.id, session.id, rejected.id)).pendingActions.find((entry) => entry.id === rejected.id)?.status).toBe('rejected')
    const tasks = await service.listWorkItems(project.id)
    expect(tasks).toMatchObject([{ title: 'Accepted proposal' }])
    const plan = await service.createPlanningSession(project.id)
    expect(await service.listPlanningSessions(project.id)).toEqual([plan])
    const attachment = await service.attachBytes(project.id, tasks[0].id, { originalFilename: 'requirements.txt', mimeType: 'text/plain', data: Buffer.from('Required immutable task evidence.') })
    const packet = await service.previewContextPacket(project.id, tasks[0].id)
    const feedback = await service.createContextFeedback(project.id, { workItemId: tasks[0].id, packetId: packet.id, category: 'missing_context', note: 'Please add architectural rationale.', actor: 'reviewer', authorKind: 'human' })
    expect(await service.getContextFeedback(project.id, feedback.id)).toEqual(feedback)
    await service.removeAttachment(project.id, tasks[0].id, attachment.id)
    const historical = await service.readContextArtifact(project.id, packet.id, attachment.id)
    expect(Buffer.from(historical.dataBase64, 'base64').toString()).toBe('Required immutable task evidence.')
    expect(historical.sha256).toBe(attachment.sha256)
  })
})

describe('project service isolation and backup validation', () => {
  it('isolates identity mismatches, unreadable projects and non-Error failures while listing', async () => {
    const { service, registry, project } = await fixture()
    const record = (await registry.find(project.id))!
    vi.spyOn(registry, 'list').mockResolvedValueOnce([{ ...record, id: 'other-identity' }])
    expect(await service.listProjects()).toMatchObject([{ id: 'other-identity', availability: 'invalid', availabilityError: expect.stringContaining('different or relocated') }])
    const open = vi.spyOn(ProjectStore, 'openReadOnly')
    open.mockRejectedValueOnce(Object.assign(new Error('Access was revoked.'), { code: 'EACCES' }))
    expect(await service.listProjects()).toMatchObject([{ id: project.id, availability: 'unreadable' }])
    open.mockRejectedValueOnce('Storage adapter unavailable')
    expect(await service.listProjects()).toMatchObject([{ id: project.id, availability: 'invalid', availabilityError: 'Storage adapter unavailable' }])
    expect(await service.listProjects()).toMatchObject([{ id: project.id, availability: 'available' }])
  })

  it('rechecks project identity after reconnect validation and after the deletion barrier opens its store', async () => {
    const { service, project, base } = await fixture()
    const other = await service.createProject({ rootPath: path.join(base, 'other'), name: 'Other' })
    const foreign = await ProjectStore.open(other.rootPath)
    const close = vi.spyOn(foreign, 'close')
    const open = vi.spyOn(ProjectStore, 'open').mockResolvedValueOnce(foreign)
    await expect(service.reconnectProject(project.id, project.rootPath)).rejects.toThrow('different project')
    expect(close).toHaveBeenCalledOnce(); open.mockRestore()
    const foreignAtDelete = await ProjectStore.open(other.rootPath)
    vi.spyOn(ProjectStore, 'open').mockResolvedValueOnce(foreignAtDelete)
    await expect(service.deleteProject(project.id)).rejects.toThrow('different project')
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
    expect(await service.getProject(other.id)).toMatchObject({ id: other.id })
  })

  it('rejects backups inside live project data and preserves the original after a non-Error backup failure', async () => {
    const { registry, project, service } = await fixture()
    const nestedBackup = new ProjectsService(registry, path.join(project.rootPath, '.workstack', 'backups'))
    await expect(nestedBackup.deleteProject(project.id)).rejects.toThrow('outside the project data')
    const failedBackup = new ProjectsService(registry, undefined, { ...deletionFs, mkdir: async () => { throw 'storage unavailable' } })
    await expect(failedBackup.deleteProject(project.id)).rejects.toThrow('storage unavailable')
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
  })

  it.each(['identity', 'integrity', 'foreign_keys'] as const)('cancels deletion when the copied database fails %s validation', async (failure) => {
    const { registry, project, service } = await fixture()
    const originalOpen = ProjectStore.openReadOnly.bind(ProjectStore)
    const open = vi.spyOn(ProjectStore, 'openReadOnly').mockImplementation(async (root) => {
      const store = await originalOpen(root)
      if (root !== project.rootPath) {
        if (failure === 'identity') vi.spyOn(store, 'project', 'get').mockReturnValue({ ...store.project, id: 'incorrect-backup-identity' })
        else {
          const pragma = store.database.pragma.bind(store.database)
          vi.spyOn(store.database, 'pragma').mockImplementation(((statement, options) => statement === 'integrity_check' ? [{ integrity_check: failure === 'integrity' ? 'database corruption' : 'ok' }] : statement === 'foreign_key_check' ? [{ table: 'attachments', parent: 'work_items' }] : pragma(statement, options)) as typeof store.database.pragma)
        }
      }
      return store
    })
    await expect(new ProjectsService(registry).deleteProject(project.id)).rejects.toThrow(failure === 'identity' ? 'identity does not match' : 'integrity check failed')
    open.mockRestore()
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
  })

  it.each(['relative_escape', 'absolute', 'symlink'] as const)('rejects %s attachment paths before deleting original data', async (failure) => {
    const { service, project, base } = await fixture()
    const task = await service.createWorkItem(project.id, { title: 'Attachment owner' })
    const attachment = await service.attachBytes(project.id, task.id, { originalFilename: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('Preserve me') })
    const outside = path.join(base, 'outside.txt'); await fs.writeFile(outside, 'Preserve me')
    if (failure === 'symlink') {
      const file = path.join(project.rootPath, '.workstack', attachment.storedRelativePath)
      await fs.unlink(file); await fs.symlink(outside, file)
    } else await withStore(project.rootPath, (store) => store.database.prepare('UPDATE attachments SET stored_relative_path=? WHERE id=?').run(failure === 'absolute' ? outside : '../../outside.txt', attachment.id))
    await expect(service.deleteProject(project.id)).rejects.toThrow(failure === 'symlink' ? 'symlink leaves' : 'path leaves')
    expect(await fs.readFile(outside, 'utf8')).toBe('Preserve me')
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
  })

  it.each(['symlink', 'fifo'] as const)('rejects an unregistered %s entry in a backup before removing the original', async (entry) => {
    const { registry, project, service, base } = await fixture()
    const backupFs: ProjectDeletionFileSystem = { ...deletionFs, cp: async (source, destination, options) => {
      await fs.cp(source, destination, options)
      const extra = path.join(String(destination), 'unsupported')
      if (entry === 'symlink') await fs.symlink(base, extra)
      else await run('mkfifo', [extra])
    } }
    await expect(new ProjectsService(registry, undefined, backupFs).deleteProject(project.id)).rejects.toThrow(entry === 'symlink' ? 'self-contained artifacts' : 'unsupported filesystem entry')
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
  })

  it.each([{ version: 2, files: [] }, { version: 1, files: null }])('requires recovery when the backup manifest is malformed after removal fails: %j', async (manifest) => {
    const { registry, project, base } = await fixture()
    let backupPath = ''
    const backupFs: ProjectDeletionFileSystem = { ...deletionFs,
      cp: async (source, destination, options) => { await fs.cp(source, destination, options); backupPath = String(destination) },
      rm: async (target, options) => {
        if (String(target) === path.join(project.rootPath, '.workstack')) {
          await fs.writeFile(path.join(backupPath, '.deletion-manifest.json'), JSON.stringify(manifest))
          throw new Error('Removal was interrupted')
        }
        await fs.rm(target, options)
      }
    }
    await expect(new ProjectsService(registry, path.join(base, 'backups'), backupFs).deleteProject(project.id)).rejects.toThrow('Your backup remains')
    expect(await registry.find(project.id)).toBeDefined()
    expect((await new ProjectsService(registry).listProjects())[0].availability).toBe('deleting')
    expect(await fs.stat(path.join(backupPath, 'workstack.db'))).toBeDefined()
  })
})

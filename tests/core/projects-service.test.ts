import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore, projectPaths } from '../../src/core/project-store'
import { ProjectsService } from '../../src/core/projects-service'
import { ClaimsRepository } from '../../src/core/claims'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function createService(): Promise<{ service: ProjectsService; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstack-service-'))
  cleanupPaths.push(directory)
  return {
    service: new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json'))),
    directory
  }
}

describe('ProjectsService', () => {
  it('creates, lists, edits, and safely detaches a project', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')

    const created = await service.createProject({ rootPath, name: 'Workstack', description: 'Coordination' })
    expect(created).toMatchObject({
      name: 'Workstack',
      backlogCount: 0,
      inProgressCount: 0,
      completedCount: 0
    })
    await expect(service.listProjects()).resolves.toEqual([created])
    await expect(service.updateProject(created.id, { name: 'Updated', description: 'Updated project' })).resolves.toMatchObject({
      name: 'Updated',
      description: 'Updated project'
    })
    await expect(service.getProject(created.id)).resolves.toMatchObject({ name: 'Updated' })
    await expect(service.verifyProjectRoot(created.id)).resolves.toBe(rootPath)
    await service.detachProject(created.id)
    await expect(fs.stat(projectPaths(rootPath).projectPath)).resolves.toBeDefined()
    await expect(service.listProjects()).resolves.toEqual([])
  })

  it('resolves an MCP project reference by visible name or legacy identifier without guessing duplicates', async () => {
    const { service, directory } = await createService()
    const named = await service.createProject({ rootPath: path.join(directory, 'named'), name: 'Roadmap' })
    const firstDuplicate = await service.createProject({ rootPath: path.join(directory, 'duplicate-one'), name: 'Duplicate' })
    await service.createProject({ rootPath: path.join(directory, 'duplicate-two'), name: 'Duplicate' })

    await expect(service.resolveProjectReference(' roadmap ')).resolves.toBe(named.id)
    await expect(service.resolveProjectReference(named.id)).resolves.toBe(named.id)
    await expect(service.resolveProjectReference('Duplicate')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(service.resolveProjectReference('Missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(service.resolveProjectReference(' ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(firstDuplicate.name).toBe('Duplicate')
  })

  it('backs up and removes only Workstack project data before deleting its registry record', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const untouchedFile = path.join(rootPath, 'README.md')
    await fs.writeFile(untouchedFile, '# User repository\n')

    const result = await service.deleteProject(project.id)

    await expect(fs.stat(rootPath)).resolves.toBeDefined()
    await expect(fs.stat(untouchedFile)).resolves.toBeDefined()
    await expect(fs.stat(projectPaths(rootPath).workstackPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(result.backupPath, 'project.json'))).resolves.toBeDefined()
    await expect(service.listProjects()).resolves.toEqual([])
    expect(result.backupPath).toContain(path.join('backups', 'project-deletions'))
  })

  it('preserves the project and registry when a backup cannot be created', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    await fs.writeFile(path.join(directory, 'backup-file'), 'not a directory')
    const blockedService = new ProjectsService(
      new ProjectRegistry(path.join(directory, 'registry.json')),
      path.join(directory, 'backup-file')
    )

    await expect(blockedService.deleteProject(project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(fs.stat(projectPaths(rootPath).workstackPath)).resolves.toBeDefined()
    await expect(blockedService.getProject(project.id)).resolves.toMatchObject({ id: project.id })
    await expect(service.getProject(project.id)).resolves.toMatchObject({ id: project.id })
  })

  it('restores Workstack data if registry removal fails after a backup', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    vi.spyOn(registry, 'remove').mockRejectedValueOnce(new Error('registry unavailable'))
    const recoveryService = new ProjectsService(registry)

    await expect(recoveryService.deleteProject(project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(fs.stat(projectPaths(rootPath).workstackPath)).resolves.toBeDefined()
    await expect(recoveryService.getProject(project.id)).resolves.toMatchObject({ id: project.id })
  })

  it('restores Workstack data when registry removal reports a missing record', async () => {
    const { directory } = await createService()
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const service = new ProjectsService(registry)
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    vi.spyOn(registry, 'remove').mockResolvedValueOnce(false)

    await expect(service.deleteProject(project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(fs.stat(projectPaths(rootPath).workstackPath)).resolves.toBeDefined()
    await expect(registry.find(project.id)).resolves.toBeDefined()
  })

  it('does not delete data when the registry points at a different project identity', async () => {
    const { service, directory } = await createService()
    const firstRoot = path.join(directory, 'first')
    const first = await service.createProject({ rootPath: firstRoot, name: 'First' })
    const second = await service.createProject({ rootPath: path.join(directory, 'second'), name: 'Second' })
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const secondMetadata = await service.getProject(second.id)
    await registry.remove(first.id)
    await registry.remove(second.id)
    await registry.register({ ...secondMetadata, id: first.id })

    await expect(service.deleteProject(first.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(fs.stat(projectPaths(secondMetadata.rootPath).workstackPath)).resolves.toBeDefined()
  })

  it('does not delete data when the registered root differs from the project metadata root', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const projectFile = projectPaths(rootPath).projectPath
    const metadata = JSON.parse(await fs.readFile(projectFile, 'utf8')) as { rootPath: string }
    await fs.writeFile(projectFile, `${JSON.stringify({ ...metadata, rootPath: path.join(directory, 'other-project') }, null, 2)}\n`)

    await expect(service.deleteProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(fs.stat(projectPaths(rootPath).workstackPath)).resolves.toBeDefined()
    await expect(new ProjectRegistry(path.join(directory, 'registry.json')).find(project.id)).resolves.toBeDefined()
  })

  it('preserves the project and reports its backup when Workstack data cannot be removed', async () => {
    const { directory } = await createService()
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const service = new ProjectsService(registry)
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const removalFailureService = new ProjectsService(
      registry,
      undefined,
      { cp: fs.cp, lstat: fs.lstat, mkdir: fs.mkdir, rm: async () => { throw new Error('permission denied') } }
    )

    await expect(removalFailureService.deleteProject(project.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    await expect(fs.stat(projectPaths(rootPath).workstackPath)).resolves.toBeDefined()
    await expect(service.getProject(project.id)).resolves.toMatchObject({ id: project.id })
    await expect(fs.readdir(path.join(directory, 'backups', 'project-deletions'))).resolves.not.toEqual([])
  })

  it('rejects a symlinked Workstack data directory without following it', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const outsidePath = path.join(directory, 'outside')
    const workstackPath = projectPaths(rootPath).workstackPath
    await fs.mkdir(outsidePath)
    await fs.writeFile(path.join(outsidePath, 'keep.txt'), 'do not delete')
    await fs.rm(workstackPath, { recursive: true, force: true })
    await fs.symlink(outsidePath, workstackPath)

    await expect(service.deleteProject(project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(fs.readFile(path.join(outsidePath, 'keep.txt'), 'utf8')).resolves.toBe('do not delete')
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(new ProjectRegistry(path.join(directory, 'registry.json')).find(project.id)).resolves.toBeDefined()
  })

  it('rejects a registry path that is not an absolute project root', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Workstack' })
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const metadata = await service.getProject(project.id)
    await registry.remove(project.id)
    await registry.register({ ...metadata, rootPath: 'relative-project' })

    await expect(service.deleteProject(project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(registry.find(project.id)).resolves.toMatchObject({ rootPath: 'relative-project' })
  })

  it('rejects a symlinked repository root before it can reach Workstack data', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const movedRootPath = path.join(directory, 'moved-project')
    await fs.rename(rootPath, movedRootPath)
    await fs.symlink(movedRootPath, rootPath)

    await expect(service.deleteProject(project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(fs.stat(path.join(movedRootPath, '.workstack', 'project.json'))).resolves.toBeDefined()
  })

  it('retains the durable backup when recovery cannot restore data after registry failure', async () => {
    const { directory } = await createService()
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const service = new ProjectsService(registry)
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    vi.spyOn(registry, 'remove').mockRejectedValueOnce(new Error('registry unavailable'))
    let copyCalls = 0
    const recoveryFailureService = new ProjectsService(registry, undefined, {
      lstat: fs.lstat,
      mkdir: fs.mkdir,
      rm: fs.rm,
      cp: async (...arguments_) => {
      copyCalls += 1
      if (copyCalls === 2) {
        throw new Error('restore unavailable')
      }
      return fs.cp(...arguments_)
      }
    })

    await expect(recoveryFailureService.deleteProject(project.id)).rejects.toThrow('Restore the project data')

    await expect(fs.readdir(path.join(directory, 'backups', 'project-deletions'))).resolves.not.toEqual([])
  })

  it('runs work-item operations through the selected project store', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Workstack' })
    const workItem = await service.createWorkItem(project.id, {
      title: 'Create project service',
      priority: 'high'
    })

    await expect(service.listWorkItems(project.id)).resolves.toEqual([workItem])
    await expect(service.getWorkItem(project.id, workItem.id)).resolves.toEqual(workItem)
    await expect(service.updateWorkItem(project.id, workItem.id, { title: 'Update project service' })).resolves.toMatchObject({
      title: 'Update project service'
    })
    await expect(service.listActivity(project.id)).resolves.toContainEqual(
      expect.objectContaining({ eventType: 'work_item_created', workItemId: workItem.id })
    )
    await service.deleteWorkItem(project.id, workItem.id)
    await expect(service.listWorkItems(project.id)).resolves.toEqual([])
  })

  it('reports unregistered projects instead of silently operating on a path', async () => {
    const { service } = await createService()

    await expect(service.getProject('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(service.detachProject('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(service.createWorkItem('missing', { title: 'No project' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND'
    })
  })

  it('routes artifact mutations and reads through the selected project', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Workstack' })
    const workItem = await service.createWorkItem(project.id, { title: 'Attach context' })
    const sourcePath = path.join(directory, 'context.txt')
    await fs.writeFile(sourcePath, 'context')

    const fileAttachment = await service.attachFile(project.id, workItem.id, { sourcePath })
    const byteAttachment = await service.attachBytes(project.id, workItem.id, {
      data: Buffer.from('bytes'),
      originalFilename: 'bytes.txt'
    })
    const pastedAttachment = await service.pasteImage(project.id, workItem.id, {
      data: Buffer.from([137, 80, 78, 71]),
      originalFilename: 'clipboard.png',
      mimeType: 'image/png'
    })
    expect(await service.listAttachments(project.id, workItem.id)).toEqual([
      fileAttachment,
      byteAttachment,
      pastedAttachment
    ])
    await expect(service.readAttachment(project.id, workItem.id, pastedAttachment.id)).resolves.toMatchObject({
      attachment: pastedAttachment,
      data: Buffer.from([137, 80, 78, 71])
    })
    await service.removeAttachment(project.id, workItem.id, fileAttachment.id)
    await expect(service.listAttachments(project.id, workItem.id)).resolves.toEqual([byteAttachment, pastedAttachment])
  })

  it('exposes active claims for observation and safe human release', async () => {
    const { service, directory } = await createService()
    const rootPath = path.join(directory, 'project')
    const project = await service.createProject({ rootPath, name: 'Workstack' })
    const workItem = await service.createWorkItem(project.id, { title: 'Coordinate agent work' })
    const store = await ProjectStore.open(rootPath)
    const claim = new ClaimsRepository(store, { token: () => 'service-claim-token' }).claim(workItem.id, {
      agentId: 'codex',
      agentDisplayName: 'Codex',
      sessionId: 'service-session'
    })
    store.close()

    await expect(service.listActiveClaims(project.id)).resolves.toEqual([claim.claim])
    await expect(service.getActiveClaim(project.id, workItem.id)).resolves.toEqual(claim.claim)
    await expect(
      service.forceReleaseWorkItem(project.id, workItem.id, { actorId: 'human', reason: 'Reassigned from the app' })
    ).resolves.toMatchObject({ state: 'released', releaseReason: 'Reassigned from the app' })
    await expect(service.getActiveClaim(project.id, workItem.id)).resolves.toBeUndefined()
  })

  it('routes agent-owned claim mutations through the selected project', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Workstack' })
    const releasable = await service.createWorkItem(project.id, { title: 'Agent claim lifecycle' })
    const completion = await service.createWorkItem(project.id, { title: 'Agent completion lifecycle' })

    const firstClaim = await service.claimWorkItem(project.id, releasable.id, { agentId: 'codex', sessionId: 'one' })
    await expect(service.heartbeatWorkItem(project.id, releasable.id, firstClaim.claimToken)).resolves.toMatchObject({
      state: 'active'
    })
    await expect(
      service.blockWorkItem(project.id, releasable.id, firstClaim.claimToken, { reason: 'Waiting', retainClaim: true })
    ).resolves.toMatchObject({ blockedReason: 'Waiting' })
    await expect(service.releaseWorkItem(project.id, releasable.id, firstClaim.claimToken, 'Stopped')).resolves.toMatchObject({
      state: 'released'
    })

    const secondClaim = await service.claimWorkItem(project.id, completion.id, { agentId: 'codex', sessionId: 'two' })
    await expect(
      service.completeWorkItem(project.id, completion.id, secondClaim.claimToken, { summaryMarkdown: 'Finished.' })
    ).resolves.toMatchObject({ workItemId: completion.id, completedBySessionId: 'two' })
    await expect(service.getCompletion(project.id, completion.id)).resolves.toMatchObject({ summaryMarkdown: 'Finished.' })
  })

  it('routes knowledge evidence and search through the selected project', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Knowledge' })
    const source = await service.addKnowledgeSource(project.id, {
      displayName: 'Data model',
      filename: 'data-model.md',
      content: 'The project persists ownership through SQLite lease records.'
    })

    await expect(service.listKnowledgeSources(project.id)).resolves.toEqual([source])
    await expect(service.searchKnowledge(project.id, 'SQLite ownership')).resolves.toMatchObject([
      { sourceId: source.id, title: 'Data model' }
    ])
    await expect(service.processKnowledgeJob(project.id)).resolves.toBeUndefined()
    await expect(service.retryKnowledgeJobs(project.id)).resolves.toBe(0)
    await expect(service.saveWikiArticle(project.id, 'architecture', '# Architecture')).resolves.toMatchObject({ slug: 'architecture' })
    await expect(service.listWikiArticles(project.id)).resolves.toContainEqual({ slug: 'architecture', content: '# Architecture' })
    const backlog = await service.createWorkItem(project.id, { title: 'Apply SQLite ownership' })
    await expect(service.retrieveKnowledge(project.id, 'SQLite ownership')).resolves.toMatchObject({
      query: 'SQLite ownership',
      results: expect.arrayContaining([
        expect.objectContaining({ sourceId: `raw:${source.id}`, sourceType: 'raw_source' }),
        expect.objectContaining({ sourceId: `backlog:${backlog.id}`, sourceType: 'backlog' })
      ]),
      groups: expect.arrayContaining([
        expect.objectContaining({ sourceType: 'raw_source' }),
        expect.objectContaining({ sourceType: 'backlog' })
      ])
    })
  })

  it('routes explicit planning proposal conversion through the selected project', async () => {
    const { service, directory } = await createService()
    const project = await service.createProject({ rootPath: path.join(directory, 'project'), name: 'Planning' })
    const proposal = await service.createPlanningSession(project.id)
    await expect(service.getPlanningProposal(project.id, proposal.planningSessionId)).resolves.toEqual(proposal)
    await expect(service.addPlanningMessage(project.id, proposal.planningSessionId, 'user', 'Need a durable plan.')).resolves.toMatchObject({
      role: 'user'
    })
    await expect(service.listPlanningMessages(project.id, proposal.planningSessionId)).resolves.toMatchObject([{ contentMarkdown: 'Need a durable plan.' }])
    const attachment = await service.attachPlanningBytes(project.id, proposal.planningSessionId, {
      data: Buffer.from('planning evidence'),
      originalFilename: 'planning.txt',
      mimeType: 'text/plain'
    })
    const pastedAttachment = await service.pastePlanningImage(project.id, proposal.planningSessionId, {
      data: Buffer.from([137, 80, 78, 71]),
      originalFilename: 'planning.png',
      mimeType: 'image/png'
    })
    await expect(service.listPlanningAttachments(project.id, proposal.planningSessionId)).resolves.toEqual([attachment, pastedAttachment])
    const context = await service.getPlanningContext(project.id, proposal.planningSessionId, 'durable')
    expect(context.project).toMatchObject({ name: 'Planning' })
    expect(context.planningAttachments).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'planning.txt' })]))
    await expect(service.readPlanningAttachment(project.id, proposal.planningSessionId, attachment.id)).resolves.toMatchObject({
      attachment,
      data: Buffer.from('planning evidence')
    })
    await service.removePlanningAttachment(project.id, proposal.planningSessionId, attachment.id)
    await service.removePlanningAttachment(project.id, proposal.planningSessionId, pastedAttachment.id)
    await expect(service.listPlanningAttachments(project.id, proposal.planningSessionId)).resolves.toEqual([])
    await expect(
      service.updatePlanningProposal(project.id, proposal.planningSessionId, {
        title: 'Create a plan',
        acceptanceCriteriaMarkdown: '- [ ] User confirms conversion'
      })
    ).resolves.toMatchObject({ title: 'Create a plan' })
    await expect(service.convertPlanningProposal(project.id, proposal.planningSessionId)).resolves.toMatchObject({
      title: 'Create a plan',
      source: 'ai_plan'
    })
  })

  it('detects a registry entry whose project identity no longer matches the on-disk project', async () => {
    const { service, directory } = await createService()
    const first = await service.createProject({ rootPath: path.join(directory, 'first'), name: 'First' })
    const second = await service.createProject({ rootPath: path.join(directory, 'second'), name: 'Second' })
    const registry = new ProjectRegistry(path.join(directory, 'registry.json'))
    const secondProject = await service.getProject(second.id)

    await registry.detach(first.id)
    await registry.detach(second.id)
    await registry.register({
      ...secondProject,
      id: first.id
    })

    await expect(service.getProject(first.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })
})

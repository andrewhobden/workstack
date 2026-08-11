import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore, projectPaths } from '../../src/core/project-store'
import { ProjectsService } from '../../src/core/projects-service'
import { ClaimsRepository } from '../../src/core/claims'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createService(): Promise<{ service: ProjectsService; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-service-'))
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
    await expect(stat(projectPaths(rootPath).projectPath)).resolves.toBeDefined()
    await expect(service.listProjects()).resolves.toEqual([])
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
    await writeFile(sourcePath, 'context')

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

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectStore } from '../../src/core/project-store'
import { KnowledgeDeliveryOutbox } from '../../src/core/knowledge-delivery'
import { dispatchKnowledgeDeliveries } from '../../src/main/knowledge-delivery'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('recovers enqueue failure after completed-task restart and delivers one logical merge event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-delivery-')); roots.push(root)
  const projects = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
  const project = await projects.createProject({ rootPath: path.join(root, 'project'), name: 'Delivery' })
  const item = await projects.createWorkItem(project.id, { title: 'Merged work' })
  const claim = await projects.claimWorkItem(project.id, item.id, { agentId: 'agent' })
  const url = 'https://github.com/example/project/pull/12'
  await projects.completeWorkItem(project.id, item.id, claim.claimToken, { summaryMarkdown: 'Delivered evidence', prUrl: url })
  await projects.reconcilePullRequestWorkItem(project.id, item.id, url, 'MERGED')
  const pullRequest = { state: 'MERGED', url, number: 12, title: 'Merged work', headRefName: 'feature', mergeCommit: { oid: 'abc123' }, mergedAt: new Date().toISOString() }
  const lookup = vi.fn(async () => pullRequest)
  const failed = { handleMergedPullRequest: vi.fn(async () => { throw new Error('Temporarily unavailable') }) }
  await dispatchKnowledgeDeliveries(projects, project.id, failed, lookup)
  let store = await ProjectStore.open(project.rootPath)
  let outbox = new KnowledgeDeliveryOutbox(store)
  expect(outbox.list()).toEqual([expect.objectContaining({ status: 'failed', attempts: 1, errorMessage: 'Temporarily unavailable' })])
  expect((await projects.getWorkItem(project.id, item.id)).status).toBe('completed')
  outbox.retry(outbox.list()[0].id)
  store.close()
  const handler = { handleMergedPullRequest: vi.fn(async () => {}) }
  await dispatchKnowledgeDeliveries(projects, project.id, handler, lookup)
  await dispatchKnowledgeDeliveries(projects, project.id, handler, lookup)
  store = await ProjectStore.open(project.rootPath); outbox = new KnowledgeDeliveryOutbox(store)
  expect(outbox.list()).toEqual([expect.objectContaining({ status: 'completed' })])
  expect(handler.handleMergedPullRequest).toHaveBeenCalledOnce()
  expect(lookup).toHaveBeenCalledTimes(2)
  expect(() => outbox.retry(outbox.list()[0].id)).toThrow('Only failed')
  store.close()
})

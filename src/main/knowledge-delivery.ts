import { KnowledgeDeliveryOutbox } from '../core/knowledge-delivery'
import { ProjectStore } from '../core/project-store'
import type { ProjectsService } from '../core/projects-service'
import type { MergedPullRequestHandler } from './pull-requests'
import { WorkstackError } from '../core/errors'

export type DeliveredPullRequest = Parameters<MergedPullRequestHandler['handleMergedPullRequest']>[0]['pullRequest'] & { state: string }

/** Delivery may run again after a crash; the receiving wiki job is deduplicated by merge identity. */
export async function dispatchKnowledgeDeliveries(projects: ProjectsService, projectId: string, handler: MergedPullRequestHandler, lookup: (url: string, root: string) => Promise<DeliveredPullRequest>): Promise<void> {
  const project = await projects.getProject(projectId)
  const store = await ProjectStore.open(project.rootPath)
  try {
    const outbox = new KnowledgeDeliveryOutbox(store)
    for (let count = 0; count < 50; count += 1) {
      const event = outbox.claimNext()
      if (!event) return
      try {
        const pullRequest = await lookup(event.prUrl, project.rootPath)
        if (pullRequest.url.replace(/\/$/, '') !== event.prUrl.replace(/\/$/, '') || pullRequest.state !== 'MERGED' || !pullRequest.mergeCommit?.oid) throw new WorkstackError('VALIDATION_ERROR', 'Merged pull request evidence is unavailable or does not match this delivery.')
        await handler.handleMergedPullRequest({ projectId, workItemId: event.workItemId, pullRequest })
        outbox.complete(event.id, event.owner!)
      } catch (error) {
        outbox.fail(event.id, event.owner!, error, !(error instanceof WorkstackError && error.code === 'VALIDATION_ERROR'))
      }
    }
  } finally { store.close() }
}

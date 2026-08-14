import { describe, expect, it } from 'vitest'
import {
  createProjectInputSchema,
  deleteProjectInputSchema,
  createWorkItemInputSchema,
  binaryAttachmentInputSchema,
  planningAttachmentInputSchema,
  forceReleaseWorkItemInputSchema,
  knowledgeChatMessageInputSchema,
  knowledgeChatPendingActionReferenceSchema,
  knowledgeChatSessionReferenceSchema,
  knowledgeRetrievalInputSchema,
  launchCopilotInputSchema,
  planningProposalInputSchema,
  planningSessionReferenceSchema,
  updateProjectInputSchema,
  updateWorkItemInputSchema,
  updateWorkerHandoffInputSchema,
  wikiAutomationRescanInputSchema,
  wikiAutomationJobReferenceSchema,
  workItemFiltersSchema,
  workItemReferenceSchema
} from '../../src/contracts/desktop'

const projectId = '5f03c679-76e8-4ea8-a8bc-9ec31f367a76'
const workItemId = 'cbdc9e0c-80b4-4d76-89fd-61e0922cfb8f'

describe('desktop IPC contracts', () => {
  it('accepts valid project and work-item payloads', () => {
    expect(createProjectInputSchema.parse({ rootPath: '/tmp/workstack', name: 'Workstack', workItemPrefix: 'WS' })).toMatchObject({
      name: 'Workstack'
    })
    expect(updateProjectInputSchema.parse({
      projectId,
      name: 'Updated',
      settings: { heartbeatSeconds: 120, autoUpdateKnowledgeOnCompletion: false, copilotLaunchPrompt: 'Claim the selected work item.' }
    })).toMatchObject({ projectId, settings: { heartbeatSeconds: 120, autoUpdateKnowledgeOnCompletion: false, copilotLaunchPrompt: 'Claim the selected work item.' } })
    expect(deleteProjectInputSchema.parse({ projectId, confirmed: true })).toEqual({ projectId, confirmed: true })
    expect(createWorkItemInputSchema.parse({ projectId, title: 'Create work item' })).toMatchObject({
      projectId,
      title: 'Create work item'
    })
    expect(workItemReferenceSchema.parse({ projectId, workItemId })).toMatchObject({ projectId, workItemId })
    expect(launchCopilotInputSchema.parse({ projectId, workItemId, prompt: 'Claim this item.' })).toMatchObject({
      prompt: 'Claim this item.'
    })
    expect(updateWorkItemInputSchema.parse({ projectId, workItemId, priority: 'high' })).toMatchObject({
      priority: 'high'
    })
    expect(forceReleaseWorkItemInputSchema.parse({ projectId, workItemId, reason: 'Agent stopped responding' })).toMatchObject({
      reason: 'Agent stopped responding'
    })
    expect(updateWorkerHandoffInputSchema.parse({ projectId, workItemId, sessionSummaryMarkdown: 'Resume from the current worktree.' })).toMatchObject({
      sessionSummaryMarkdown: 'Resume from the current worktree.'
    })
    expect(workItemFiltersSchema.parse({ status: 'backlog', limit: 10 })).toMatchObject({
      status: 'backlog',
      limit: 10
    })
    expect(knowledgeRetrievalInputSchema.parse({ projectId, query: 'atomic leases', limit: 10 })).toMatchObject({
      projectId,
      query: 'atomic leases',
      limit: 10
    })
    expect(wikiAutomationJobReferenceSchema.parse({ projectId, jobId: workItemId })).toMatchObject({ projectId, jobId: workItemId })
    expect(wikiAutomationRescanInputSchema.parse({ projectId })).toEqual({ projectId })
    expect(knowledgeChatSessionReferenceSchema.parse({ projectId, sessionId: workItemId })).toMatchObject({
      projectId,
      sessionId: workItemId
    })
    expect(knowledgeChatMessageInputSchema.parse({ projectId, sessionId: workItemId, contentMarkdown: 'How does this work?' })).toMatchObject({
      contentMarkdown: 'How does this work?'
    })
    expect(knowledgeChatPendingActionReferenceSchema.parse({ projectId, sessionId: workItemId, actionId: workItemId })).toMatchObject({
      actionId: workItemId
    })
    expect(planningProposalInputSchema.parse({
      projectId,
      sessionId: workItemId,
      title: 'Plan project-aware work',
      priority: 'normal',
      relatedReferences: ['knowledge/schema.md']
    })).toMatchObject({ title: 'Plan project-aware work' })
    expect(planningSessionReferenceSchema.parse({ projectId, sessionId: workItemId })).toMatchObject({ sessionId: workItemId })
    expect(planningAttachmentInputSchema.parse({
      projectId,
      sessionId: workItemId,
      data: new Uint8Array([112, 108, 97, 110]),
      originalFilename: 'planning.md',
      mimeType: 'text/markdown'
    })).toMatchObject({ originalFilename: 'planning.md' })
    expect(
      binaryAttachmentInputSchema.parse({
        projectId,
        workItemId,
        data: new Uint8Array([137, 80, 78, 71]),
        originalFilename: 'screenshot.png',
        mimeType: 'image/png'
      })
    ).toMatchObject({ originalFilename: 'screenshot.png' })
  })

  it('rejects untrusted or malformed payloads before they reach the core', () => {
    expect(() => createProjectInputSchema.parse({ rootPath: '', name: 'Workstack' })).toThrow()
    expect(() => createProjectInputSchema.parse({ rootPath: '/tmp/workstack', name: 'Workstack', extra: true })).toThrow()
    expect(() => updateProjectInputSchema.parse({ projectId: 'not-a-uuid' })).toThrow()
    expect(() => deleteProjectInputSchema.parse({ projectId, confirmed: false })).toThrow()
    expect(() => deleteProjectInputSchema.parse({ projectId, confirmed: true, extra: true })).toThrow()
    expect(() => updateProjectInputSchema.parse({ projectId, settings: { heartbeatSeconds: 10 } })).toThrow()
    expect(() => createWorkItemInputSchema.parse({ projectId, title: ' ', priority: 'urgent' })).toThrow()
    expect(() => workItemReferenceSchema.parse({ projectId, workItemId: '../unsafe' })).toThrow()
    expect(() => launchCopilotInputSchema.parse({ projectId, workItemId, prompt: ' ' })).toThrow()
    expect(() => updateWorkItemInputSchema.parse({ projectId, workItemId, status: 'completed' })).toThrow()
    expect(() => forceReleaseWorkItemInputSchema.parse({ projectId, workItemId, reason: ' ', actorId: 'unexpected' })).toThrow()
    expect(() => updateWorkerHandoffInputSchema.parse({ projectId, workItemId, sessionSummaryMarkdown: 'x'.repeat(20_001) })).toThrow()
    expect(() => planningProposalInputSchema.parse({ projectId, sessionId: 'not-a-uuid', priority: 'urgent' })).toThrow()
    expect(() => planningAttachmentInputSchema.parse({ projectId, sessionId: workItemId, data: [], originalFilename: 'notes.txt', extra: true })).toThrow()
    expect(() => workItemFiltersSchema.parse({ limit: 101 })).toThrow()
    expect(() => knowledgeRetrievalInputSchema.parse({ projectId, query: ' ', limit: 101 })).toThrow()
    expect(() => wikiAutomationJobReferenceSchema.parse({ projectId, jobId: '../unsafe' })).toThrow()
    expect(() => wikiAutomationRescanInputSchema.parse({ projectId: 'not-a-uuid' })).toThrow()
    expect(() => knowledgeChatSessionReferenceSchema.parse({ projectId, sessionId: 'not-a-uuid' })).toThrow()
    expect(() => knowledgeChatMessageInputSchema.parse({ projectId, sessionId: workItemId, contentMarkdown: ' ' })).toThrow()
    expect(() => knowledgeChatPendingActionReferenceSchema.parse({ projectId, sessionId: workItemId, actionId: '../unsafe' })).toThrow()
    expect(() => binaryAttachmentInputSchema.parse({ projectId, workItemId, data: [], originalFilename: 'x.png' })).toThrow()
  })
})

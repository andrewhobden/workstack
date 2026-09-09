import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'
import type { Attachment, WorkItem } from '../../src/core/types'
import { WorkstackMcpTools } from '../../src/mcp/server'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))) })

it('retains every approved field and original attachment in the reopened MCP task handoff', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-planning-handoff-'))
  roots.push(directory)
  const registryPath = path.join(directory, 'registry.json')
  const projects = new ProjectsService(new ProjectRegistry(registryPath))
  const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'Approved specification', workItemPrefix: 'SPEC' })
  const session = await projects.createPlanningSession(project.id)
  const proposal = await projects.updatePlanningProposal(project.id, session.planningSessionId, {
    title: 'Preserve approved evidence', type: 'feature', priority: 'high',
    descriptionMarkdown: 'Retain the complete task objective.', requirementsMarkdown: 'Never lose a required citation.',
    acceptanceCriteriaMarkdown: 'An agent reads exactly the approved bytes.', implementationContextMarkdown: 'Use immutable revisions and transactional associations.',
    relatedReferences: ['docs/context-design.md', 'https://example.test/design-record']
  })
  const bytes = Buffer.from('Approved implementation evidence.\nNo substitution is permitted.')
  const attachment = await projects.attachPlanningBytes(project.id, session.planningSessionId, { data: bytes, originalFilename: 'approved-context.txt', mimeType: 'text/plain', requestId: 'approved-evidence' })
  const task = await projects.convertPlanningProposal(project.id, session.planningSessionId)
  expect(await projects.convertPlanningProposal(project.id, session.planningSessionId)).toEqual(task)
  await projects.removePlanningAttachment(project.id, session.planningSessionId, attachment.id)
  const reopened = new ProjectsService(new ProjectRegistry(registryPath))
  const mcp = new WorkstackMcpTools(reopened)
  const handoff = await mcp.call('workstack_get_work_item_handoff', { project: project.name, work_item_id: task.displayId }) as { work_item: WorkItem; attachments: Attachment[] }
  expect(handoff.work_item).toMatchObject({
    id: task.id, title: proposal.title, type: proposal.type, priority: proposal.priority,
    acceptanceCriteriaMarkdown: proposal.acceptanceCriteriaMarkdown, originPlanningSessionId: session.planningSessionId, originPlanningRevision: proposal.revision
  })
  for (const content of [proposal.descriptionMarkdown, proposal.requirementsMarkdown, proposal.implementationContextMarkdown, ...proposal.relatedReferences]) {
    expect(handoff.work_item.descriptionMarkdown).toContain(content)
  }
  expect(handoff.attachments).toEqual([expect.objectContaining({ sha256: attachment.sha256, originalFilename: 'approved-context.txt' })])
  const stored = await readFile(path.join(project.rootPath, '.workstack', handoff.attachments[0].storedRelativePath))
  expect(stored).toEqual(bytes)
  expect(createHash('sha256').update(stored).digest('hex')).toBe(attachment.sha256)
  expect(await reopened.listWorkItems(project.id)).toHaveLength(1)
})

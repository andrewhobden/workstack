import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { PlanningRepository } from '../../src/core/planning'
import { ProjectStore } from '../../src/core/project-store'

const cleanupPaths: string[] = []
afterEach(async () => Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('PlanningRepository', () => {
  it('keeps manual proposal edits durable and converts only by explicit user action', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-planning-'))
    cleanupPaths.push(rootPath)
    const clock = new FrozenClock(new Date('2026-08-11T00:00:00.000Z'))
    const store = await ProjectStore.initialize({ rootPath, name: 'Planning' }, { clock })
    const planning = new PlanningRepository(store, { clock })
    const proposal = planning.createSession()
    expect(proposal.title).toBe('')
    expect(planning.listMessages(proposal.planningSessionId)).toEqual([])
    expect(planning.addMessage(proposal.planningSessionId, 'user', 'Preserve durable evidence.')).toMatchObject({
      role: 'user',
      contentMarkdown: 'Preserve durable evidence.'
    })
    expect(planning.listMessages(proposal.planningSessionId)).toMatchObject([{ role: 'user' }])
    expect(() => planning.addMessage(proposal.planningSessionId, 'assistant', ' ')).toThrow()
    expect(() => planning.getProposal('missing')).toThrow()
    expect(() => planning.convertToWorkItem(proposal.planningSessionId)).toThrow()
    const edited = planning.updateProposal(proposal.planningSessionId, {
      title: 'Plan durable knowledge',
      descriptionMarkdown: 'Preserve source evidence.',
      acceptanceCriteriaMarkdown: '- [ ] Search works'
    })
    expect(edited.userModifiedFields).toEqual(['title', 'descriptionMarkdown', 'acceptanceCriteriaMarkdown'])
    expect(planning.updateProposal(proposal.planningSessionId, { title: 'Ignored AI overwrite' }, false).title).toBe('Plan durable knowledge')
    const workItem = planning.convertToWorkItem(proposal.planningSessionId)
    expect(workItem).toMatchObject({ title: 'Plan durable knowledge', source: 'ai_plan', status: 'backlog' })
    expect(() => planning.convertToWorkItem(proposal.planningSessionId)).toThrow()
    expect(new PlanningRepository(store).createSession().planningSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    store.close()
  })
})

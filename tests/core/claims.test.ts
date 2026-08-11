import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ClaimsRepository } from '../../src/core/claims'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createClaimsRepository(tokens = ['claim-token-one', 'claim-token-two', 'claim-token-three']): Promise<{
  claims: ClaimsRepository
  clock: FrozenClock
  store: ProjectStore
  workItems: WorkItemRepository
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-claims-'))
  cleanupPaths.push(rootPath)
  const clock = new FrozenClock(new Date('2026-08-11T00:00:00.000Z'))
  const store = await ProjectStore.initialize({ rootPath, name: 'Claims', workItemPrefix: 'CLM' }, { clock })
  return {
    claims: new ClaimsRepository(store, {
      clock,
      token: () => {
        const token = tokens.shift()
        if (!token) {
          throw new Error('Test token sequence exhausted.')
        }
        return token
      }
    }),
    clock,
    store,
    workItems: new WorkItemRepository(store, { clock })
  }
}

function expectErrorCode(action: () => unknown, code: string): void {
  let received: unknown
  try {
    action()
  } catch (error) {
    received = error
  }
  expect(received).toMatchObject({ code })
}

describe('ClaimsRepository', () => {
  it('atomically claims backlog work with a hashed opaque token and durable history', async () => {
    const { claims, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Coordinate one agent' })

    const result = claims.claim(workItem.id, {
      agentId: 'codex',
      agentDisplayName: 'Codex',
      sessionId: 'session-42'
    })

    expect(result).toMatchObject({
      workItemId: workItem.id,
      claimToken: 'claim-token-one',
      recommendedHeartbeatSeconds: 300,
      claim: {
        workItemId: workItem.id,
        agentId: 'codex',
        agentDisplayName: 'Codex',
        sessionId: 'session-42',
        state: 'active',
        leaseExpiresAt: '2026-08-11T00:30:00.000Z'
      }
    })
    expect(result.claim).not.toHaveProperty('claimTokenHash')
    expect(claims.listActive()).toEqual([result.claim])
    expect(claims.health(result.claim)).toBe('healthy')
    expect(store.database.prepare('SELECT status FROM work_items WHERE id = ?').get(workItem.id)).toEqual({
      status: 'in_progress'
    })
    expect(store.database.prepare('SELECT claim_token_hash FROM work_claims WHERE work_item_id = ?').get(workItem.id)).not.toEqual({
      claim_token_hash: 'claim-token-one'
    })
    expect(claims.getActive(workItem.id)).toEqual(result.claim)
    expect(claims.listHistory(workItem.id)).toEqual([result.claim])
    expect(workItems.listActivity(workItem.id)).toContainEqual(
      expect.objectContaining({ eventType: 'work_item_claimed', actorType: 'agent', actorId: 'codex' })
    )
    await expect(readFile(path.join(store.paths.workItemsPath, workItem.id, 'work-item.md'), 'utf8')).resolves.toContain(
      'status: in_progress'
    )
    expectErrorCode(
      () => claims.claim(workItem.id, { agentId: 'other-agent' }),
      'WORK_ITEM_NOT_CLAIMABLE'
    )
    store.close()
  })

  it('renews only an active owner lease from trusted current time and rejects other tokens', async () => {
    const { claims, clock, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Heartbeat safely' })
    claims.claim(workItem.id, { agentId: 'codex' })
    clock.advance(10 * 60 * 1000)

    const renewed = claims.heartbeat(workItem.id, 'claim-token-one')

    expect(renewed).toMatchObject({
      lastHeartbeatAt: '2026-08-11T00:10:00.000Z',
      leaseExpiresAt: '2026-08-11T00:40:00.000Z',
      state: 'active'
    })
    expectErrorCode(() => claims.heartbeat(workItem.id, 'wrong-token'), 'CLAIM_TOKEN_INVALID')
    expectErrorCode(() => claims.release(workItem.id, 'wrong-token'), 'CLAIM_TOKEN_INVALID')
    expectErrorCode(
      () => claims.block(workItem.id, 'wrong-token', { reason: 'Missing access' }),
      'CLAIM_TOKEN_INVALID'
    )
    expect(workItems.listActivity(workItem.id).map((event) => event.eventType)).toContain('work_item_heartbeated')
    store.close()
  })

  it('expires a lease once, restores the backlog, and permanently invalidates the previous owner', async () => {
    const { claims, clock, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Reclaim expired work' })
    claims.claim(workItem.id, { agentId: 'first-agent' })
    clock.advance(30 * 60 * 1000)

    expect(claims.getActive(workItem.id)).toBeUndefined()
    expect(workItems.get(workItem.id).status).toBe('backlog')
    expect(claims.normalizeExpiredClaims()).toEqual([])
    expect(workItems.listActivity(workItem.id).filter((event) => event.eventType === 'work_item_claim_expired')).toHaveLength(1)
    expectErrorCode(() => claims.heartbeat(workItem.id, 'claim-token-one'), 'CLAIM_EXPIRED')

    const replacement = claims.claim(workItem.id, { agentId: 'second-agent' })
    expect(replacement.claimToken).toBe('claim-token-two')
    expectErrorCode(() => claims.release(workItem.id, 'claim-token-one'), 'CLAIM_EXPIRED')
    expect(claims.listHistory(workItem.id).map((claim) => claim.state)).toEqual(['active', 'expired'])
    store.close()
  })

  it('releases and force-releases claims without allowing stale ownership to return', async () => {
    const { claims, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Release agent work' })
    claims.claim(workItem.id, { agentId: 'first-agent' })

    const released = claims.release(workItem.id, 'claim-token-one', 'Agent stopped')
    expect(released).toMatchObject({ state: 'released', releaseReason: 'Agent stopped' })
    expect(workItems.get(workItem.id).status).toBe('backlog')
    expectErrorCode(() => claims.heartbeat(workItem.id, 'claim-token-one'), 'CLAIM_TOKEN_INVALID')

    claims.claim(workItem.id, { agentId: 'second-agent', agentDisplayName: 'Second Agent' })
    const forced = claims.forceRelease(workItem.id, { actorId: 'andrew', reason: 'Human reassigned this work' })
    expect(forced).toMatchObject({
      agentId: 'second-agent',
      state: 'released',
      releaseReason: 'Human reassigned this work'
    })
    expect(workItems.get(workItem.id).status).toBe('backlog')
    expect(workItems.listActivity(workItem.id)).toContainEqual(
      expect.objectContaining({ eventType: 'work_item_force_released', actorType: 'human', actorId: 'andrew' })
    )
    claims.claim(workItem.id, { agentId: 'third-agent' })
    expect(claims.forceRelease(workItem.id, { reason: 'Automated recovery' })).toMatchObject({
      state: 'released',
      releaseReason: 'Automated recovery'
    })
    expectErrorCode(() => claims.forceRelease(workItem.id, { reason: 'Again' }), 'INVALID_STATE_TRANSITION')
    store.close()
  })

  it('records a block as attention while retaining a lease or releases it when requested', async () => {
    const { claims, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Report blocked work' })
    claims.claim(workItem.id, { agentId: 'codex' })

    const attention = claims.block(workItem.id, 'claim-token-one', {
      reason: 'Waiting for repository access',
      retainClaim: true
    })
    expect(attention).toMatchObject({
      state: 'active',
      blockedReason: 'Waiting for repository access'
    })
    expect(claims.health(attention)).toBe('attention')
    expect(workItems.get(workItem.id).status).toBe('in_progress')

    const released = claims.block(workItem.id, 'claim-token-one', {
      reason: 'Cannot continue',
      retainClaim: false
    })
    expect(released).toMatchObject({
      state: 'released',
      blockedReason: 'Cannot continue',
      releaseReason: 'Cannot continue'
    })
    expect(workItems.get(workItem.id).status).toBe('backlog')
    expect(claims.listHistory(workItem.id)).toHaveLength(1)
    store.close()
  })

  it('applies requested lease policy and marks leases near expiry as attention', async () => {
    const { claims, clock, store, workItems } = await createClaimsRepository()
    const shortLease = workItems.create({ title: 'Use a short lease' })
    const cappedLease = workItems.create({ title: 'Cap a requested lease' })

    expect(claims.claim(shortLease.id, { agentId: 'codex', requestedLeaseSeconds: 60 }).leaseExpiresAt).toBe(
      '2026-08-11T00:01:00.000Z'
    )
    clock.advance(60_000)
    const capped = claims.claim(cappedLease.id, { agentId: 'other-agent', requestedLeaseSeconds: 7200 })
    expect(capped.leaseExpiresAt).toBe('2026-08-11T00:31:00.000Z')
    clock.advance(25 * 60 * 1000)
    expect(claims.health(claims.getActive(cappedLease.id)!)).toBe('attention')
    store.close()
  })

  it('uses secure production defaults when deterministic dependencies are not supplied', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-default-claims-'))
    cleanupPaths.push(rootPath)
    const store = await ProjectStore.initialize({ rootPath, name: 'Production claims' })
    const item = new WorkItemRepository(store).create({ title: 'Use secure defaults' })

    const result = new ClaimsRepository(store).claim(item.id, { agentId: 'production-agent' })

    expect(result.claim.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(result.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    store.close()
  })

  it('completes only the active owner transactionally and queues durable knowledge maintenance', async () => {
    const { claims, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Complete agent work' })
    claims.claim(workItem.id, { agentId: 'codex', sessionId: 'session-42' })

    const completion = claims.complete(workItem.id, 'claim-token-one', {
      summaryMarkdown: 'Implemented lease completion.',
      implementationNotesMarkdown: 'Added atomic state changes.',
      validationMarkdown: 'All tests passed.',
      filesChanged: ['src/core/claims.ts'],
      componentsChanged: ['claims'],
      commitSha: '81baf02',
      branch: 'workstack/complete-claims'
    })

    expect(completion).toMatchObject({
      workItemId: workItem.id,
      summaryMarkdown: 'Implemented lease completion.',
      filesChanged: ['src/core/claims.ts'],
      componentsChanged: ['claims'],
      completedByAgentId: 'codex',
      completedBySessionId: 'session-42'
    })
    expect(claims.getCompletion(workItem.id)).toEqual(completion)
    expect(workItems.get(workItem.id)).toMatchObject({ status: 'completed', completedAt: completion.createdAt })
    expect(workItems.list({ status: 'completed', query: 'lease completion' })).toMatchObject([
      { id: workItem.id }
    ])
    expect(claims.getActive(workItem.id)).toBeUndefined()
    expect(claims.listHistory(workItem.id)).toMatchObject([{ state: 'completed' }])
    expect(store.database.prepare('SELECT * FROM completion_records WHERE work_item_id = ?').get(workItem.id)).toMatchObject({
      summary_markdown: 'Implemented lease completion.',
      files_changed_json: '["src/core/claims.ts"]'
    })
    expect(store.database.prepare('SELECT kind, status FROM knowledge_sources WHERE source_work_item_id = ?').get(workItem.id)).toEqual({
      kind: 'work_completion',
      status: 'pending'
    })
    expect(store.database.prepare('SELECT status FROM knowledge_jobs').get()).toEqual({ status: 'pending' })
    expect(workItems.listActivity(workItem.id)).toContainEqual(
      expect.objectContaining({ eventType: 'work_item_completed', actorType: 'agent', actorId: 'codex' })
    )
    await expect(readFile(path.join(store.paths.workItemsPath, workItem.id, 'completion.md'), 'utf8')).resolves.toContain(
      'Implemented lease completion.'
    )
    expectErrorCode(
      () => claims.complete(workItem.id, 'claim-token-one', { summaryMarkdown: 'Retry' }),
      'CLAIM_TOKEN_INVALID'
    )
    store.close()
  })

  it('rejects expired or invalid completion payloads without changing the work item', async () => {
    const { claims, clock, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Reject stale completion' })
    claims.claim(workItem.id, { agentId: 'codex' })
    expect(() => claims.complete(workItem.id, 'claim-token-one', { summaryMarkdown: ' ' })).toThrow()
    expectErrorCode(
      () => claims.complete(workItem.id, 'wrong-token', { summaryMarkdown: 'No ownership' }),
      'CLAIM_TOKEN_INVALID'
    )
    clock.advance(30 * 60 * 1000)
    expectErrorCode(
      () => claims.complete(workItem.id, 'claim-token-one', { summaryMarkdown: 'Too late' }),
      'CLAIM_EXPIRED'
    )
    expect(workItems.get(workItem.id).status).toBe('backlog')
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM completion_records').get()).toEqual({ count: 0 })

    const minimal = workItems.create({ title: 'Complete without optional metadata' })
    claims.claim(minimal.id, { agentId: 'minimal-agent' })
    expect(claims.complete(minimal.id, 'claim-token-two', { summaryMarkdown: 'Minimal completion.' })).toMatchObject({
      commitSha: null,
      branch: null,
      prUrl: null,
      completedBySessionId: null
    })
    store.database.prepare('UPDATE completion_records SET files_changed_json = NULL, components_changed_json = NULL WHERE work_item_id = ?').run(minimal.id)
    expect(claims.getCompletion(minimal.id)).toMatchObject({ filesChanged: [], componentsChanged: [] })
    expect(claims.getCompletion(workItem.id)).toBeUndefined()
    await expect(readFile(path.join(store.paths.workItemsPath, minimal.id, 'completion.md'), 'utf8')).resolves.toContain(
      'session: \ncommit: '
    )
    store.close()
  })

  it('handles missing, invalid, and non-claimable work deterministically', async () => {
    const { claims, store, workItems } = await createClaimsRepository()
    const workItem = workItems.create({ title: 'Validate claim input' })
    store.database.prepare("UPDATE work_items SET status = 'completed' WHERE id = ?").run(workItem.id)

    expectErrorCode(() => claims.claim('missing', { agentId: 'codex' }), 'WORK_ITEM_NOT_FOUND')
    expectErrorCode(() => claims.claim(workItem.id, { agentId: 'codex' }), 'WORK_ITEM_NOT_CLAIMABLE')
    expect(() => claims.claim(workItem.id, { agentId: ' ' })).toThrow()
    expectErrorCode(() => claims.getActive('missing'), 'WORK_ITEM_NOT_FOUND')

    const releasable = workItems.create({ title: 'Release without a reason' })
    claims.claim(releasable.id, { agentId: 'codex' })
    expect(claims.release(releasable.id, 'claim-token-one')).toMatchObject({ releaseReason: null })
    store.close()
  })
})

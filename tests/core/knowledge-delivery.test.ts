import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenClock } from '../../src/core/clock'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'
import { ClaimsRepository } from '../../src/core/claims'
import { KnowledgeDeliveryOutbox } from '../../src/core/knowledge-delivery'

const stores: ProjectStore[] = []
const roots: string[] = []
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-outbox-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Outbox recovery' }); stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00Z'))
  const item = new WorkItemRepository(store, { clock }).create({ title: 'Merged delivery' })
  const claims = new ClaimsRepository(store, { clock })
  const claim = claims.claim(item.id, { agentId: 'agent' })
  const prUrl = 'https://github.com/example/project/pull/12'
  claims.complete(item.id, claim.claimToken, { summaryMarkdown: 'Merged evidence', prUrl })
  claims.reconcilePullRequest(item.id, prUrl, 'MERGED')
  return { root, store, clock, outbox: new KnowledgeDeliveryOutbox(store, clock) }
}

describe('durable knowledge delivery ownership', () => {
  it('fences concurrent and expired owners and leaves exhausted interrupted work explicitly retryable', async () => {
    const { root, store, clock, outbox } = await fixture()
    const otherStore = await ProjectStore.open(root); stores.push(otherStore)
    const other = new KnowledgeDeliveryOutbox(otherStore, clock)
    const eventId = outbox.list()[0].id
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const event = outbox.claimNext()!
      expect(event).toMatchObject({ id: eventId, status: 'running', attempts: attempt })
      expect(other.claimNext()).toBeUndefined()
      expect(() => other.complete(eventId, 'foreign-owner')).toThrow('no longer current')
      clock.advance(120_000)
      expect(() => outbox.complete(eventId, event.owner!)).toThrow('no longer current')
    }
    expect(other.claimNext()).toBeUndefined()
    expect(outbox.list()).toEqual([expect.objectContaining({ status: 'failed', attempts: 5, owner: null, leaseExpiresAt: null, nextAttemptAt: null, errorMessage: expect.stringContaining('interrupted attempts') })])
    expect(outbox.retry(eventId)).toMatchObject({ status: 'pending', attempts: 0 })
    const resumed = other.claimNext()!
    other.complete(eventId, resumed.owner!)
    expect(outbox.list()[0]).toMatchObject({ status: 'completed', errorMessage: null, nextAttemptAt: null })
    expect(() => outbox.complete(eventId, resumed.owner!)).toThrow('no longer current')
    expect(() => outbox.retry(eventId)).toThrow('Only failed')
    expect(store.database.prepare('SELECT status FROM work_items').get()).toEqual({ status: 'completed' })
  })

  it('preserves permanent errors, bounds transient retry and repairs legacy pending or missing-lease rows', async () => {
    const { store, clock, outbox } = await fixture()
    const first = outbox.claimNext()!
    outbox.fail(first.id, first.owner!, `api_key=privateValue ${'x'.repeat(2200)}`, false)
    expect(outbox.list()[0]).toMatchObject({ status: 'failed', nextAttemptAt: null })
    expect(outbox.list()[0].errorMessage).toContain('[REDACTED]')
    expect(outbox.list()[0].errorMessage?.length).toBe(2000)
    clock.advance(4_000_000)
    expect(outbox.claimNext()).toBeUndefined()
    outbox.retry(first.id)
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const event = outbox.claimNext()!
      outbox.fail(event.id, event.owner!, new Error('Transient provider outage'))
      expect(outbox.list()[0].nextAttemptAt).toBe(attempt < 5 ? new Date(clock.now().getTime() + 30 * 2 ** (attempt - 1) * 1000).toISOString() : null)
      expect(outbox.claimNext()).toBeUndefined()
      clock.advance(4_000_000)
    }
    expect(outbox.claimNext()).toBeUndefined()
    // An older build could leave this state forever hidden from both claim/retry.
    store.database.prepare("UPDATE knowledge_delivery_outbox SET status='pending' WHERE id=?").run(first.id)
    expect(outbox.claimNext()).toBeUndefined()
    expect(outbox.list()[0]).toMatchObject({ status: 'failed', attempts: 5, errorMessage: 'Transient provider outage' })
    outbox.retry(first.id)
    const interrupted = outbox.claimNext()!
    store.database.prepare('UPDATE knowledge_delivery_outbox SET lease_expires_at=NULL WHERE id=?').run(first.id)
    expect(() => outbox.fail(first.id, interrupted.owner!, 'late failure')).toThrow('no longer current')
    const replacement = outbox.claimNext()!
    expect(replacement.owner).not.toBe(interrupted.owner)
    outbox.complete(replacement.id, replacement.owner!)
    expect(() => outbox.retry(-1)).toThrow('not found')
  })
})

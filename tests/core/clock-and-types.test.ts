import { describe, expect, it } from 'vitest'
import { FrozenClock, systemClock } from '../../src/core/clock'
import {
  CLAIM_STATES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES
} from '../../src/core/types'

describe('deterministic time and domain constants', () => {
  it('freezes and advances time without exposing mutable state', () => {
    const clock = new FrozenClock(new Date('2026-08-11T00:00:00.000Z'))
    const firstRead = clock.now()

    clock.advance(30_000)

    expect(firstRead.toISOString()).toBe('2026-08-11T00:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-08-11T00:00:30.000Z')
    expect(systemClock.now()).toBeInstanceOf(Date)
  })

  it('defines the persisted domain vocabulary explicitly', () => {
    expect(WORK_ITEM_TYPES).toEqual(['feature', 'bug', 'chore'])
    expect(WORK_ITEM_PRIORITIES).toEqual(['high', 'normal', 'low'])
    expect(WORK_ITEM_STATUSES).toEqual(['backlog', 'in_progress', 'completed'])
    expect(WORK_ITEM_SOURCES).toEqual(['manual', 'ai_plan', 'mcp'])
    expect(CLAIM_STATES).toEqual(['active', 'released', 'expired', 'completed'])
  })
})

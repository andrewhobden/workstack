import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { KnowledgeRepository } from './knowledge'
import { ProjectStore } from './project-store'
import type {
  BlockWorkItemInput,
  ClaimHealth,
  ClaimWorkItemInput,
  ClaimWorkItemResult,
  ClaimState,
  CompletionInput,
  CompletionRecord,
  ForceReleaseInput,
  WorkClaim,
  WorkItem,
  WorkCheckpoint,
  WorkCheckpointInput
} from './types'
import { WorkItemRepository } from './work-items'
import { TaskDependenciesRepository } from './task-dependencies'
import { ContextPacketRepository } from './context-packets'

const claimInputSchema = z.object({
  contextPacketId: z.string().min(1).max(200).optional(),
  contextOverrideReason: z.string().trim().min(1).max(2000).optional(),
  agentId: z.string().trim().min(1),
  agentDisplayName: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  requestedLeaseSeconds: z.number().int().min(60).optional()
})

const blockInputSchema = z.object({
  reason: z.string().trim().min(1),
  retainClaim: z.boolean().default(false)
})

const forceReleaseInputSchema = z.object({
  actorId: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1)
})

const completionInputSchema = z.object({
  summaryMarkdown: z.string().trim().min(1),
  sessionSummaryMarkdown: z.string().default(''),
  implementationNotesMarkdown: z.string().default(''),
  validationMarkdown: z.string().default(''),
  knownLimitationsMarkdown: z.string().default(''),
  filesChanged: z.array(z.string().trim().min(1)).default([]),
  componentsChanged: z.array(z.string().trim().min(1)).default([]),
  commitSha: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  prUrl: z.string().url().nullable().optional()
})

const checkpointInputSchema = z.object({
  progressMarkdown: z.string().trim().min(1).max(8_000),
  filesChanged: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  validationMarkdown: z.string().max(8_000).default(''),
  questionsMarkdown: z.string().max(4_000).default(''),
  nextActionsMarkdown: z.string().max(4_000).default('')
}).strict()

const workerHandoffInputSchema = z.object({
  sessionSummaryMarkdown: z.string().max(20_000)
})

interface WorkClaimRow {
  id: string
  work_item_id: string
  agent_id: string
  agent_display_name: string | null
  session_id: string | null
  claim_token_hash: string
  claimed_at: string
  last_heartbeat_at: string
  lease_expires_at: string
  state: ClaimState
  release_reason: string | null
  blocked_reason: string | null
  released_at: string | null
  completed_at: string | null
}

interface CompletionRecordRow {
  pr_state: 'OPEN' | 'CLOSED' | 'MERGED' | null
  work_item_id: string
  summary_markdown: string
  session_summary_markdown: string
  implementation_notes_markdown: string
  validation_markdown: string
  known_limitations_markdown: string
  files_changed_json: string | null
  components_changed_json: string | null
  commit_sha: string | null
  branch: string | null
  pr_url: string | null
  completed_by_agent_id: string | null
  completed_by_session_id: string | null
  created_at: string
}

export class ClaimsRepository {
  private readonly workItems: WorkItemRepository

  constructor(
    private readonly store: ProjectStore,
    private readonly dependencies: { clock?: Clock; id?: () => string; token?: () => string } = {}
  ) {
    this.workItems = new WorkItemRepository(store, { clock: dependencies.clock, id: dependencies.id })
  }

  claim(workItemId: string, input: ClaimWorkItemInput): ClaimWorkItemResult {
    const parsed = claimInputSchema.parse(input)

    return this.immediate(() => {
      this.workItems.get(workItemId)
      const now = this.now()
      this.expireClaimsAt(now)
      new TaskDependenciesRepository(this.store, this.dependencies.clock).assertReady(workItemId)
      const context = new ContextPacketRepository(this.store, { clock: this.dependencies.clock })
      const packet = context.prepareLexical(workItemId, { packetId: parsed.contextPacketId, softOverrideReason: parsed.contextOverrideReason })
      context.assertReady(packet)
      const transitioned = this.store.database
        .prepare(
          `UPDATE work_items
           SET status = 'in_progress', attention_reason = NULL, updated_at = ?
           WHERE id = ? AND status = 'backlog'`
        )
        .run(now, workItemId)
      if (transitioned.changes !== 1) {
        throw new WorkstackError('WORK_ITEM_NOT_CLAIMABLE', 'The work item is not available to claim.')
      }

      const priorCompletion = this.getCompletion(workItemId)
      if (priorCompletion) {
        if (priorCompletion.prState !== 'CLOSED') {
          throw new WorkstackError('WORK_ITEM_NOT_CLAIMABLE', 'This work item has an unfinished pull request submission.')
        }
        this.archiveCompletion(priorCompletion, 'replacement_attempt')
        this.store.database.prepare('DELETE FROM completion_records WHERE work_item_id = ?').run(workItemId)
      }
      const leaseSeconds = Math.min(
        parsed.requestedLeaseSeconds ?? this.store.project.settings.defaultLeaseSeconds,
        this.store.project.settings.defaultLeaseSeconds
      )
      const token = this.createToken()
      const claim: WorkClaim = {
        id: this.createId(),
        workItemId,
        agentId: parsed.agentId,
        agentDisplayName: parsed.agentDisplayName ?? null,
        sessionId: parsed.sessionId ?? null,
        claimedAt: now,
        lastHeartbeatAt: now,
        leaseExpiresAt: addSeconds(now, leaseSeconds),
        state: 'active',
        releaseReason: null,
        blockedReason: null,
        releasedAt: null,
        completedAt: null
      }
      this.store.database
        .prepare(
          `INSERT INTO work_claims (
            id, work_item_id, agent_id, agent_display_name, session_id, claim_token_hash,
            claimed_at, last_heartbeat_at, lease_expires_at, state, release_reason,
            blocked_reason, released_at, completed_at
          ) VALUES (
            @id, @workItemId, @agentId, @agentDisplayName, @sessionId, @claimTokenHash,
            @claimedAt, @lastHeartbeatAt, @leaseExpiresAt, @state, @releaseReason,
            @blockedReason, @releasedAt, @completedAt
          )`
        )
        .run({ ...claim, claimTokenHash: hashToken(token) })
      this.workItems.recordActivity('work_item_claimed', 'agent', claim.agentId, workItemId, {
        agentDisplayName: claim.agentDisplayName,
        sessionId: claim.sessionId,
        leaseExpiresAt: claim.leaseExpiresAt
      })
      this.syncWorkItemMirror(workItemId)
      context.recordUsage(packet.id, 'claim', claim.agentId, null, claim.id)
      return {
        contextPacketId: packet.id,
        workItemId,
        claimToken: token,
        leaseExpiresAt: claim.leaseExpiresAt,
        recommendedHeartbeatSeconds: Math.min(this.store.project.settings.heartbeatSeconds, Math.max(1, Math.floor(leaseSeconds / 3))),
        claim
      }
    })
  }

  getActive(workItemId: string): WorkClaim | undefined {
    return this.immediate(() => {
      this.workItems.get(workItemId)
      this.expireClaimsAt(this.now())
      return this.activeClaimFor(workItemId)
    })
  }

  listActive(): WorkClaim[] {
    return this.immediate(() => {
      this.expireClaimsAt(this.now())
      return this.store.database
        .prepare("SELECT * FROM work_claims WHERE state = 'active' ORDER BY lease_expires_at ASC, claimed_at ASC")
        .all()
        .map(toWorkClaim) as WorkClaim[]
    })
  }

  listHistory(workItemId: string): WorkClaim[] {
    return this.immediate(() => {
      this.workItems.get(workItemId)
      this.expireClaimsAt(this.now())
      return this.store.database
        .prepare('SELECT * FROM work_claims WHERE work_item_id = ? ORDER BY claimed_at DESC, id DESC')
        .all(workItemId)
        .map(toWorkClaim) as WorkClaim[]
    })
  }

  getCompletion(workItemId: string): CompletionRecord | undefined {
    this.workItems.get(workItemId)
    const row = this.store.database
      .prepare('SELECT * FROM completion_records WHERE work_item_id = ?')
      .get(workItemId) as CompletionRecordRow | undefined
    return row ? toCompletionRecord(row) : undefined
  }

  listCompletionHistory(workItemId: string): CompletionRecord[] {
    this.workItems.get(workItemId)
    return (this.store.database.prepare(
      'SELECT completion_json FROM completion_history WHERE work_item_id = ? ORDER BY archived_at DESC, rowid DESC'
    ).all(workItemId) as Array<{ completion_json: string }>).map((row) => JSON.parse(row.completion_json) as CompletionRecord)
  }

  saveCheckpoint(workItemId: string, claimToken: string, input: WorkCheckpointInput): WorkCheckpoint {
    const payload = checkpointInputSchema.parse(input)
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      const claim = this.requireActiveClaimOwner(workItemId, claimToken)
      const checkpoint: WorkCheckpoint = {
        ...payload, id: this.createId(), workItemId, claimId: claim.id,
        agentId: claim.agentId, sessionId: claim.sessionId, createdAt: this.now()
      }
      this.store.database.prepare(`INSERT INTO work_checkpoints
        (id, work_item_id, claim_id, agent_id, session_id, created_at, payload_json)
        VALUES (@id, @workItemId, @claimId, @agentId, @sessionId, @createdAt, @payloadJson)`)
        .run({ ...checkpoint, payloadJson: JSON.stringify(payload) })
      this.workItems.recordActivity('work_item_checkpoint_saved', 'agent', claim.agentId, workItemId, { checkpointId: checkpoint.id, claimId: claim.id })
      return checkpoint
    })
  }

  listCheckpoints(workItemId: string, limit = 20): WorkCheckpoint[] {
    this.workItems.get(workItemId)
    const boundedLimit = z.number().int().min(1).max(100).parse(limit)
    const rows = this.store.database.prepare(`SELECT * FROM work_checkpoints
      WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(workItemId, boundedLimit) as Array<{
        id: string; work_item_id: string; claim_id: string | null; agent_id: string | null;
        session_id: string | null; created_at: string; payload_json: string
      }>
    return rows.map((row) => ({ ...JSON.parse(row.payload_json), id: row.id, workItemId: row.work_item_id,
      claimId: row.claim_id, agentId: row.agent_id, sessionId: row.session_id, createdAt: row.created_at } as WorkCheckpoint))
  }

  recover(workItemId: string, input: ForceReleaseInput): WorkItem {
    const parsed = forceReleaseInputSchema.parse(input)
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      const item = this.workItems.get(workItemId)
      if (item.status === 'completed' || this.activeClaimFor(workItemId) || this.getCompletion(workItemId)?.prState === 'OPEN') {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'Recovery requires unfinished work without an active owner or open pull request.')
      }
      this.store.database.prepare("UPDATE work_items SET status = 'backlog', attention_reason = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), workItemId)
      this.workItems.recordActivity('work_item_recovered', 'human', parsed.actorId ?? null, workItemId, { reason: parsed.reason })
      this.syncWorkItemMirror(workItemId)
      return this.workItems.get(workItemId)
    })
  }

  updateWorkerHandoff(workItemId: string, input: { sessionSummaryMarkdown: string }): CompletionRecord {
    const parsed = workerHandoffInputSchema.parse(input)
    const completion = this.immediate(() => {
      this.workItems.get(workItemId)
      const existing = this.getCompletion(workItemId)
      if (!existing) {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'A worker handoff can only be added after a completion has been recorded.')
      }
      this.store.database
        .prepare('UPDATE completion_records SET session_summary_markdown = ? WHERE work_item_id = ?')
        .run(parsed.sessionSummaryMarkdown, workItemId)
      return { ...existing, sessionSummaryMarkdown: parsed.sessionSummaryMarkdown }
    })
    this.writeCompletionMirror(completion)
    return completion
  }

  heartbeat(workItemId: string, claimToken: string): WorkClaim {
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      const now = this.now()
      const claim = this.requireActiveClaimOwner(workItemId, claimToken)
      const grantedSeconds = Math.max(1, Math.floor((Date.parse(claim.leaseExpiresAt) - Date.parse(claim.lastHeartbeatAt)) / 1000))
      const leaseExpiresAt = addSeconds(now, Math.min(grantedSeconds, this.store.project.settings.defaultLeaseSeconds))
      this.store.database
        .prepare(
          `UPDATE work_claims
           SET last_heartbeat_at = ?, lease_expires_at = ?
           WHERE id = ? AND state = 'active'`
        )
        .run(now, leaseExpiresAt, claim.id)
      this.workItems.recordActivity('work_item_heartbeated', 'agent', claim.agentId, workItemId, { leaseExpiresAt })
      return { ...claim, lastHeartbeatAt: now, leaseExpiresAt }
    })
  }

  release(workItemId: string, claimToken: string, reason?: string): WorkClaim {
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      const now = this.now()
      const claim = this.requireActiveClaimOwner(workItemId, claimToken)
      const releaseReason = reason?.trim() || null
      const released = this.releaseClaim(claim, now, releaseReason)
      this.workItems.recordActivity('work_item_released', 'agent', claim.agentId, workItemId, { reason: releaseReason })
      this.syncWorkItemMirror(workItemId)
      return released
    })
  }

  forceRelease(workItemId: string, input: ForceReleaseInput): WorkClaim {
    const parsed = forceReleaseInputSchema.parse(input)
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      this.workItems.get(workItemId)
      const now = this.now()
      const claim = this.activeClaimFor(workItemId)
      if (!claim) {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'There is no active claim to release.')
      }
      const released = this.releaseClaim(claim, now, parsed.reason)
      this.workItems.recordActivity('work_item_force_released', 'human', parsed.actorId ?? null, workItemId, {
        reason: parsed.reason,
        releasedAgentId: claim.agentId
      })
      this.syncWorkItemMirror(workItemId)
      return released
    })
  }

  block(workItemId: string, claimToken: string, input: BlockWorkItemInput): WorkClaim {
    const parsed = blockInputSchema.parse(input)
    this.normalizeExpiredClaims()
    return this.immediate(() => {
      const now = this.now()
      const claim = this.requireActiveClaimOwner(workItemId, claimToken)
      if (parsed.retainClaim) {
        this.store.database.prepare('UPDATE work_claims SET blocked_reason = ? WHERE id = ?').run(parsed.reason, claim.id)
        this.workItems.recordActivity('work_item_blocked', 'agent', claim.agentId, workItemId, {
          reason: parsed.reason,
          retainedClaim: true
        })
        return { ...claim, blockedReason: parsed.reason }
      }

      const released = this.releaseClaim(claim, now, parsed.reason, parsed.reason)
      this.workItems.recordActivity('work_item_blocked', 'agent', claim.agentId, workItemId, {
        reason: parsed.reason,
        retainedClaim: false
      })
      this.syncWorkItemMirror(workItemId)
      return released
    })
  }

  complete(workItemId: string, claimToken: string, input: CompletionInput): CompletionRecord {
    const parsed = completionInputSchema.parse(input)
    this.normalizeExpiredClaims()
    const { completion, finalized } = this.immediate(() => {
      const now = this.now()
      const claim = this.requireActiveClaimOwner(workItemId, claimToken)
      const completion: CompletionRecord = {
        workItemId,
        summaryMarkdown: parsed.summaryMarkdown,
        sessionSummaryMarkdown: parsed.sessionSummaryMarkdown,
        implementationNotesMarkdown: parsed.implementationNotesMarkdown,
        validationMarkdown: parsed.validationMarkdown,
        knownLimitationsMarkdown: parsed.knownLimitationsMarkdown,
        filesChanged: parsed.filesChanged,
        componentsChanged: parsed.componentsChanged,
        commitSha: parsed.commitSha ?? null,
        branch: parsed.branch ?? null,
        prUrl: parsed.prUrl ?? null,
        prState: parsed.prUrl ? 'OPEN' : null,
        completedByAgentId: claim.agentId,
        completedBySessionId: claim.sessionId,
        createdAt: now
      }
      this.store.database
        .prepare(
          `INSERT INTO completion_records (
            work_item_id, summary_markdown, session_summary_markdown, implementation_notes_markdown, validation_markdown,
            known_limitations_markdown, files_changed_json, components_changed_json, commit_sha,
            branch, pr_url, pr_state, completed_by_agent_id, completed_by_session_id, created_at
          ) VALUES (
            @workItemId, @summaryMarkdown, @sessionSummaryMarkdown, @implementationNotesMarkdown, @validationMarkdown,
            @knownLimitationsMarkdown, @filesChangedJson, @componentsChangedJson, @commitSha,
            @branch, @prUrl, @prState, @completedByAgentId, @completedBySessionId, @createdAt
          )`
        )
        .run({
          ...completion,
          filesChangedJson: JSON.stringify(completion.filesChanged),
          componentsChangedJson: JSON.stringify(completion.componentsChanged)
        })
      this.store.database
        .prepare("UPDATE work_claims SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'active'")
        .run(now, claim.id)
      const finalized = !completion.prUrl
      if (finalized) {
        this.finalizeCompletion(completion, now)
      } else {
        this.workItems.recordActivity('work_item_submitted', 'agent', claim.agentId, workItemId, { prUrl: completion.prUrl })
      }
      this.syncWorkItemMirror(workItemId)
      return { completion, finalized }
    })
    this.writeCompletionMirror(completion)
    if (finalized && this.store.project.settings.autoUpdateKnowledgeOnCompletion) {
      new KnowledgeRepository(this.store, { clock: this.clock() }).processNextJob()
    }
    return completion
  }

  finalizeMergedPullRequest(workItemId: string): CompletionRecord {
    const item = this.workItems.get(workItemId)
    const completion = this.getCompletion(workItemId)
    if (item.status !== 'in_progress' || !completion?.prUrl) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', 'The work item is not awaiting a pull request merge.')
    }
    return this.reconcilePullRequest(workItemId, completion.prUrl, 'MERGED')
  }

  reconcilePullRequest(workItemId: string, prUrl: string, state: 'OPEN' | 'CLOSED' | 'MERGED'): CompletionRecord {
    const { completion, finalized } = this.immediate(() => {
      const item = this.workItems.get(workItemId)
      const existing = this.getCompletion(workItemId)
      if (!existing || existing.prUrl !== prUrl || this.activeClaimFor(workItemId)) {
        throw new WorkstackError('INVALID_STATE_TRANSITION', 'The pull request is no longer the current submission for this task.')
      }
      if (existing.prState === state || item.status === 'completed') return { completion: existing, finalized: false }
      const completion = { ...existing, prState: state }
      const now = this.now()
      this.store.database.prepare('UPDATE completion_records SET pr_state = ? WHERE work_item_id = ?').run(state, workItemId)
      if (state === 'MERGED') {
        // A closed submission can merge before a replacement claim starts.
        this.store.database.prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ? AND status = 'backlog'").run(workItemId)
        this.finalizeCompletion(completion, now)
      } else {
        this.store.database.prepare('UPDATE work_items SET status = ?, attention_reason = ?, updated_at = ? WHERE id = ?')
          .run(state === 'OPEN' ? 'in_progress' : 'backlog', state === 'CLOSED' ? 'Pull request closed without merging. Resume this task to create a new submission.' : null, now, workItemId)
      }
      this.workItems.recordActivity('work_item_pull_request_reconciled', 'system', null, workItemId, { prUrl, state })
      this.syncWorkItemMirror(workItemId)
      return { completion, finalized: state === 'MERGED' }
    })
    this.writeCompletionMirror(completion)
    if (finalized && this.store.project.settings.autoUpdateKnowledgeOnCompletion) {
      new KnowledgeRepository(this.store, { clock: this.clock() }).processNextJob()
    }
    return completion
  }

  normalizeExpiredClaims(): WorkClaim[] {
    return this.immediate(() => this.expireClaimsAt(this.now()))
  }

  health(claim: WorkClaim): ClaimHealth {
    if (claim.blockedReason) {
      return 'attention'
    }
    const remainingMilliseconds = new Date(claim.leaseExpiresAt).getTime() - this.clock().now().getTime()
    return remainingMilliseconds <= this.store.project.settings.heartbeatSeconds * 1000 ? 'attention' : 'healthy'
  }

  private requireActiveClaimOwner(workItemId: string, claimToken: string): WorkClaim {
    this.workItems.get(workItemId)
    const tokenHash = hashToken(claimToken)
    const claim = this.activeClaimFor(workItemId)
    if (claim) {
      const activeToken = this.store.database
        .prepare('SELECT claim_token_hash FROM work_claims WHERE id = ?')
        .get(claim.id) as { claim_token_hash: string }
      if (activeToken.claim_token_hash === tokenHash) {
        if (claim.leaseExpiresAt <= this.now()) throw new WorkstackError('CLAIM_EXPIRED', 'This claim lease has expired.')
        return claim
      }
    }

    const previous = this.store.database
      .prepare(
        `SELECT state FROM work_claims
         WHERE work_item_id = ? AND claim_token_hash = ?
         ORDER BY claimed_at DESC, id DESC
         LIMIT 1`
      )
      .get(workItemId, tokenHash) as { state: ClaimState } | undefined
    if (previous?.state === 'expired') {
      throw new WorkstackError('CLAIM_EXPIRED', 'This claim lease has expired.')
    }
    throw new WorkstackError('CLAIM_TOKEN_INVALID', 'The claim token does not own this active work item.')
  }

  private releaseClaim(
    claim: WorkClaim,
    now: string,
    releaseReason: string | null,
    blockedReason: string | null = claim.blockedReason
  ): WorkClaim {
    this.store.database
      .prepare(
        `UPDATE work_claims
         SET state = 'released',
             release_reason = ?,
             blocked_reason = ?,
             released_at = ?
         WHERE id = ? AND state = 'active'`
      )
      .run(releaseReason, blockedReason, now, claim.id)
    this.store.database
      .prepare(
        `UPDATE work_items
         SET status = 'backlog', attention_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`
      )
      .run(now, claim.workItemId)
    return {
      ...claim,
      state: 'released',
      releaseReason,
      blockedReason,
      releasedAt: now
    }
  }

  private expireClaimsAt(now: string): WorkClaim[] {
    const expired = this.store.database
      .prepare("SELECT * FROM work_claims WHERE state = 'active' AND lease_expires_at <= ? ORDER BY lease_expires_at ASC")
      .all(now)
      .map(toWorkClaim) as WorkClaim[]

    for (const claim of expired) {
      this.store.database
        .prepare("UPDATE work_claims SET state = 'expired' WHERE id = ? AND state = 'active'")
        .run(claim.id)
      this.store.database
        .prepare(
          `UPDATE work_items
           SET status = ?, attention_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'in_progress'`
        )
        .run(this.store.project.settings.autoReleaseExpiredClaims ? 'backlog' : 'in_progress',
          this.store.project.settings.autoReleaseExpiredClaims ? null : 'Claim expired. Manual recovery is required before this task can be claimed again.', now, claim.workItemId)
      this.workItems.recordActivity('work_item_claim_expired', 'system', null, claim.workItemId, {
        agentId: claim.agentId,
        leaseExpiresAt: claim.leaseExpiresAt
      })
      this.syncWorkItemMirror(claim.workItemId)
    }

    return expired.map((claim) => ({ ...claim, state: 'expired' }))
  }

  private activeClaimFor(workItemId: string): WorkClaim | undefined {
    const row = this.store.database
      .prepare("SELECT * FROM work_claims WHERE work_item_id = ? AND state = 'active'")
      .get(workItemId) as WorkClaimRow | undefined
    return row ? toWorkClaim(row) : undefined
  }

  private finalizeCompletion(completion: CompletionRecord, now: string): void {
    const transitioned = this.store.database
      .prepare(
        `UPDATE work_items
         SET status = 'completed', attention_reason = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`
      )
      .run(now, now, completion.workItemId)
    if (transitioned.changes !== 1) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', 'The work item cannot be completed.')
    }
    this.workItems.updateCompletionSearchDocument(
      completion.workItemId,
      [
        completion.summaryMarkdown,
        completion.sessionSummaryMarkdown,
        completion.implementationNotesMarkdown,
        completion.validationMarkdown,
        completion.knownLimitationsMarkdown,
        completion.filesChanged.join('\n'),
        completion.componentsChanged.join('\n')
      ].join('\n')
    )
    if (completion.prUrl && this.store.project.settings.autoUpdateKnowledgeOnCompletion) {
      this.store.database.prepare(`INSERT OR IGNORE INTO knowledge_delivery_outbox
        (event_key, work_item_id, pr_url, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?)`)
        .run(`merge:${completion.workItemId}:${completion.prUrl}`, completion.workItemId, completion.prUrl, now, now)
    }
    const sourceId = this.createId()
    this.store.database
      .prepare(
        `INSERT INTO knowledge_sources (
          id, kind, display_name, relative_or_external_location, source_work_item_id,
          status, created_at, updated_at
        ) VALUES (?, 'work_completion', ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        sourceId,
        `Completion: ${this.workItems.get(completion.workItemId).displayId}`,
        `work-items/${completion.workItemId}/completion.md`,
        completion.workItemId,
        now,
        now
      )
    this.store.database
      .prepare(
        `INSERT INTO knowledge_jobs (
          id, source_id, status, attempts, created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, ?, ?)`
      )
      .run(this.createId(), sourceId, now, now)
    this.workItems.recordActivity('work_item_completed', 'agent', completion.completedByAgentId, completion.workItemId, {
      commitSha: completion.commitSha,
      branch: completion.branch,
      knowledgeSourceId: sourceId
    })
  }

  private archiveCompletion(completion: CompletionRecord, reason: string): void {
    this.store.database.prepare('INSERT INTO completion_history (id, work_item_id, completion_json, archived_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(this.createId(), completion.workItemId, JSON.stringify(completion), this.now(), reason)
  }

  private syncWorkItemMirror(workItemId: string): void {
    this.workItems.syncMirror(this.workItems.get(workItemId))
  }

  private writeCompletionMirror(completion: CompletionRecord): void {
    const directory = path.join(this.store.paths.workItemsPath, completion.workItemId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'completion.md'), renderCompletionMirror(completion), 'utf8')
  }

  private immediate<T>(operation: () => T): T {
    return this.store.database.transaction(operation).immediate()
  }

  private now(): string {
    return this.clock().now().toISOString()
  }

  private clock(): Clock {
    return this.dependencies.clock ?? systemClock
  }

  private createId(): string {
    return (this.dependencies.id ?? randomUUID)()
  }

  private createToken(): string {
    return (this.dependencies.token ?? (() => randomBytes(32).toString('base64url')))()
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(new Date(timestamp).getTime() + seconds * 1000).toISOString()
}

function toWorkClaim(row: unknown): WorkClaim {
  const claim = row as WorkClaimRow
  return {
    id: claim.id,
    workItemId: claim.work_item_id,
    agentId: claim.agent_id,
    agentDisplayName: claim.agent_display_name,
    sessionId: claim.session_id,
    claimedAt: claim.claimed_at,
    lastHeartbeatAt: claim.last_heartbeat_at,
    leaseExpiresAt: claim.lease_expires_at,
    state: claim.state,
    releaseReason: claim.release_reason,
    blockedReason: claim.blocked_reason,
    releasedAt: claim.released_at,
    completedAt: claim.completed_at
  }
}

function toCompletionRecord(row: CompletionRecordRow): CompletionRecord {
  return {
    workItemId: row.work_item_id,
    summaryMarkdown: row.summary_markdown,
    sessionSummaryMarkdown: row.session_summary_markdown,
    implementationNotesMarkdown: row.implementation_notes_markdown,
    validationMarkdown: row.validation_markdown,
    knownLimitationsMarkdown: row.known_limitations_markdown,
    filesChanged: JSON.parse(row.files_changed_json ?? '[]') as string[],
    componentsChanged: JSON.parse(row.components_changed_json ?? '[]') as string[],
    commitSha: row.commit_sha,
    branch: row.branch,
    prUrl: row.pr_url,
    prState: row.pr_state,
    completedByAgentId: row.completed_by_agent_id,
    completedBySessionId: row.completed_by_session_id,
    createdAt: row.created_at
  }
}

function renderCompletionMirror(completion: CompletionRecord): string {
  return `---
work_item: ${completion.workItemId}
completed_at: ${completion.createdAt}
agent: ${completion.completedByAgentId}
session: ${completion.completedBySessionId ?? ''}
commit: ${completion.commitSha ?? ''}
---

# Completion
${completion.summaryMarkdown}

## Worker handoff
${completion.sessionSummaryMarkdown}

## Implementation notes
${completion.implementationNotesMarkdown}

## Validation
${completion.validationMarkdown}

## Known limitations
${completion.knownLimitationsMarkdown}
`
}

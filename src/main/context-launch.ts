import { ContextPacketRepository } from '../core/context-packets'
import { ProjectStore } from '../core/project-store'
import { captureContextRepository } from '../core/context-repository'
import { WorkstackError } from '../core/errors'
import { redactEvidence } from '../core/evidence-policy'
import type { ContextApproval, ContextPacket } from '../core/context-packet-contracts'
import type { ProjectMetadata, WorkItem } from '../core/types'

export interface PreparedContextLaunch { packetId: string; usageId: string; prompt: string }
export interface ContextLaunchBackend {
  prepare(project: ProjectMetadata, item: WorkItem, workspace: { path: string; branch: string }, kind: 'launch' | 'restart', prompt: string, approval?: ContextApproval): Promise<PreparedContextLaunch>
  revalidate(project: ProjectMetadata, prepared: PreparedContextLaunch): Promise<void>
  finish(project: ProjectMetadata, prepared: PreparedContextLaunch, state: 'started' | 'failed', reason?: string): Promise<void>
}

/** Production launches always persist evidence. Test doubles are an explicit constructor dependency. */
export class ContextLaunchService implements ContextLaunchBackend {
  async prepare(project: ProjectMetadata, item: WorkItem, workspace: { path: string; branch: string }, kind: 'launch' | 'restart', prompt: string, approval: ContextApproval = {}): Promise<PreparedContextLaunch> {
    return this.withRepository(project, async (packets, store) => {
      if (store.project.settings.agentExecutionProfile !== project.settings.agentExecutionProfile) throw new WorkstackError('INVALID_STATE_TRANSITION', 'The execution profile changed. Reload the task before starting.')
      const snapshot = captureContextRepository(store.project.rootPath, workspace)
      if (snapshot.kind !== 'git' || !snapshot.complete) throw new WorkstackError('VALIDATION_ERROR', 'Copilot needs a complete Git repository revision. Create an initial commit or repair repository access before starting.')
      const packet = await packets.preview(item.id, approval, snapshot)
      packets.assertReady(packet)
      this.verifyOwnership(store, packet, kind)
      const rendered = redactEvidence(`${prompt.trim()}\n\n${packet.launchMarkdown}\nPrepared worktree: ${workspace.path}\nPrepared branch: ${workspace.branch}\nUse workstack_get_work_item_handoff and workstack_get_context_packet for packet_id=${packet.id}. Read all required sections and referenced full evidence, then claim this exact work item using context_packet_id=${packet.id}. Save workstack_save_checkpoint after meaningful progress and before stopping, including files, validation, unresolved questions and next actions. Include an evidence-based session_summary_markdown when completing work.`)
      const usage = packets.recordUsage(packet.id, kind, 'local-operator', rendered)
      return { packetId: packet.id, usageId: usage.id, prompt: rendered }
    })
  }
  async revalidate(project: ProjectMetadata, prepared: PreparedContextLaunch): Promise<void> {
    return this.withRepository(project, async (packets, store) => {
      const packet = packets.get(prepared.packetId)
      const usage = packets.listUsage(packet.id).find((usage) => usage.id === prepared.usageId)
      if (!usage || usage.kind === 'claim' || usage.state !== 'prepared') throw new WorkstackError('INVALID_STATE_TRANSITION', 'This launch receipt is no longer pending.')
      packets.revalidate(packet.id, captureContextRepository(store.project.rootPath, packet.repository.workspace))
      this.verifyOwnership(store, packet, usage.kind)
    })
  }
  async finish(project: ProjectMetadata, prepared: PreparedContextLaunch, state: 'started' | 'failed', reason?: string): Promise<void> {
    return this.withRepository(project, async (packets) => packets.finishUsage(prepared.usageId, state, reason))
  }
  private verifyOwnership(store: ProjectStore, packet: ContextPacket, kind: 'launch' | 'restart'): void {
    const item = store.database.prepare('SELECT status FROM work_items WHERE id=?').get(packet.workItemId) as { status: string } | undefined
    const claim = store.database.prepare("SELECT id FROM work_claims WHERE work_item_id=? AND state='active' AND lease_expires_at>? ORDER BY claimed_at DESC LIMIT 1").get(packet.workItemId, new Date().toISOString()) as { id: string } | undefined
    if (!item || item.status === 'completed' || kind === 'launch' && (item.status !== 'backlog' || claim) || kind === 'restart' && claim && claim.id !== packet.ownership.activeClaimId) {
      throw new WorkstackError('INVALID_STATE_TRANSITION', 'Task ownership or completion changed. Refresh the task before starting another agent.')
    }
  }
  private async withRepository<T>(project: ProjectMetadata, operation: (packets: ContextPacketRepository, store: ProjectStore) => Promise<T>): Promise<T> {
    const store = await ProjectStore.open(project.rootPath)
    try {
      if (store.project.id !== project.id) throw new WorkstackError('PROJECT_NOT_FOUND', 'The context store belongs to a different project.')
      return await store.runInOperation(() => operation(new ContextPacketRepository(store), store))
    } finally { store.close() }
  }
}

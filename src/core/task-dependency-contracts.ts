import { z } from 'zod'
import type { CompletionRecord, WorkItemStatus } from './types'

export const taskDependenciesInputSchema = z.object({
  dependsOn: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  relatedTo: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  declaredPaths: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  declaredComponents: z.array(z.string().trim().min(1).max(200)).max(100).optional()
}).strict()

export type TaskDependenciesInput = z.infer<typeof taskDependenciesInputSchema>

export interface TaskReference {
  workItemId: string
  displayId: string
  title: string
  status: WorkItemStatus
}

export interface TaskPrerequisite extends TaskReference {
  satisfied: boolean
  reason: string | null
  outcome: {
    completion: CompletionRecord
    recordHash: string
    sourceRevisions: Array<{ sourceId: string; revisionId: string; contentHash: string }>
  } | null
}

export interface TaskReadiness {
  ready: boolean
  blockers: Array<{ workItemId: string; displayId: string; reason: string }>
}

export interface ActiveTaskOverlap extends TaskReference {
  agentId: string
  agentDisplayName: string | null
  sessionId: string | null
  claimId: string
  advisory: true
  evidence: Array<{
    kind: 'path' | 'component'
    selectedValue: string
    activeValue: string
    basis: 'declared' | 'checkpoint'
    checkpointId: string | null
  }>
}

export interface TaskCoordination {
  workItemId: string
  readiness: TaskReadiness
  prerequisites: TaskPrerequisite[]
  related: TaskReference[]
  declaredPaths: string[]
  declaredComponents: string[]
  activeOverlaps: ActiveTaskOverlap[]
}

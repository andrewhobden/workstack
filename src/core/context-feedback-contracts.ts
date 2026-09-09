import { z } from 'zod'

export const contextFeedbackInputSchema = z.object({
  workItemId: z.string().min(1).max(200), packetId: z.string().min(1).max(200),
  category: z.enum(['missing_context', 'incorrect_context', 'stale_context', 'citation', 'other']),
  note: z.string().trim().min(1).max(20_000), sourceIds: z.array(z.string().min(1).max(200)).max(100).default([]),
  actor: z.string().trim().min(1).max(200), authorKind: z.enum(['human', 'agent'])
}).strict()
export const contextFeedbackTriageSchema = z.object({
  expectedVersion: z.number().int().positive(), status: z.enum(['triaged', 'resolved', 'dismissed']),
  action: z.enum(['fixture', 'knowledge_correction', 'no_change']), target: z.string().trim().min(1).max(2000).optional(),
  actor: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(20_000)
}).strict()
export type ContextFeedbackInput = z.input<typeof contextFeedbackInputSchema>
export type ContextFeedbackTriage = z.infer<typeof contextFeedbackTriageSchema>
export interface ContextFeedback {
  id: string; workItemId: string; packetId: string; category: ContextFeedbackInput['category']; note: string
  sourceReferences: Array<{ sourceId: string; revisionId: string | null; packetRevisionId: string | null }>
  actor: string; authorKind: 'human' | 'agent'; status: 'proposed' | 'triaged' | 'resolved' | 'dismissed'
  action: 'fixture' | 'knowledge_correction' | 'no_change' | null; target: string | null; triageNote: string | null; triagedBy: string | null
  version: number; createdAt: string; updatedAt: string; trust: 'untrusted_reference'
}
export interface ContextFeedbackEvent { id: number; feedbackId: string; actor: string; note: string; createdAt: string; snapshot: ContextFeedback }

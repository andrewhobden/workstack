import { z } from 'zod'
import type { SourceCitation } from './source-catalog'

export type KnowledgeRecordKind = 'decision' | 'requirement' | 'risk'
export type KnowledgeRecordStatus = 'proposed' | 'accepted' | 'rejected' | 'active' | 'fulfilled' | 'withdrawn' | 'open' | 'mitigated' | 'closed' | 'superseded'
export type KnowledgeReference = { kind: 'source'; citation: SourceCitation } | { kind: 'file'; path: string } | { kind: 'work_item'; id: string } | { kind: 'entity'; id: string } | { kind: 'record'; id: string } | { kind: 'wiki'; slug: string }
export const sourceCitationSchema = z.object({
  sourceId: z.string().min(1).max(200), revisionId: z.string().min(1).max(200), passageId: z.string().min(1).max(200),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), normalizedHash: z.string().regex(/^[a-f0-9]{64}$/), passageHash: z.string().regex(/^[a-f0-9]{64}$/),
  headingTrail: z.array(z.string().max(2000)).max(100), startLine: z.number().int().positive().max(2_000_000), endLine: z.number().int().positive().max(2_000_000),
  startOffset: z.number().int().nonnegative().max(2_000_000), endOffset: z.number().int().positive().max(2_000_000), locator: z.string().min(1).max(4000)
})
export const knowledgeReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), citation: sourceCitationSchema }),
  z.object({ kind: z.literal('file'), path: z.string().trim().min(1).max(2000) }),
  z.object({ kind: z.literal('work_item'), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('entity'), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('record'), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('wiki'), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(200) })
])
export const recordStatuses: Record<KnowledgeRecordKind, readonly KnowledgeRecordStatus[]> = {
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  requirement: ['proposed', 'active', 'fulfilled', 'withdrawn', 'superseded'],
  risk: ['open', 'accepted', 'mitigated', 'closed', 'superseded']
}
export interface KnowledgeRecord {
  id: string; kind: KnowledgeRecordKind; title: string; status: KnowledgeRecordStatus; markdown: string; rationale: string
  references: KnowledgeReference[]; supersededBy?: string; confidence?: number; reviewDueAt?: string; lastReviewedAt?: string
  version: number; createdAt: string; updatedAt: string; current: boolean; readiness: 'ready' | 'needs_review' | 'historical'
  locator: string; trust: 'untrusted_reference'
}
export interface KnowledgeRecordInput {
  kind: KnowledgeRecordKind; title: string; status?: KnowledgeRecordStatus; markdown: string; rationale?: string
  references?: KnowledgeReference[]; confidence?: number; reviewDueAt?: string
}
export interface KnowledgeRecordUpdate extends Partial<Omit<KnowledgeRecordInput, 'kind' | 'confidence' | 'reviewDueAt'>> { expectedVersion: number; confidence?: number | null; reviewDueAt?: string | null }
export interface KnowledgeReview { id: string; recordId: string; actor: string; note: string; outcome: 'confirmed' | 'needs_changes'; reviewedAt: string; recordVersion: number }
export interface KnowledgeFinding {
  id: string; code: 'invalid_metadata' | 'missing_evidence' | 'broken_reference' | 'stale_evidence' | 'supersession_cycle' | 'review_due' | 'unresolved_decision' | 'review_requested'
  severity: 'error' | 'warning' | 'info'; recordId: string; locator: string; reason: string; action: string; reference?: KnowledgeReference
}
export interface KnowledgeRecordHistory { version: number; actor: string; reason: string; changedAt: string; snapshot: KnowledgeRecord }
export const knowledgeRecordInputSchema = z.object({
  kind: z.enum(['decision', 'requirement', 'risk']), title: z.string().trim().min(1).max(500),
  status: z.enum(['proposed', 'accepted', 'rejected', 'active', 'fulfilled', 'withdrawn', 'open', 'mitigated', 'closed', 'superseded']).optional(),
  markdown: z.string().trim().min(1).max(200_000), rationale: z.string().max(20_000).optional(),
  references: z.array(knowledgeReferenceSchema).max(200).optional(), confidence: z.number().min(0).max(1).optional(),
  reviewDueAt: z.string().datetime().optional()
})

import { z } from 'zod'
import type { SourceCitation } from './source-catalog'

export const contextCategories = ['task', 'repository', 'purpose', 'architecture', 'conventions', 'decisions', 'code', 'related_work', 'artifacts', 'checkpoint'] as const
export type ContextCategory = typeof contextCategories[number]
const categorySchema = z.enum(contextCategories)
export const contextSourcePinSchema = z.object({ sourceId: z.string().min(1).max(200), category: categorySchema }).strict()
export const contextPolicyInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  requirements: z.array(z.object({ category: categorySchema, severity: z.enum(['hard', 'soft']) }).strict()).max(10),
  sourcePins: z.array(contextSourcePinSchema).max(100),
  requiredRecordIds: z.array(z.string().min(1).max(200)).max(100),
  allowSoftOverride: z.boolean(),
  tokenBudget: z.number().int().min(4000).max(64000),
  operatorInstructions: z.string().max(2000)
}).strict()
export type ContextPolicyInput = z.infer<typeof contextPolicyInputSchema>
export interface ContextPolicy extends Omit<ContextPolicyInput, 'expectedVersion'> { version: number }
export const contextPreferencesInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  sourcePins: z.array(contextSourcePinSchema).max(100),
  excludedSourceIds: z.array(z.string().min(1).max(200)).max(200)
}).strict()
export type ContextPreferencesInput = z.infer<typeof contextPreferencesInputSchema>
export interface ContextPreferences extends Omit<ContextPreferencesInput, 'expectedVersion'> { version: number }
export const contextApprovalSchema = z.object({
  packetId: z.string().min(1).max(200).optional(),
  softOverrideReason: z.string().trim().min(1).max(2000).optional()
}).strict()
export type ContextApproval = z.infer<typeof contextApprovalSchema>
export interface ContextRepositorySnapshot {
  rootPath: string; kind: 'git' | 'directory'; head: string | null; branch: string | null
  workingTreeHash: string; complete: boolean; limitations: string[]
  workspace?: { path: string; branch: string; head: string | null; workingTreeHash: string }
}
export interface ContextGap {
  id: string; category: ContextCategory; severity: 'hard' | 'soft' | 'info'; reason: string; action: string; sourceId?: string; recordId?: string
}
export interface ContextSection {
  category: ContextCategory; title: string; state: 'included' | 'missing' | 'not_applicable'; markdown: string
  citations: SourceCitation[]; required: boolean; locator: string
}
export interface ContextPacket {
  schemaVersion: 1; id: string; projectId: string; workItemId: string; taskRevision: string; version: number; previousPacketId: string | null
  createdAt: string; fingerprint: string; policy: ContextPolicy; preferences: ContextPreferences
  repository: ContextRepositorySnapshot; sections: ContextSection[]
  ownership: { status: string; activeClaimId: string | null }
  manifest: Array<{ sourceId: string; revisionId: string; contentHash: string; normalizedHash: string }>
  recordVersions: Array<{ id: string; version: number; status: string }>
  artifacts: Array<{ id: string; filename: string; sha256: string; bytes: number; available: boolean; locator: string }>
  gaps: ContextGap[]; readiness: 'ready' | 'needs_attention' | 'building'; canExecute: boolean; softOverrideReason: string | null
  budget: { limit: number; used: number; estimator: 'utf8_bytes_upper_bound'; omissions: Array<{ category: ContextCategory; characters: number; reason: string; locator: string }> }
  retrieval: { mode: string; corpusRevision: string; configFingerprint: string; fallbackReason: string | null; query?: string; queryTruncated?: boolean; truncated?: boolean }
  launchMarkdown: string
}
export interface ContextPacketUsage { id: string; packetId: string; kind: 'launch' | 'restart' | 'claim'; state: 'prepared' | 'started' | 'failed'; actor: string; createdAt: string; updatedAt: string; reason: string | null; claimId: string | null; promptMarkdown: string | null }
export interface ContextSectionRead { packetId: string; category: ContextCategory; text: string; offset: number; totalCharacters: number; nextOffset: number | null; citations: SourceCitation[] }

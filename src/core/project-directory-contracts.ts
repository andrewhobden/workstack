import { z } from 'zod'
import { knowledgeReferenceSchema, type KnowledgeReference } from './knowledge-record-contracts'
import type { SourceCitation, SourceReadiness } from './source-catalog'

export interface ProjectEntity {
  id: string; kind: 'component' | 'term'; displayName: string; aliases: string[]; definition: string; references: KnowledgeReference[]
  status: 'active' | 'merged' | 'retired'; mergedInto?: string; version: number; createdAt: string; updatedAt: string
  locator: string; trust: 'untrusted_reference'
}
export interface ProjectEntityInput { kind: 'component' | 'term'; displayName: string; aliases?: string[]; definition: string; references?: KnowledgeReference[] }
export interface ProjectEntityUpdate extends Partial<Omit<ProjectEntityInput, 'kind'>> { expectedVersion: number }
export interface DirectoryLookup { query: string; match: 'exact' | 'ambiguous' | 'suggestion' | 'none'; candidates: ProjectEntity[] }
export interface ProjectMention {
  id: string; entityId?: string; candidateIds: string[]; surface: string; citation: SourceCitation; startOffset: number; endOffset: number
  resolution: 'resolved' | 'candidate' | 'dismissed'; historical: boolean; readiness: SourceReadiness; workItemId?: string
}
export interface ProjectEntityHistory { id: number; entityId: string; action: string; actor: string; reason: string; createdAt: string; snapshot: ProjectEntity }
export interface ProjectEntityDetail { entity: ProjectEntity; canonicalEntity: ProjectEntity; mentions: ProjectMention[]; history: ProjectEntityHistory[]; mentionsTruncated: boolean; mentionLimits: { returned: number; perSource: number } }
export const projectEntityInputSchema = z.object({
  kind: z.enum(['component', 'term']), displayName: z.string().trim().min(1).max(200), aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  definition: z.string().trim().min(1).max(20_000), references: z.array(knowledgeReferenceSchema).max(200).optional()
})

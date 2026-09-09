import type { SourceCitation } from './source-catalog'

export const KNOWLEDGE_RETRIEVAL_SOURCE_TYPES = ['wiki_article', 'raw_source', 'completed_work', 'backlog', 'knowledge_record', 'project_entity'] as const
export type KnowledgeRetrievalSourceType = (typeof KNOWLEDGE_RETRIEVAL_SOURCE_TYPES)[number]
export interface KnowledgeRetrievalResult {
  sourceId: string; sourceType: KnowledgeRetrievalSourceType; title: string; excerpt: string; location: string; relevance: number; workItemId?: string
  canonicalSourceId?: string; text?: string; citation?: SourceCitation; recordId?: string; entityId?: string
  provenance?: { revisionId: string; contentHash: string; locator: string; kind: 'passage' | 'task' | 'record' | 'entity' | 'legacy' }
  diagnostics?: { lexicalRank?: number; semanticRank?: number; semanticSimilarity?: number; exactIdentifier: boolean; rankingPolicy: string }
  trust?: 'untrusted_reference'
}
export interface KnowledgeRetrievalGroup { sourceType: KnowledgeRetrievalSourceType; label: string; results: KnowledgeRetrievalResult[] }
export interface ProjectKnowledgeRetrieval {
  query: string; results: KnowledgeRetrievalResult[]; groups: KnowledgeRetrievalGroup[]
  mode?: 'lexical' | 'hybrid'; fallbackReason?: string; corpusRevision?: string; configFingerprint?: string; truncated?: boolean
}
export interface KnowledgeRetrievalResponse extends ProjectKnowledgeRetrieval {
  mode: 'lexical' | 'hybrid'; corpusRevision: string; configFingerprint: string; truncated: boolean
}
export interface KnowledgeRetrievalOptions {
  limit?: number; sourceTypes?: KnowledgeRetrievalSourceType[]; workItemId?: string; maxCharacters?: number; signal?: AbortSignal
}
export const RETRIEVAL_POLICY = { version: 'workstack-rrf-v1', rankOffset: 60, lexicalWeight: 0.7, semanticWeight: 0.3, exactIdentifierBoost: 0.1, taskMatchBoost: 0.005, semanticMinimumSimilarity: 0.05, maxCandidates: 100, maxPerSource: 1 } as const
export function retrievalGroups(results: KnowledgeRetrievalResult[]): KnowledgeRetrievalGroup[] {
  const labels: Record<KnowledgeRetrievalSourceType, string> = { wiki_article: 'Wiki articles', raw_source: 'Raw sources', completed_work: 'Completed work', backlog: 'Backlog', knowledge_record: 'Decisions, requirements and risks', project_entity: 'Components and glossary' }
  return KNOWLEDGE_RETRIEVAL_SOURCE_TYPES.map((sourceType) => ({ sourceType, label: labels[sourceType], results: results.filter((result) => result.sourceType === sourceType) }))
}

import type { KnowledgeIntakeJob } from './knowledge-jobs'

export const SEMANTIC_LIMITS = { modelBytes: 8 * 1024 * 1024, vocabulary: 10_000, dimensions: 128, passages: 5_000, vectorCharacters: 8192, batch: 32, workerMilliseconds: 3_000, workerMemoryMiB: 128 } as const
export interface SemanticModel { path: string; modelId: string; version: string; hash: string; dimensions: number; vocabularySize: number }
export interface SemanticStatus { enabled: boolean; model?: SemanticModel; indexedPassages: number; eligiblePassages: number; truncated: boolean; busy: boolean; jobs: KnowledgeIntakeJob[]; limits: typeof SEMANTIC_LIMITS }

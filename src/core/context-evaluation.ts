import type { SourceCitation } from './source-catalog'
import type { ContextCategory } from './context-packet-contracts'

export interface ContextEvaluationSource { key: string; title: string; category: ContextCategory; text: string; path?: string; state?: 'stale' | 'unavailable'; generatedPrefixParagraphs?: number }
export interface ContextEvaluationCase {
  id: string; tags: string[]; query: string; task: string; expectedSources: string[]; mustRetrieve: string[]; forbiddenSources?: string[]
  mandatoryCategories: ContextCategory[]; expectedMissingCategories: ContextCategory[]; checkpoint?: boolean; offlinePin?: boolean
}
export interface ContextEvaluationCorpus {
  schemaVersion: 1; revision: string; description: string; review: { status: 'pending_human_review' | 'reviewed'; reviewer: string | null; note: string }
  largeCorpusDocuments: number; sources: ContextEvaluationSource[]; cases: ContextEvaluationCase[]
}
export interface ContextEvaluationHit { sourceKey: string; citation?: SourceCitation; citationValid: boolean; historical: boolean; excluded: boolean; foreign: boolean }
export interface ContextEvaluationSample {
  caseId: string; stage: string; status: 'available' | 'unavailable'; unavailableReason?: string; hits: ContextEvaluationHit[]
  presentation?: 'ranked' | 'sections'
  categories?: ContextCategory[]; missingCategories?: ContextCategory[]; canExecute?: boolean; tokenEstimate: number; latencyMs: number[]
  supersededCurrentRecords?: number
}
export interface ContextEvaluationScore {
  caseId: string; stage: string; status: 'available' | 'unavailable'; unavailableReason?: string
  recallAt10: number | null; reciprocalRank: number | null; evidenceCoverage: number | null; mandatoryCoverage: number | null; citationCorrectness: number | null
  staleInclusions: number; excludedInclusions: number; foreignInclusions: number; supersededCurrentRecords: number
  tokens: number; p50Ms: number | null; p95Ms: number | null; violations: string[]
}
export interface ContextEvaluationReport {
  schemaVersion: 1; corpusRevision: string; corpusHash: string; corpusReview: ContextEvaluationCorpus['review']; generatedAt: string
  tokenEstimator: 'utf8_bytes_upper_bound'; observations: ContextEvaluationSample[]
  semanticModel?: { modelId: string; version: string; hash: string; dimensions: number; indexedPassages: number; eligiblePassages: number; buildMs: number; budgetMs: number; complete: boolean }
  environment: { node: string; platform: string; architecture: string; cpu: string; sqlite: string; gitRevision: string | null; gitWorkingTreeDirty: boolean | null }
  index: { sources: number; passages: number; sourceCharacters: number; databaseBytes: number; buildMs: number; providerCalls: number; providerTokens: number; estimatedProviderCostUsd: number }
  scores: ContextEvaluationScore[]; comparisons: Array<{ caseId: string; stage: string; baseline: string; recallDelta: number | null; mandatoryCoverageDelta: number | null; regressions: string[] }>
  gates: { passed: boolean; violations: string[] }; summary: Array<{ stage: string; meanRecallAt10: number | null; meanReciprocalRank: number | null; meanEvidenceCoverage: number | null; p50Ms: number | null; p95Ms: number | null; tokens: number }>
}

/** Expected source keys come from the versioned corpus, never from the retrieval implementation under evaluation. */
export function scoreContextEvaluation(test: ContextEvaluationCase, sample: ContextEvaluationSample): ContextEvaluationScore {
  const empty = { caseId: test.id, stage: sample.stage, status: sample.status, unavailableReason: sample.unavailableReason, recallAt10: null, reciprocalRank: null, evidenceCoverage: null, mandatoryCoverage: null, citationCorrectness: null, staleInclusions: 0, excludedInclusions: 0, foreignInclusions: 0, supersededCurrentRecords: 0, tokens: sample.tokenEstimate, p50Ms: percentile(sample.latencyMs, 0.5), p95Ms: percentile(sample.latencyMs, 0.95), violations: [] } satisfies ContextEvaluationScore
  if (sample.status === 'unavailable') return empty
  const retrieved = [...new Set((sample.presentation === 'sections' ? sample.hits : sample.hits.slice(0, 10)).map((hit) => hit.sourceKey))]
  const expected = new Set(test.expectedSources)
  const rank = retrieved.findIndex((key) => expected.has(key))
  const missing = new Set(sample.missingCategories ?? [])
  const categories = new Set(sample.categories ?? [])
  const mandatoryMet = test.mandatoryCategories.filter((category) => test.expectedMissingCategories.includes(category) ? missing.has(category) : categories.has(category)).length
  const cited = sample.hits.filter((hit) => hit.citation)
  const staleInclusions = sample.hits.filter((hit) => hit.historical).length
  const excludedInclusions = sample.hits.filter((hit) => hit.excluded || test.forbiddenSources?.includes(hit.sourceKey)).length
  const foreignInclusions = sample.hits.filter((hit) => hit.foreign).length
  const violations: string[] = []
  if (cited.some((hit) => !hit.citationValid)) violations.push('invalid citation identity or revision')
  if (staleInclusions) violations.push('historical evidence presented as current')
  if (excludedInclusions) violations.push('excluded or unavailable source included')
  if (foreignInclusions) violations.push('foreign project evidence included')
  if (sample.supersededCurrentRecords) violations.push('superseded guidance presented as current')
  if (sample.categories) {
    if (mandatoryMet !== test.mandatoryCategories.length) violations.push('mandatory category omitted without an explicit expected gap')
    if (test.expectedMissingCategories.length && sample.canExecute) violations.push('execution allowed with missing mandatory evidence')
  }
  for (const key of test.mustRetrieve) if (!retrieved.includes(key)) violations.push(`required evidence omitted: ${key}`)
  return { ...empty, recallAt10: expected.size && sample.presentation !== 'sections' ? retrieved.filter((key) => expected.has(key)).length / expected.size : null, reciprocalRank: expected.size && sample.presentation !== 'sections' ? rank < 0 ? 0 : 1 / (rank + 1) : null,
    evidenceCoverage: expected.size ? retrieved.filter((key) => expected.has(key)).length / expected.size : null,
    mandatoryCoverage: sample.categories ? test.mandatoryCategories.length ? mandatoryMet / test.mandatoryCategories.length : 1 : null,
    citationCorrectness: cited.length ? cited.filter((hit) => hit.citationValid).length / cited.length : null, staleInclusions, excludedInclusions, foreignInclusions, supersededCurrentRecords: sample.supersededCurrentRecords ?? 0, violations }
}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))]
}
export function mean(values: Array<number | null>): number | null { const numbers = values.filter((value): value is number => value !== null); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null }

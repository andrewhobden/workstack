import { describe, expect, it } from 'vitest'
import { mean, percentile, scoreContextEvaluation, type ContextEvaluationCase, type ContextEvaluationSample } from '../../src/core/context-evaluation'
import type { SourceCitation } from '../../src/core/source-catalog'

const testCase: ContextEvaluationCase = { id: 'required-evidence', tags: ['identifier'], query: 'resumeLease', task: 'Resume ownership', expectedSources: ['lease'], mustRetrieve: ['lease'], mandatoryCategories: ['task', 'decisions'], expectedMissingCategories: [] }
const citation: SourceCitation = { sourceId: 'lease', revisionId: 'revision1', passageId: 'revision1:0', contentHash: 'hash', normalizedHash: 'normalized', passageHash: 'passage', headingTrail: ['Lease'], startLine: 1, endLine: 2, startOffset: 0, endOffset: 12, locator: 'source://lease/revisions/revision1/passages/0' }
const sample: ContextEvaluationSample = { caseId: testCase.id, stage: 'context_packet', status: 'available', hits: [{ sourceKey: 'lease', citation, citationValid: true, historical: false, excluded: false, foreign: false }], categories: ['task', 'decisions'], canExecute: true, tokenEstimate: 1000, latencyMs: [2, 4, 10, 3] }

describe('context quality invariant scoring', () => {
  it('gates missing mandatory evidence even when retrieval ranking remains perfect', () => {
    const passing = scoreContextEvaluation(testCase, sample)
    expect(passing).toMatchObject({ recallAt10: 1, reciprocalRank: 1, mandatoryCoverage: 1, citationCorrectness: 1, p50Ms: 3, p95Ms: 10, violations: [] })
    const omitted = scoreContextEvaluation(testCase, { ...sample, categories: ['task'] })
    expect(omitted.recallAt10).toBe(1)
    expect(omitted.violations).toContain('mandatory category omitted without an explicit expected gap')
  })
  it('rejects stale, forged, foreign and superseded evidence independently of ranking', () => {
    const failing = scoreContextEvaluation(testCase, { ...sample, supersededCurrentRecords: 1, hits: [{ ...sample.hits[0], historical: true, foreign: true, excluded: true, citationValid: false }] })
    expect(failing.recallAt10).toBe(1)
    expect(failing.violations).toEqual(expect.arrayContaining(['invalid citation identity or revision', 'historical evidence presented as current', 'foreign project evidence included', 'superseded guidance presented as current', 'excluded or unavailable source included']))
  })
  it('accepts explicit offline gaps only when execution remains blocked', () => {
    const missing = { ...testCase, expectedSources: [], mustRetrieve: [], expectedMissingCategories: ['decisions' as const] }
    const result = scoreContextEvaluation(missing, { ...sample, hits: [], categories: ['task'], missingCategories: ['decisions'], canExecute: false })
    expect(result).toMatchObject({ mandatoryCoverage: 1, violations: [] })
    expect(scoreContextEvaluation(missing, { ...sample, hits: [], missingCategories: ['decisions'], canExecute: true }).violations).toContain('execution allowed with missing mandatory evidence')
  })
  it('does not turn an unavailable optional model into a fabricated zero-quality benchmark', () => {
    const result = scoreContextEvaluation(testCase, { ...sample, status: 'unavailable', unavailableReason: 'No local model configured.', hits: [], latencyMs: [], categories: undefined })
    expect(result).toMatchObject({ status: 'unavailable', recallAt10: null, reciprocalRank: null, mandatoryCoverage: null, citationCorrectness: null, p50Ms: null, violations: [] })
  })
  it('separates ranked recall from complete packet coverage and reports required evidence omissions', () => {
    const fillers = Array.from({ length: 10 }, (_, index) => ({ ...sample.hits[0], sourceKey: `filler-${index}`, citation: undefined }))
    const hits = [...fillers, sample.hits[0]]
    const ranked = scoreContextEvaluation(testCase, { ...sample, categories: undefined, hits })
    expect(ranked).toMatchObject({ recallAt10: 0, reciprocalRank: 0, evidenceCoverage: 0, mandatoryCoverage: null })
    expect(ranked.violations).toContain('required evidence omitted: lease')
    const packet = scoreContextEvaluation(testCase, { ...sample, presentation: 'sections', hits })
    expect(packet).toMatchObject({ recallAt10: null, reciprocalRank: null, evidenceCoverage: 1, violations: [] })
    expect(scoreContextEvaluation({ ...testCase, mandatoryCategories: [] }, sample).mandatoryCoverage).toBe(1)
    expect(scoreContextEvaluation({ ...testCase, forbiddenSources: ['lease'] }, sample).excludedInclusions).toBe(1)
  })
  it('aggregates available measurements without counting unavailable stages as zero', () => {
    expect(mean([])).toBeNull()
    expect(mean([null, null])).toBeNull()
    expect(mean([null, 1, 3])).toBe(2)
    expect(percentile([10, 2, 4], 0)).toBe(2)
    expect(percentile([10, 2, 4], 1)).toBe(10)
  })
})

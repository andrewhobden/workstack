import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runContextEvaluation } from '../support/context-evaluation-runner'

describe('offline project-context quality gate', () => {
  it('measures the versioned large corpus and gates packet evidence, citation, history and isolation invariants', async () => {
    const report = await runContextEvaluation({ iterations: 2 })
    const directory = path.join(process.cwd(), 'context-evaluation-results')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    expect(report.corpusRevision).toBe('workstack-context-eval-2026-09-v1')
    expect(report.corpusReview).toMatchObject({ status: 'pending_human_review', reviewer: null })
    expect(report.index.sources).toBeGreaterThanOrEqual(750)
    expect(report.index).toMatchObject({ providerCalls: 0, providerTokens: 0, estimatedProviderCostUsd: 0 })
    expect(report.environment).toMatchObject({ node: expect.stringMatching(/^v/), sqlite: expect.any(String), cpu: expect.any(String) })
    expect(report.gates.violations).toEqual([])
    expect(report.gates.passed).toBe(true)
    const packetScores = report.scores.filter((score) => score.stage === 'context_packet')
    expect(packetScores).toHaveLength(9)
    expect(packetScores.every((score) => score.mandatoryCoverage === 1)).toBe(true)
    expect(report.scores.filter((score) => score.stage === 'passage_lexical' && score.recallAt10 !== null).every((score) => score.recallAt10 === 1)).toBe(true)
    for (const stage of report.summary.filter((summary) => summary.stage !== 'hybrid_local_model')) {
      expect(stage.p50Ms).toBeGreaterThanOrEqual(0)
      expect(stage.p95Ms).toBeGreaterThanOrEqual(stage.p50Ms!)
    }
    expect(report.scores.filter((score) => score.stage === 'hybrid_local_model').every((score) => score.status === 'unavailable' && score.recallAt10 === null)).toBe(true)
    expect(report.comparisons.some((comparison) => comparison.stage === 'context_packet')).toBe(true)
  }, 30_000)
})

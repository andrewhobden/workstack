import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository } from '../../src/core/source-catalog'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-source-refresh-')); roots.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Source refresh' })
  const catalog = new SourceCatalogRepository(store)
  const source = catalog.registerSource({ id: 'contract', kind: 'manual', title: 'Persistence contract', canonicalUri: 'manual://contract', policy: 'tracked_content', refreshSeconds: 60 })
  const first = catalog.publishRevision({ sourceId: source.id, original: '# Contract\nRetries wait ten seconds.', upstreamRevision: '1' })
  const other = catalog.registerSource({ id: 'policy', kind: 'manual', title: 'Human policy', canonicalUri: 'manual://policy' })
  const otherRevision = catalog.publishRevision({ sourceId: other.id, original: '# Policy\nHuman review is required.' })
  const citation = catalog.getPassage(`${first.id}:0`).citation
  const otherCitation = catalog.getPassage(`${otherRevision.id}:0`).citation
  const revisions = new WikiRevisionRepository(store)
  const baseline = revisions.stage({ requestKey: 'baseline', title: 'Accepted documentation', pages: [
    { slug: 'generated-architecture', content: '# Architecture\nRetries wait ten seconds. Human review is required.' },
    { slug: 'generated-policy', content: '# Policy\nHuman review is required.' }
  ], evidence: { pageSourceCitations: { 'generated-architecture': [citation, otherCitation], 'generated-policy': [otherCitation] } } })
  revisions.publish(baseline.revision.id, 'Owner')
  const project = store.project
  store.close()
  const projects = { getProject: async () => project, listProjects: async () => [project] }
  const open = () => ProjectStore.open(rootPath)
  const change = async (text = '# Contract\nRetries wait thirty seconds.') => {
    const reopened = await open()
    try { return new SourceCatalogRepository(reopened).publishRevision({ sourceId: source.id, original: text, upstreamRevision: text }) } finally { reopened.close() }
  }
  const service = (propose: (prompt: string) => Promise<string>) => new WikiAutomationService(projects as never, { propose } as never)
  const inspect = async () => {
    const reopened = await open()
    try {
      const revisions = new WikiRevisionRepository(reopened)
      const catalog = new SourceCatalogRepository(reopened)
      return { jobs: new WikiAutomationRepository(reopened).listJobs(), revisions: revisions.list(), current: revisions.currentId(), pages: revisions.currentPages(),
        invalidations: catalog.listInvalidations(), wiki: catalog.getSource('wiki:generated-architecture') }
    } finally { reopened.close() }
  }
  return { rootPath, open, change, service, inspect, source, first, citation, otherCitation, baseline }
}

describe('targeted wiki recomputation from durable source invalidations', () => {
  it('does no model work for unchanged checks, then stages exactly the affected page with fresh immutable evidence', async () => {
    const task = await fixture()
    const propose = vi.fn<(prompt: string) => Promise<string>>(async () => '# Architecture\nRetries now wait thirty seconds. Human review is required.')
    await task.service(propose).catchUp()
    let store = await task.open()
    new SourceCatalogRepository(store).recordFreshness(task.source.id, { upstreamRevision: '1' })
    store.close()
    await task.service(propose).catchUp()
    expect((await task.inspect()).jobs).toEqual([])
    expect(propose).not.toHaveBeenCalled()
    const second = await task.change()
    await task.service(propose).catchUp()
    await task.service(propose).catchUp()
    const result = await task.inspect()
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ status: 'completed', attemptCount: 1, requestedBy: expect.stringMatching(/^source-refresh:/) })
    expect(propose).toHaveBeenCalledOnce()
    expect(propose.mock.calls[0][0]).toContain('Retries wait thirty seconds.')
    expect(propose.mock.calls[0][0]).toContain(second.id)
    expect(result.current).toBe(task.baseline.revision.id)
    expect(result.wiki.state).toBe('stale')
    expect(result.invalidations.filter((value) => value.artifactKind === 'wiki_source')).toHaveLength(1)
    store = await task.open()
    const revisions = new WikiRevisionRepository(store)
    const proposal = revisions.review(result.revisions[0].id)
    expect(proposal.revision.status).toBe('proposed')
    expect(proposal.changes.map((value) => value.slug)).toEqual(['generated-architecture'])
    expect(proposal.pages.find((value) => value.slug === 'generated-policy')?.content).toBe('# Policy\nHuman review is required.')
    expect(proposal.revision.evidence.pageSourceCitations).toEqual({
      'generated-architecture': [task.otherCitation, new SourceCatalogRepository(store).getPassage(`${second.id}:0`).citation],
      'generated-policy': [task.otherCitation]
    })
    revisions.publish(proposal.revision.id, 'Owner', 'Compared the changed source contract')
    store.close()
    await task.service(propose).catchUp()
    const accepted = await task.inspect()
    expect(accepted.wiki.state).toBe('ready')
    expect(accepted.invalidations.filter((value) => value.artifactKind === 'wiki_source')).toEqual([])
    expect(propose).toHaveBeenCalledOnce()
  })

  it.each(['expired', 'unavailable', 'metadata changed', 'paused source', 'paused page'])("keeps %s invalidations unscheduled until changed content is ready", async (state) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'))
    const task = await fixture()
    const propose = vi.fn(async () => '# Architecture\nRecovered source evidence.')
    let store = await task.open()
    const catalog = new SourceCatalogRepository(store)
    if (state === 'expired') vi.setSystemTime(new Date('2026-09-09T00:02:00.000Z'))
    if (state === 'unavailable') catalog.recordFreshness(task.source.id, { unavailable: true, reason: 'Temporarily offline.' })
    if (state === 'metadata changed') catalog.recordFreshness(task.source.id, { upstreamRevision: '2', metadataOnly: true })
    if (state === 'paused source') catalog.updatePolicy(task.source.id, 'paused')
    if (state === 'paused page') catalog.updatePolicy('wiki:generated-architecture', 'paused')
    store.close()
    if (state === 'paused source' || state === 'paused page') await task.change()
    await task.service(propose).catchUp()
    expect((await task.inspect()).jobs).toEqual([])
    expect(propose).not.toHaveBeenCalled()
    store = await task.open()
    const recovery = new SourceCatalogRepository(store)
    recovery.updatePolicy(task.source.id, 'tracked_content', 60)
    if (state === 'paused page') recovery.updatePolicy('wiki:generated-architecture', 'import_once')
    recovery.publishRevision({ sourceId: task.source.id, original: '# Contract\nRetries wait forty seconds.', upstreamRevision: '3' })
    store.close()
    await task.service(propose).catchUp()
    expect((await task.inspect()).jobs).toHaveLength(1)
    expect(propose).toHaveBeenCalledOnce()
  })

  it('coalesces several changed citations into one targeted request and preserves bounded, redacted passages', async () => {
    const task = await fixture()
    const store = await task.open()
    const catalog = new SourceCatalogRepository(store)
    catalog.publishRevision({ sourceId: 'policy', original: '# Policy\nHuman signoff is required. password=secret-value' })
    store.close()
    await task.change(`# Unrelated\n${'Unrelated evidence. '.repeat(1800)}\n# Contract\nRetries wait thirty seconds.`)
    const propose = vi.fn<(prompt: string) => Promise<string>>(async () => '# Updated affected page')
    await task.service(propose).catchUp()
    const result = await task.inspect()
    expect(result.jobs).toHaveLength(2)
    expect(propose).toHaveBeenCalledTimes(2)
    const architecture = result.revisions.find((value) => value.title.endsWith('generated-architecture'))!
    expect(architecture.evidence.sourceChanges).toHaveLength(2)
    expect(architecture.evidence.omittedPassages).toBeGreaterThan(0)
    const prompts = propose.mock.calls.map(([prompt]) => prompt).join('\n')
    expect(prompts).toContain('Retries wait thirty seconds.')
    expect(prompts).toContain('password=[REDACTED]')
    expect(prompts).not.toContain('secret-value')
    expect(JSON.stringify(architecture.evidence)).not.toContain('secret-value')
  })

  it('deduplicates across app instances and discards a result superseded while the provider was running', async () => {
    const task = await fixture()
    await task.change()
    let started!: () => void
    let finish!: () => void
    const called = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const propose = vi.fn(async (prompt: string) => { started(); await gate; return prompt.includes('fifty seconds') ? '# Current fifty-second policy' : '# Obsolete thirty-second policy' })
    const first = task.service(propose).catchUp()
    await called
    await task.service(propose).catchUp()
    expect(propose).toHaveBeenCalledOnce()
    const latest = await task.change('# Contract\nRetries wait fifty seconds.')
    finish()
    await first
    const result = await task.inspect()
    expect(result.jobs.map((value) => value.status).sort()).toEqual(['completed', 'failed'])
    expect(result.revisions.filter((value) => value.status === 'proposed')).toHaveLength(1)
    expect(result.revisions[0].evidence.sourceChanges).toMatchObject([{ currentRevisionId: latest.id }])
    const store = await task.open()
    expect(new WikiRevisionRepository(store).review(result.revisions[0].id).changes[0].after).toBe('# Current fifty-second policy')
    store.close()
    await task.service(propose).catchUp()
    expect(propose).toHaveBeenCalledTimes(2)
    expect(result.current).toBe(task.baseline.revision.id)
  })

  it('resumes eligible evidence after a source was paused during an active attempt', async () => {
    const task = await fixture()
    await task.change()
    const propose = vi.fn(async () => {
      const store = await task.open()
      new SourceCatalogRepository(store).updatePolicy(task.source.id, 'paused')
      store.close()
      return '# Generated before the source was paused'
    })
    await task.service(propose).catchUp()
    expect((await task.inspect()).revisions.filter((value) => value.status === 'proposed')).toEqual([])
    await task.service(propose).catchUp()
    expect(propose).toHaveBeenCalledOnce()
    const store = await task.open()
    const catalog = new SourceCatalogRepository(store)
    catalog.updatePolicy(task.source.id, 'tracked_content')
    catalog.recordFreshness(task.source.id, {})
    store.close()
    const recovered = vi.fn(async () => '# Refreshed after recovery')
    await task.service(recovered).catchUp()
    expect(recovered).toHaveBeenCalledOnce()
    const result = await task.inspect()
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].status).toBe('completed')
    expect(result.revisions.filter((value) => value.status === 'proposed')).toHaveLength(1)
  })

  it('retains bounded transient retries without requeuing permanent failures from persistent invalidations', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'))
    const task = await fixture()
    await task.change()
    const transient = vi.fn(async () => { throw Object.assign(new Error('Provider busy.'), { code: 'RATE_LIMIT', retryable: true }) })
    await task.service(transient).catchUp()
    await task.service(transient).catchUp()
    expect(transient).toHaveBeenCalledOnce()
    expect((await task.inspect()).jobs[0]).toMatchObject({ status: 'failed', attemptCount: 1 })
    vi.setSystemTime(new Date('2026-09-09T00:00:30.000Z'))
    const permanent = vi.fn(async () => { throw new Error('The response format needs operator correction.') })
    await task.service(permanent).catchUp()
    await task.service(permanent).catchUp()
    expect(permanent).toHaveBeenCalledOnce()
    const failed = await task.inspect()
    expect(failed.jobs).toHaveLength(1)
    expect(failed.jobs[0]).toMatchObject({ status: 'failed', attemptCount: 2 })
    expect(failed.revisions.filter((value) => value.status === 'proposed')).toEqual([])
    const store = await task.open()
    new WikiAutomationRepository(store).retryJob(failed.jobs[0].id)
    store.close()
    const recovered = vi.fn(async () => '# Reviewed source update after explicit retry')
    await task.service(recovered).catchUp()
    expect(recovered).toHaveBeenCalledOnce()
    expect((await task.inspect()).jobs).toMatchObject([{ status: 'completed', attemptCount: 1 }])
  })

  it.each(['empty', 'blank', 'oversized'])('retains source dependencies when %s current passage evidence cannot enter the prompt', async (kind) => {
    const task = await fixture()
    const second = await task.change()
    let store = await task.open()
    // Simulate an incomplete or incompatible persisted converter output, beyond normal text intake validation.
    if (kind === 'empty') store.database.prepare('DELETE FROM source_passages WHERE revision_id = ?').run(second.id)
    else store.database.prepare('UPDATE source_passages SET text = ? WHERE revision_id = ?').run(kind === 'blank' ? ' \n ' : 'x'.repeat(24_001), second.id)
    store.close()
    const propose = vi.fn(async () => '# Policy update with existing contract claims retained')
    await task.service(propose).catchUp()
    expect(propose).not.toHaveBeenCalled()
    expect((await task.inspect()).jobs).toEqual([])
    store = await task.open()
    new SourceCatalogRepository(store).publishRevision({ sourceId: 'policy', original: '# Policy\nHuman signoff is required.' })
    store.close()
    await task.service(propose).catchUp()
    const result = await task.inspect()
    const proposed = result.revisions.find((value) => value.title.endsWith('generated-architecture'))!
    expect(proposed.evidence.omittedSources).toBe(1)
    expect(proposed.evidence.sourceChanges).toMatchObject([{ sourceId: 'policy' }])
    expect((proposed.evidence.pageSourceCitations as Record<string, unknown[]>)['generated-architecture']).toContainEqual(task.citation)
    store = await task.open()
    new WikiRevisionRepository(store).publish(proposed.id, 'Owner', 'Reviewed policy update; contract remains stale')
    store.close()
    expect((await task.inspect()).wiki.state).toBe('stale')
    expect((await task.inspect()).invalidations).toContainEqual(expect.objectContaining({ sourceId: task.source.id, revisionId: task.first.id, artifactId: 'wiki:generated-architecture' }))
  })

  it('keeps deferred source dependencies stale across the ten-source cap until the next reviewed batch', async () => {
    const task = await fixture()
    let store = await task.open()
    const catalog = new SourceCatalogRepository(store)
    const extra = Array.from({ length: 11 }, (_, index) => {
      const id = `extra-${index.toString().padStart(2, '0')}`
      catalog.registerSource({ id, kind: 'manual', title: id, canonicalUri: `manual://${id}` })
      const revision = catalog.publishRevision({ sourceId: id, original: `# ${id}\nOriginal contract.` })
      return catalog.getPassage(`${revision.id}:0`).citation
    })
    const revisions = new WikiRevisionRepository(store)
    const baseline = revisions.stage({ requestKey: 'many-citations', title: 'Eleven reviewed contracts', pages: [{ slug: 'generated-architecture', content: '# Architecture\nEleven related contracts.' }], evidence: { pageSourceCitations: { 'generated-architecture': extra } } })
    revisions.publish(baseline.revision.id, 'Owner')
    for (const citation of extra) catalog.publishRevision({ sourceId: citation.sourceId, original: `# ${citation.sourceId}\nRevised contract.` })
    store.close()
    let calls = 0
    const propose = vi.fn(async () => `# Reviewed batch ${++calls}`)
    await task.service(propose).catchUp()
    let result = await task.inspect()
    const first = result.revisions[0]
    expect(first.evidence.sourceChanges).toHaveLength(10)
    expect(first.evidence.omittedSources).toBe(1)
    expect((first.evidence.pageSourceCitations as Record<string, unknown[]>)['generated-architecture']).toContainEqual(extra[10])
    store = await task.open()
    new WikiRevisionRepository(store).publish(first.id, 'Owner')
    store.close()
    expect((await task.inspect()).wiki.state).toBe('stale')
    await task.service(propose).catchUp()
    result = await task.inspect()
    const second = result.revisions[0]
    expect(second.evidence.sourceChanges).toMatchObject([{ sourceId: extra[10].sourceId }])
    expect(second.evidence.omittedSources).toBe(0)
    store = await task.open()
    new WikiRevisionRepository(store).publish(second.id, 'Owner')
    store.close()
    expect((await task.inspect()).wiki.state).toBe('ready')
    expect(propose).toHaveBeenCalledTimes(2)
  })

  it('requires reviewed consolidation before replacing an article that exceeds the complete prior-evidence window', async () => {
    const task = await fixture()
    const store = await task.open()
    const revisions = new WikiRevisionRepository(store)
    const content = `# Architecture\n${'Retained accepted facts. '.repeat(1100)}`
    const baseline = revisions.stage({ requestKey: 'long-article', title: 'Long accepted history', pages: [{ slug: 'generated-architecture', content }] })
    revisions.publish(baseline.revision.id, 'Owner')
    store.close()
    await task.change()
    const propose = vi.fn(async () => '# Incomplete replacement')
    await task.service(propose).catchUp()
    await task.service(propose).catchUp()
    expect(propose).not.toHaveBeenCalled()
    const result = await task.inspect()
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('reviewed consolidation') })
    expect(result.current).toBe(baseline.revision.id)
    expect(result.pages.find((value) => value.slug === 'generated-architecture')?.content).toBe(content)
    expect(result.wiki.state).toBe('stale')
  })
})

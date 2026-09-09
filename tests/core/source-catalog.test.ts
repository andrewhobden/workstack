import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SourceCatalogRepository, type SourceAcquisition } from '../../src/core/source-catalog'
import { FrozenClock } from '../../src/core/clock'
import { hashSourceText, splitSourcePassages } from '../../src/core/source-passages'
import { WorkItemRepository } from '../../src/core/work-items'
import { WorkstackError } from '../../src/core/errors'

const stores: ProjectStore[] = []
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-source-catalog-'))
  roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Source catalog' })
  stores.push(store)
  const clock = new FrozenClock(new Date('2026-09-09T00:00:00.000Z'))
  return { store, clock, catalog: new SourceCatalogRepository(store, { clock }) }
}

describe('versioned source catalog', () => {
  it('keeps unchanged imports idempotent and old citations resolvable after replacements and deletion', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Architecture', canonicalUri: 'manual://architecture' })
    const first = catalog.publishRevision({ sourceId: source.id, original: '# Design\nThe queue uses durable leases.\n', upstreamRevision: 'v1' })
    const citation = catalog.search('durable')[0].citation
    expect(catalog.publishRevision({ sourceId: source.id, original: '# Design\nThe queue uses durable leases.\n', upstreamRevision: 'v2' }).id).toBe(first.id)
    expect(catalog.getDetail(source.id).revisions).toHaveLength(1)
    expect(catalog.recordFreshness(source.id, { upstreamRevision: 'v2', metadataOnly: true }).state).toBe('ready')
    const second = catalog.publishRevision({ sourceId: source.id, original: '# Design\nThe queue uses immutable envelopes.\n', upstreamRevision: 'v3' })
    expect(second.id).not.toBe(first.id)
    expect(catalog.search('durable')).toEqual([])
    expect(catalog.readCitation(Object.fromEntries(Object.entries(citation).reverse()) as typeof citation).passage).toMatchObject({ historical: true, text: expect.stringContaining('durable') })
    catalog.recordFreshness(source.id, { unavailable: true, deleted: true, reason: 'Upstream document deleted.' })
    expect(catalog.search('immutable')).toEqual([])
    expect(catalog.getSource(source.id)).toMatchObject({ state: 'unavailable', currentRevisionId: second.id, deletedAt: expect.any(String) })
    expect(catalog.readRevision(source.id, first.id).text).toContain('durable')
  })

  it('returns exact deep-document spans and handles headings inside fenced code', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'repo_file', title: 'Long design', canonicalUri: 'repo://project/design.md' })
    const text = `# Architecture\n${'Ordinary background paragraph.\n\n'.repeat(400)}## Worker lifecycle\n\`\`\`ts\n# this_is_code\nfunction retry_owned_lease() { return true }\n\`\`\`\n## Recovery\nUse the ownership token to resume.\n`
    const revision = catalog.publishRevision({ sourceId: source.id, original: text })
    const result = catalog.search('retry_owned_lease')[0]
    expect(result.citation).toMatchObject({ revisionId: revision.id, headingTrail: ['Architecture', 'Worker lifecycle'], contentHash: hashSourceText(text) })
    expect(result.structure.kind).toBe('code')
    expect(text.slice(result.citation.startOffset, result.citation.endOffset)).toBe(result.text)
    expect(result.citation.passageHash).toBe(hashSourceText(result.text))
    expect(text.slice(0, result.citation.startOffset).split('\n')).toHaveLength(result.citation.startLine)
    expect(catalog.search('ownership')[0].citation.headingTrail).toEqual(['Architecture', 'Recovery'])
    const expanded = catalog.readCitation(result.citation, { neighbors: 2 })
    expect(expanded.neighbors.length).toBeGreaterThan(0)
    expect(() => catalog.readCitation({ ...result.citation, startOffset: 0 })).toThrow('evidence span')
    const oversizedCode = `\`\`\`text\n${'abcdef'.repeat(2000)}\n\`\`\`\n`
    const passages = splitSourcePassages(oversizedCode)
    expect(passages.map((passage) => passage.text).join('')).toBe(oversizedCode)
    expect(passages.every((passage) => passage.text.length <= 4000)).toBe(true)
    expect(passages.some((passage) => passage.structure.continued)).toBe(true)
    const unicode = `${'a'.repeat(3999)}😀${'b'.repeat(5000)}`
    const unicodePassages = splitSourcePassages(unicode)
    expect(unicodePassages.map((passage) => passage.text).join('')).toBe(unicode)
    expect(unicodePassages.every((passage) => !/^[\uDC00-\uDFFF]/.test(passage.text) && !/[\uD800-\uDBFF]$/.test(passage.text))).toBe(true)
  })

  it('preserves authorized originals but redacts retrieval text and metadata before provider use', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Credential handling', canonicalUri: 'manual://credentials-policy' })
    const token = `ghp_${'a'.repeat(30)}`
    const revision = catalog.publishRevision({ sourceId: source.id, original: `# Credentials\nNever publish ${token}.\n`, metadata: { password: 'private-value', url: `Example ${token}` } })
    expect(catalog.search('Credentials')[0].text).not.toContain(token)
    expect(revision.manifest).toMatchObject({ redacted: true, metadata: { password: '[REDACTED]', url: 'Example [REDACTED CREDENTIAL]' } })
    expect(catalog.readRevision(source.id, revision.id, { representation: 'original' }).text).toContain(token)
    expect(catalog.readRevision(source.id, revision.id).text).not.toContain(token)
  })

  it('rolls back interrupted materialization and index publication as one transaction', async () => {
    const { store, catalog, clock } = await fixture()
    const first = catalog.registerSource({ kind: 'manual', title: 'Known', canonicalUri: 'manual://known' })
    catalog.publishRevision({ sourceId: first.id, original: 'The known source remains searchable.' })
    const second = catalog.registerSource({ kind: 'manual', title: 'New', canonicalUri: 'manual://new' })
    const interrupted = new SourceCatalogRepository(store, { clock, beforePublish: () => { throw new Error('publication interrupted') } })
    expect(() => interrupted.publishRevision({ sourceId: second.id, original: 'Transient new evidence.' })).toThrow('interrupted')
    expect(catalog.getDetail(second.id).revisions).toEqual([])
    expect(catalog.search('Transient')).toEqual([])
    expect(catalog.search('known')).toHaveLength(1)
    catalog.publishRevision({ sourceId: second.id, original: 'Transient new evidence.' })
    expect(catalog.getDetail(second.id).revisions).toHaveLength(1)
  })

  it('retains explicit partial/unsupported outcomes and never calls them ready', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'github_issue', title: 'Bounded discussion', canonicalUri: 'https://github.com/example/repo/issues/1' })
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'Body and selected comments', outcome: 'partial', limitations: ['Comments beyond the configured page limit were omitted.'] })
    expect(revision.manifest.completeness).toBe('partial')
    expect(catalog.getSource(source.id).currentRevisionId).toBeUndefined()
    expect(catalog.search('comments')).toEqual([])
    expect(catalog.readRevision(source.id, revision.id).text).toContain('selected comments')
    const unsupported = catalog.publishRevision({ sourceId: source.id, original: 'AAE=', outcome: 'unsupported', converter: 'binary-preservation', limitations: ['Original retained as base64.'] })
    expect(unsupported.manifest.passages).toBe(0)
  })

  it('coalesces intake, survives cancelled ownership, retries and preserves attempt history', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Cancelable', canonicalUri: 'manual://cancel' })
    const first = catalog.queueImport(source.id, 'request-1')
    expect(catalog.queueImport(source.id, 'request-2').id).toBe(first.id)
    let complete!: (result: SourceAcquisition) => void
    const run = catalog.processNext(() => new Promise((resolve) => { complete = resolve }))
    catalog.cancelJob(first.id)
    complete({ original: 'Cancelled source must never publish.' })
    await run
    expect(catalog.getDetail(source.id).revisions).toEqual([])
    expect(catalog.listJobs()[0]).toMatchObject({ stage: 'cancelled', status: 'failed' })
    catalog.retryJob(first.id)
    await catalog.processNext(async () => ({ original: 'Successful retry evidence.' }))
    expect(catalog.getSource(source.id).state).toBe('ready')
    expect(catalog.getDetail(source.id).attempts.some((attempt) => attempt.outcome === 'cancelled')).toBe(true)
    expect(catalog.getDetail(source.id).revisions).toHaveLength(1)
  })

  it('rejects a stale worker after restart-style lease recovery', async () => {
    const { store, catalog, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Restarted', canonicalUri: 'manual://restart' })
    catalog.queueImport(source.id, 'restart-request')
    let complete!: (result: SourceAcquisition) => void
    const stale = catalog.processNext(() => new Promise((resolve) => { complete = resolve }))
    clock.advance(121_000)
    const recovered = new SourceCatalogRepository(store, { clock })
    await recovered.processNext(async () => ({ original: 'The new owner publishes.' }))
    complete({ original: 'The expired owner must not publish.' })
    await stale
    expect(catalog.search('expired')).toEqual([])
    expect(catalog.search('owner')[0].text).toContain('new owner')
    expect(catalog.getDetail(source.id).revisions).toHaveLength(1)
  })

  it('tracks unchanged checks, metadata-only changes, selective invalidation, expiry and paused policy', async () => {
    const { catalog, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'repo_file', title: 'Tracked', canonicalUri: 'repo://tracked', policy: 'tracked_content', refreshSeconds: 60 })
    const unrelated = catalog.registerSource({ kind: 'manual', title: 'Unrelated', canonicalUri: 'manual://unrelated' })
    const original = catalog.publishRevision({ sourceId: source.id, original: 'Original tracked behavior.', upstreamRevision: 'one' })
    const otherRevision = catalog.publishRevision({ sourceId: unrelated.id, original: 'Other project evidence.' })
    catalog.linkDependent(source.id, original.id, 'wiki', 'dependent-page')
    catalog.linkDependent(unrelated.id, otherRevision.id, 'wiki', 'independent-page')
    const contentChangedAt = catalog.getSource(source.id).lastContentChangeAt
    clock.advance(10_000)
    catalog.publishRevision({ sourceId: source.id, original: 'Original tracked behavior.', upstreamRevision: 'one' })
    expect(catalog.getSource(source.id)).toMatchObject({ lastContentChangeAt: contentChangedAt, lastSuccessfulCheckAt: clock.now().toISOString() })
    expect(catalog.listInvalidations()).toEqual([])
    catalog.recordFreshness(source.id, { metadataOnly: true, upstreamRevision: 'two' })
    catalog.recordFreshness(source.id, { metadataOnly: true, upstreamRevision: 'two' })
    expect(catalog.getSource(source.id).state).toBe('stale')
    expect(catalog.listInvalidations().map((entry) => entry.artifactId)).toEqual(['dependent-page'])
    catalog.publishRevision({ sourceId: source.id, original: 'Changed tracked behavior.', upstreamRevision: 'two' })
    clock.advance(61_000)
    expect(catalog.getSource(source.id).state).toBe('stale')
    expect(catalog.search('tracked')).toEqual([])
    expect(catalog.scheduleDue()).toHaveLength(1)
    catalog.updatePolicy(source.id, 'paused')
    expect(catalog.scheduleDue()).toEqual([])
    expect(() => catalog.queueImport(source.id, 'paused')).toThrow('Resume')
    expect(catalog.readCitation(catalog.search('Other')[0].citation).passage.historical).toBe(false)
  })

  it('preserves old raw source IDs and task provenance during migration', async () => {
    const { store, catalog } = await fixture()
    const task = new WorkItemRepository(store).create({ title: 'Legacy completion' })
    const location = 'knowledge/raw/legacy.md'
    await writeFile(path.join(store.paths.workstackPath, location), '# Legacy completion\nThe accepted task shipped.\n')
    store.database.prepare(`INSERT INTO knowledge_sources (id,kind,display_name,relative_or_external_location,source_work_item_id,status,created_at,updated_at)
      VALUES ('legacy-source','work_completion','Legacy completion',?,?,'indexed',?,?)`).run(location, task.id, store.project.createdAt, store.project.createdAt)
    expect(catalog.migrateLegacySources()).toBe(1)
    expect(catalog.migrateLegacySources()).toBe(0)
    expect(catalog.getSource('legacy-source')).toMatchObject({ workItemId: task.id, kind: 'work_completion', state: 'ready' })
    expect(catalog.search('shipped')[0].workItemId).toBe(task.id)
  })
  it('preserves the first task association when a shared canonical source is imported again', async () => {
    const { catalog, store } = await fixture()
    const first = new WorkItemRepository(store).create({ title: 'First task' })
    const second = new WorkItemRepository(store).create({ title: 'Second task' })
    const input = { kind: 'manual' as const, title: 'Shared guidance', canonicalUri: 'manual://shared' }
    const source = catalog.registerSource(input)
    expect(catalog.registerSource({ ...input, workItemId: first.id })).toMatchObject({ id: source.id, workItemId: first.id })
    expect(catalog.registerSource({ ...input, workItemId: second.id })).toMatchObject({ id: source.id, workItemId: first.id })
    expect(catalog.listSources()).toHaveLength(1)
  })
  it('keeps publication limits and missing reads explicit without leaving partial revisions', async () => {
    const { catalog } = await fixture()
    const source = catalog.registerSource({ kind: 'file', title: 'File', canonicalUri: 'file://bounded' })
    expect(() => catalog.publishRevision({ sourceId: source.id, original: ' \r\n' })).toThrow('readable text')
    expect(() => catalog.publishRevision({ sourceId: source.id, original: 'a'.repeat(2_000_001) })).toThrow('intake limit')
    expect(() => catalog.publishRevision({ sourceId: source.id, original: 'small', normalized: 'a'.repeat(2_000_001) })).toThrow('intake limit')
    expect(catalog.getDetail(source.id).revisions).toEqual([])
    const revision = catalog.publishRevision({ sourceId: source.id, original: 'Queue\r\nrequires a lease.', metadata: { samples: ['api_key=hidden', { token: 'hidden' }], count: 2, omitted: null } })
    expect(revision.manifest.metadata).toMatchObject({ samples: [expect.not.stringContaining('hidden'), { token: '[REDACTED]' }], count: 2, omitted: null })
    expect(catalog.readRevision(source.id, revision.id, { offset: 6, limit: 8 })).toMatchObject({ text: 'requires', truncated: true, offset: 6 })
    expect(() => catalog.readRevision(source.id, revision.id, { offset: 100 })).toThrow('beyond')
    expect(() => catalog.getRevision(source.id, 'missing')).toThrow('revision does not exist')
    expect(() => catalog.getSource('missing')).toThrow('source does not exist')
    expect(() => catalog.getPassage('missing')).toThrow('passage does not exist')
    expect(catalog.search('!?')).toEqual([])
    expect(splitSourcePassages('')).toEqual([])
    expect(() => splitSourcePassages('x', 1)).toThrow('Unicode character')
    expect(() => splitSourcePassages('x\n\n'.repeat(1001))).toThrow('passage limit')
  })
  it('bounds passage results and neighboring reads while retaining historical dependent identities', async () => {
    const { catalog } = await fixture()
    const first = catalog.registerSource({ kind: 'manual', title: 'Queue manual', canonicalUri: 'manual://queue-large' })
    const text = Array.from({ length: 5 }, (_, i) => `# Queue part ${i}\n${'queue '.repeat(640)}\n\n`).join('')
    const revision = catalog.publishRevision({ sourceId: first.id, original: text })
    const mirror = catalog.registerSource({ kind: 'manual', title: 'Queue mirror', canonicalUri: 'manual://queue-mirror' })
    catalog.publishRevision({ sourceId: mirror.id, original: text })
    const hits = catalog.search('queue', { limit: 30 })
    expect(new Set(hits.map((hit) => hit.citation.passageHash)).size).toBe(hits.length)
    for (const sourceId of [first.id, mirror.id]) expect(hits.filter((hit) => hit.citation.sourceId === sourceId).length).toBeLessThanOrEqual(3)
    expect(catalog.search('queue', { limit: 1 })).toHaveLength(1)
    expect(catalog.search('queue', { maxChars: 1 })).toEqual([])
    const middle = catalog.getPassage(`${revision.id}:2`)
    expect(catalog.readCitation(middle.citation, { neighbors: 3, maxChars: 4000 })).toMatchObject({ neighbors: [], truncated: true })
    catalog.publishRevision({ sourceId: first.id, original: 'The queue manual has changed.' })
    catalog.linkDependent(first.id, revision.id, 'context_packet', 'historic-packet')
    expect(catalog.listInvalidations()).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: 'historic-packet', revisionId: revision.id })]))
  })
  it('renews long-running intake and aborts publication when its lease expires', async () => {
    const { catalog, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Slow import', canonicalUri: 'manual://slow' })
    catalog.queueImport(source.id, 'slow-request')
    vi.useFakeTimers()
    let complete!: (result: SourceAcquisition) => void
    let signal!: AbortSignal
    const running = catalog.processNext((_source, options) => {
      signal = options.signal
      return new Promise((resolve) => { complete = resolve })
    })
    clock.advance(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(catalog.listJobs()[0].leaseExpiresAt).toBe(new Date(clock.now().getTime() + 120_000).toISOString())
    clock.advance(121_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(signal.aborted).toBe(true)
    complete({ original: 'An expired worker cannot publish this.' })
    await running
    expect(catalog.getDetail(source.id).revisions).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains retry failures and metadata-only outcomes with explicit pause and lookup diagnostics', async () => {
    const { catalog } = await fixture()
    expect(await catalog.processNext(async () => ({ original: 'No queued task.' }))).toBeUndefined()
    expect(() => catalog.cancelJob('missing')).toThrow('job does not exist')
    expect(() => catalog.retryJob('missing')).toThrow('job does not exist')
    const source = catalog.registerSource({ kind: 'github_file', title: 'Metadata check', canonicalUri: 'github://metadata', policy: 'metadata_only' })
    const job = catalog.queueImport(source.id, 'metadata-request')
    await catalog.processNext(async () => ({ metadataOnly: true, upstreamRevision: 'revision-one' }))
    expect(catalog.getSource(source.id)).toMatchObject({ state: 'stale', staleReason: 'No complete content snapshot is available.' })
    expect(catalog.queueImport(source.id, 'metadata-request').id).toBe(job.id)
    const retrySource = catalog.registerSource({ kind: 'manual', title: 'Retry', canonicalUri: 'manual://retry-failure' })
    const retry = catalog.queueImport(retrySource.id, 'retry-request')
    await catalog.processNext(async () => { throw 'Temporarily unavailable.' })
    expect(catalog.queueImport(retrySource.id, 'duplicate-while-retrying').id).toBe(retry.id)
    catalog.updatePolicy(retrySource.id, 'paused')
    expect(() => catalog.retryJob(retry.id)).toThrow('Resume this source')
    expect(catalog.getDetail(retrySource.id).attempts.some((attempt) => attempt.outcome === 'failed')).toBe(true)
  })
  it('keeps unavailable legacy material explicit while migrating readable manual and file sources', async () => {
    const { store, catalog } = await fixture()
    await writeFile(path.join(store.paths.rawKnowledgePath, 'manual.md'), 'Manual policy evidence.')
    await writeFile(path.join(store.paths.rawKnowledgePath, 'file.md'), 'Repository file evidence.')
    const insert = store.database.prepare(`INSERT INTO knowledge_sources (id,kind,display_name,relative_or_external_location,status,created_at,updated_at)
      VALUES (?,?,?,?,'indexed',?,?)`)
    for (const [id, kind, filename] of [['manual-legacy', 'manual', 'manual.md'], ['file-legacy', 'file', 'file.md'], ['missing-legacy', 'file', 'missing.md']]) {
      insert.run(id, kind, id, `knowledge/raw/${filename}`, store.project.createdAt, store.project.createdAt)
    }
    expect(catalog.migrateLegacySources()).toBe(2)
    expect(catalog.getSource('manual-legacy')).toMatchObject({ kind: 'manual', state: 'ready' })
    expect(catalog.getSource('file-legacy')).toMatchObject({ kind: 'file', state: 'ready' })
    expect(catalog.getSource('missing-legacy')).toMatchObject({ state: 'unavailable', currentRevisionId: undefined })
    expect(catalog.getDetail('missing-legacy').revisions).toEqual([])
    expect(catalog.search('evidence')).toHaveLength(2)
  })
  it('keeps intake failures retryable only when recovery can succeed and cancels paused retry work', async () => {
    const { catalog, clock } = await fixture()
    const source = catalog.registerSource({ kind: 'manual', title: 'Retry classification', canonicalUri: 'manual://retry-classification' })
    catalog.listInvalidations()
    const job = catalog.queueImport(source.id, 'classification')
    await catalog.processNext(async () => { throw new Error('Temporary acquisition error.') })
    expect(catalog.listJobs()[0]).toMatchObject({ status: 'failed', nextAttemptAt: expect.any(String) })
    catalog.retryJob(job.id)
    await catalog.processNext(async () => { throw new WorkstackError('INTERNAL_ERROR', 'An adapter is temporarily unavailable.') })
    expect(catalog.listJobs()[0].nextAttemptAt).not.toBeNull()
    catalog.retryJob(job.id)
    await catalog.processNext(async () => ({ original: '' }))
    expect(catalog.listJobs()[0]).toMatchObject({ status: 'failed', nextAttemptAt: null })
    catalog.retryJob(job.id)
    await catalog.processNext(async () => ({ unavailable: true, deleted: true, reason: 'Removed upstream.' }))
    expect(catalog.listJobs()[0].nextAttemptAt).toBeNull()
    catalog.retryJob(job.id)
    await catalog.processNext(async () => ({ unavailable: true, reason: 'Access temporarily unavailable.' }))
    expect(catalog.listJobs()[0].nextAttemptAt).not.toBeNull()
    catalog.updatePolicy(source.id, 'paused')
    clock.advance(120_000)
    expect(await catalog.processNext(async () => { throw new Error('Paused acquisition must not run.') })).toMatchObject({ id: job.id, stage: 'cancelled' })
    const partial = catalog.publishRevision({ sourceId: source.id, original: 'Partial preserved text.', outcome: 'partial' })
    expect(catalog.getSource(source.id).staleReason).toBe('Source conversion is partial.')
    expect(partial.manifest.completeness).toBe('partial')
    catalog.updatePolicy(source.id, 'import_once')
    catalog.publishRevision({ sourceId: source.id, original: 'Complete source.', upstreamRevision: 'one' })
    expect(catalog.recordFreshness(source.id, {})).toMatchObject({ state: 'ready', observedUpstreamRevision: 'one' })
  })
  it('keeps invalid legacy locations and bounded conversion failures isolated from project startup', async () => {
    const { store, catalog } = await fixture()
    await writeFile(path.join(store.project.rootPath, 'outside-project-data.md'), 'Owned temporary fixture; migration must stay within project data.')
    await writeFile(path.join(store.paths.rawKnowledgePath, 'oversized.md'), 'x'.repeat(2_000_001))
    await writeFile(path.join(store.paths.rawKnowledgePath, 'conversion.md'), 'A readable legacy document.')
    const insert = store.database.prepare(`INSERT INTO knowledge_sources (id,kind,display_name,relative_or_external_location,status,created_at,updated_at)
      VALUES (?, 'file', ?, ?, 'indexed', ?, ?)`)
    for (const [id, location] of [['outside', '../outside-project-data.md'], ['oversized', 'knowledge/raw/oversized.md'], ['conversion', 'knowledge/raw/conversion.md']]) {
      insert.run(id, id, location, store.project.createdAt, store.project.createdAt)
    }
    vi.spyOn(catalog, 'publishRevision').mockImplementationOnce(() => { throw 'Converter unavailable.' })
    expect(catalog.migrateLegacySources()).toBe(0)
    expect(catalog.getSource('outside').staleReason).toContain('leaves project data')
    expect(catalog.getSource('oversized').staleReason).toContain('byte limit')
    expect(catalog.getSource('conversion').staleReason).toBe('Converter unavailable.')
    expect(catalog.listSources().every((source) => source.state === 'unavailable')).toBe(true)
  })
  it('retains fenced structure at exact chunk boundaries and rejects invalid chunk sizes', () => {
    const text = '```\nabc\n```\nplain\n'
    const passages = splitSourcePassages(text, 4)
    expect(passages.map((passage) => passage.text).join('')).toBe(text)
    expect(passages.slice(0, 3).every((passage) => passage.structure.kind === 'code')).toBe(true)
    expect(passages.at(-1)?.structure.kind).toBe('markdown')
    expect(splitSourcePassages('😀😀a', 2).map((passage) => passage.text)).toEqual(['😀', '😀', 'a'])
    for (const invalid of [0, 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => splitSourcePassages('text', invalid)).toThrow('integer')
  })
})

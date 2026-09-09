import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../../shared/desktop-api'
import type { ProjectSource, SourceCitation, SourceCitationRead, SourceDetail, SourcePassage, SourcePolicy, SourceRevisionRead } from '../../core/source-catalog'
import { Modal } from './Modal'

const policyNames: Record<SourcePolicy, string> = { import_once: 'Import once', tracked_content: 'Track content', metadata_only: 'Check metadata only', paused: 'Paused' }
const policyDescriptions: Record<SourcePolicy, string> = {
  import_once: 'Keep this snapshot without scheduled refreshes.',
  tracked_content: 'Check the origin on schedule and publish a new revision when its content changes.',
  metadata_only: 'Check the origin revision without fetching or publishing full content updates.',
  paused: 'Stop scheduled refreshes. Retained revisions remain available for inspection.'
}
const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const timestamp = (value?: string): string => value ? new Date(value).toLocaleString() : 'Not yet'
const readinessLabel = (value: ProjectSource['state']): string => ({ ready: 'Ready', stale: 'Stale', refresh_pending: 'Refresh pending', unavailable: 'Unavailable' })[value]

export function SourceCatalogPanel({ api, projectId, onImport, onSourcesChanged }: { api: DesktopApi; projectId: string; onImport(): void; onSourcesChanged(ids: string[]): void }): JSX.Element {
  const [sources, setSources] = useState<ProjectSource[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SourcePassage[]>([])
  const [searching, setSearching] = useState(false)
  const [citation, setCitation] = useState<SourceCitation>()
  const mounted = useRef(true)
  const searchGeneration = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.sourceCatalog.list(projectId)
      if (mounted.current) { setSources(next); onSourcesChanged(next.map((source) => source.id)); setError(undefined) }
    } catch (reason) { if (mounted.current) setError(messageFor(reason)) }
    finally { if (mounted.current) setLoading(false) }
  }, [api, projectId, onSourcesChanged])
  useEffect(() => {
    mounted.current = true
    let timer: number | undefined
    const poll = async (): Promise<void> => { await refresh(); if (mounted.current) timer = window.setTimeout(() => void poll(), 5_000) }
    void poll()
    return () => { mounted.current = false; window.clearTimeout(timer) }
  }, [refresh])
  const search = (value: string): void => {
    setQuery(value)
    const generation = ++searchGeneration.current
    setResults([])
    setSearching(Boolean(value.trim()))
    if (!value.trim()) return
    void api.sourceCatalog.search(projectId, value).then((found) => {
      if (mounted.current && generation === searchGeneration.current) setResults(found)
    }).catch((reason) => { if (mounted.current && generation === searchGeneration.current) setError(messageFor(reason)) })
      .finally(() => { if (mounted.current && generation === searchGeneration.current) setSearching(false) })
  }
  return <section className="source-catalog" aria-labelledby="source-catalog-heading">
    <div className="source-section-heading"><div><h2 id="source-catalog-heading">Source library</h2><p className="muted">Revisioned project evidence. Only complete, current sources are ready for task context.</p></div><button className="secondary-button" type="button" onClick={onImport}>Import project sources</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <label className="search-field"><span className="sr-only">Search source passages</span><input type="search" aria-label="Search source passages" placeholder="Find an exact source passage" maxLength={500} value={query} onChange={(event) => search(event.target.value)} /></label>
    {query ? <div className="source-passage-results" aria-live="polite">
      {searching ? <p className="muted">Searching source passages…</p> : results.length ? <ul>{results.map((passage) => <li key={passage.citation.passageId}><button className="retrieval-result" type="button" onClick={() => setCitation(passage.citation)}><strong>{passage.title}</strong><span>{passage.citation.headingTrail.join(' › ') || 'Document'} · lines {passage.citation.startLine}–{passage.citation.endLine}</span><span className="source-excerpt">{passage.text}</span><small>Revision {passage.citation.revisionId} · {readinessLabel(passage.readiness)}</small></button></li>)}</ul> : <p className="muted">No current, ready source passage matches. Inspect stale or unavailable sources below.</p>}
    </div> : null}
    {loading ? <p className="muted" role="status">Loading source library…</p> : sources.length ? <ul className="source-catalog-list">{sources.map((source) => <li key={source.id}>
      <button className="source-title-button" type="button" onClick={() => setSelected(source.id)}>{source.title}</button>
      <span className={`source-readiness source-readiness-${source.state}`}>{readinessLabel(source.state)}</span>
      <small>{source.kind.replaceAll('_', ' ')} · {policyNames[source.policy]}</small>
      <small className="source-origin">{source.repositoryPath ?? source.canonicalUri}</small>
      {source.staleReason ? <p className="source-state-reason">{source.staleReason}</p> : null}
      <small>Last successful check: {timestamp(source.lastSuccessfulCheckAt)}</small>
    </li>)}</ul> : <p className="muted">Import selected repository documentation or GitHub discussions to build reusable context.</p>}
    {selected && !citation ? <SourceDetailDialog api={api} projectId={projectId} sourceId={selected} onClose={() => { setSelected(undefined); void refresh() }} /> : null}
    {citation ? <SourceCitationReader api={api} projectId={projectId} citation={citation} onClose={() => setCitation(undefined)} /> : null}
  </section>
}

export function SourceDetailDialog({ api, projectId, sourceId, onClose }: { api: DesktopApi; projectId: string; sourceId: string; onClose(): void }): JSX.Element {
  const [detail, setDetail] = useState<SourceDetail>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [policy, setPolicy] = useState<SourcePolicy>()
  const [refreshMinutes, setRefreshMinutes] = useState('60')
  const [revisionId, setRevisionId] = useState<string>()
  const [refreshKey, setRefreshKey] = useState(0)
  const mutation = useRef(false)
  useEffect(() => {
    let current = true
    let timer: number | undefined
    const load = async (): Promise<void> => {
      try {
        const next = await api.sourceCatalog.detail(projectId, sourceId)
        if (current) { setDetail(next); setPolicy((value) => value ?? next.source.policy) }
      } catch (reason) { if (current) setError(messageFor(reason)) }
      if (current) timer = window.setTimeout(() => void load(), 3_000)
    }
    void load()
    return () => { current = false; window.clearTimeout(timer) }
  }, [api, projectId, sourceId, refreshKey])
  const refreshSeconds = detail?.source.refreshSeconds
  useEffect(() => { if (refreshSeconds !== undefined) setRefreshMinutes(String(refreshSeconds / 60)) }, [refreshSeconds])
  const act = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
    if (mutation.current) return
    mutation.current = true
    setBusy(name); setError(undefined)
    try { await operation(); setRefreshKey((value) => value + 1) }
    catch (reason) { setError(messageFor(reason)) }
    finally { mutation.current = false; setBusy(undefined) }
  }
  if (revisionId) return <SourceRevisionReader api={api} projectId={projectId} sourceId={sourceId} revisionId={revisionId} onClose={() => setRevisionId(undefined)} />
  return <Modal className="source-detail-dialog" title={detail?.source.title ?? 'Source details'} onCancel={onClose}>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {!detail ? <p role="status">Loading source history…</p> : <>
      <p><span className={`source-readiness source-readiness-${detail.source.state}`}>{readinessLabel(detail.source.state)}</span> · {detail.source.kind.replaceAll('_', ' ')}</p>
      {detail.source.staleReason ? <p className="source-notice">{detail.source.staleReason}</p> : null}
      <dl className="source-facts"><dt>Origin</dt><dd>{detail.source.canonicalUri}</dd>{detail.source.repositoryPath ? <><dt>Repository path</dt><dd>{detail.source.repositoryPath}</dd></> : null}<dt>Latest attempt</dt><dd>{timestamp(detail.source.lastAttemptAt)}</dd><dt>Successful check</dt><dd>{timestamp(detail.source.lastSuccessfulCheckAt)}</dd><dt>Content changed</dt><dd>{timestamp(detail.source.lastContentChangeAt)}</dd><dt>Next refresh</dt><dd>{detail.source.nextRefreshAt ? timestamp(detail.source.nextRefreshAt) : 'Not scheduled'}</dd>{detail.source.workItemId ? <><dt>Related task</dt><dd>{detail.source.workItemId}</dd></> : null}</dl>
      <form className="source-policy-form" onSubmit={(event) => { event.preventDefault(); if (policy) void act('policy', () => api.sourceCatalog.setPolicy(projectId, sourceId, policy, Number(refreshMinutes) * 60)) }}>
        <label className="field-label">Refresh policy<select aria-label="Refresh policy" value={policy ?? detail.source.policy} onChange={(event) => setPolicy(event.target.value as SourcePolicy)}>{Object.entries(policyNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <p className="muted">{policyDescriptions[policy ?? detail.source.policy]}</p>
        {policy === 'tracked_content' || policy === 'metadata_only' ? <label className="field-label">Refresh every (minutes)<input aria-label="Refresh interval in minutes" type="number" min={1} max={43200} required value={refreshMinutes} onChange={(event) => setRefreshMinutes(event.target.value)} /></label> : null}
        <div className="toolbar-actions"><button className="secondary-button" type="submit" disabled={Boolean(busy)}>Save policy</button>{api.sourceCatalog.refresh ? <button className="secondary-button" type="button" disabled={Boolean(busy) || detail.source.policy === 'paused'} onClick={() => void act('refresh', () => api.sourceCatalog.refresh(projectId, sourceId))}>Check origin now</button> : null}</div>
      </form>
      <h3>Intake progress</h3>
      {detail.jobs.length ? <ul className="source-job-list">{detail.jobs.map((job) => <li key={job.id}><strong>{job.stage} · {job.status}</strong><span>Attempt {job.attempts} · updated {timestamp(job.updatedAt)}</span>{job.errorMessage ? <p className="inline-error">{job.errorMessage}</p> : null}{job.nextAttemptAt ? <small>Next automatic retry: {timestamp(job.nextAttemptAt)}</small> : null}<div className="toolbar-actions">{job.status === 'failed' ? <button className="secondary-button" type="button" disabled={Boolean(busy) || detail.source.policy === 'paused'} onClick={() => void act(job.id, () => api.sourceCatalog.retry(projectId, job.id))}>{busy === job.id ? 'Queueing…' : 'Retry this intake'}</button> : job.status !== 'completed' ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act(job.id, () => api.sourceCatalog.cancel(projectId, job.id))}>Cancel intake</button> : null}</div></li>)}</ul> : <p className="muted">No queued intake. Imported revisions are listed below.</p>}
      <h3>Retained revisions</h3>
      {detail.revisions.length ? <ul className="source-revision-list">{detail.revisions.map((revision) => <li key={revision.id}><strong>{revision.id === detail.source.currentRevisionId ? 'Current revision' : 'Historical or unpublished revision'} · {revision.outcome}</strong><small>Acquired {timestamp(revision.acquiredAt)} by {revision.acquiredBy}</small><small>Converted with {revision.converter} {revision.converterVersion} · {revision.manifest.passages} passages</small><code>{revision.id}</code><small>Content SHA-256: {revision.contentHash}</small>{revision.upstreamRevision ? <small>Upstream revision: {revision.upstreamRevision}</small> : null}{revision.manifest.limitations.length ? <ul>{revision.manifest.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul> : null}<button className="secondary-button" type="button" onClick={() => setRevisionId(revision.id)}>Inspect retained evidence</button></li>)}</ul> : <p className="muted">No ready revision has been published. Acquisition must complete before this source can supply task context.</p>}
      <details><summary>Import attempt history ({detail.attempts.length})</summary><ol className="source-job-list">{detail.attempts.map((attempt) => <li key={attempt.id}><strong>{attempt.stage} · {attempt.outcome}</strong><small>Attempt {attempt.attempt} · {timestamp(attempt.createdAt)}</small>{attempt.message ? <p>{attempt.message}</p> : null}</li>)}</ol></details>
    </>}
  </Modal>
}

export function SourceCitationReader({ api, projectId, citation, onClose }: { api: DesktopApi; projectId: string; citation: SourceCitation; onClose(): void }): JSX.Element {
  const [read, setRead] = useState<SourceCitationRead>()
  const [error, setError] = useState<string>()
  const [neighbors, setNeighbors] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setLoading(true); setError(undefined)
    void api.sourceCatalog.readCitation(projectId, citation, neighbors).then((value) => { if (current) setRead(value) }).catch((reason) => { if (current) setError(messageFor(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, citation, neighbors])
  const passages = read ? [...read.neighbors, read.passage].sort((left, right) => left.citation.startOffset - right.citation.startOffset) : []
  return <Modal className="source-detail-dialog" title={read?.passage.title ?? 'Source citation'} onCancel={onClose}>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Reading immutable evidence…</p> : null}
    {read ? <>
      {read.passage.historical ? <p className="source-notice" role="status">Historical revision. This is the exact evidence originally cited; a newer revision exists.</p> : null}
      {read.passage.readiness !== 'ready' ? <p className="source-notice" role="status">Source is {readinessLabel(read.passage.readiness).toLowerCase()}. This retained evidence has not passed the current freshness check.</p> : null}
      <p className="muted">{read.passage.canonicalUri}</p>
      <details className="source-citation-facts"><summary>Exact citation and hashes</summary><dl className="source-facts"><dt>Locator</dt><dd>{citation.locator}</dd><dt>Revision</dt><dd>{citation.revisionId}</dd><dt>Source hash</dt><dd>{citation.contentHash}</dd><dt>Normalized hash</dt><dd>{citation.normalizedHash}</dd><dt>Passage hash</dt><dd>{citation.passageHash}</dd><dt>Span</dt><dd>Lines {citation.startLine}–{citation.endLine}; characters {citation.startOffset}–{citation.endOffset}</dd></dl></details>
      <div className="toolbar-actions"><button className="secondary-button" type="button" disabled={loading || neighbors >= 3} onClick={() => setNeighbors((count) => count === 0 ? 1 : 3)}>{neighbors === 0 ? 'Show neighboring passages' : neighbors < 3 ? 'Show more neighboring passages' : 'Neighbor limit reached'}</button><small>Read budget: {read.maxCharacters.toLocaleString()} characters</small></div>
      {read.truncated ? <p className="source-notice">Some neighboring passages were omitted to keep this read within its budget.</p> : null}
      {passages.map((passage) => <section className={`source-passage ${passage.citation.passageId === citation.passageId ? 'source-passage-cited' : ''}`} key={passage.citation.passageId} aria-label={passage.citation.passageId === citation.passageId ? 'Cited passage' : 'Neighboring passage'}><h3>{passage.citation.headingTrail.join(' › ') || 'Document'} <small>· lines {passage.citation.startLine}–{passage.citation.endLine}</small></h3>{passage.structure.continued ? <p className="muted">Continuation of {passage.structure.kind === 'code' ? 'a code block' : 'a source section'}.</p> : null}<pre className="source-passage-text">{passage.text}</pre></section>)}
    </> : null}
  </Modal>
}

function SourceRevisionReader({ api, projectId, sourceId, revisionId, onClose }: { api: DesktopApi; projectId: string; sourceId: string; revisionId: string; onClose(): void }): JSX.Element {
  const [read, setRead] = useState<SourceRevisionRead>()
  const [representation, setRepresentation] = useState<'original' | 'normalized'>('normalized')
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setLoading(true); setError(undefined)
    void api.sourceCatalog.readRevision(projectId, sourceId, revisionId, representation, offset).then((value) => { if (current) setRead(value) }).catch((reason) => { if (current) setError(messageFor(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, sourceId, revisionId, representation, offset])
  return <Modal className="source-detail-dialog" title="Retained source evidence" onCancel={onClose}>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <p className="muted">Revision {revisionId}</p>
    <label className="field-label">Evidence representation<select aria-label="Evidence representation" value={representation} onChange={(event) => { setRepresentation(event.target.value as 'original' | 'normalized'); setOffset(0) }}><option value="normalized">Normalized evidence</option><option value="original">Original evidence</option></select></label>
    <p className="muted">{representation === 'original' ? 'Original source text retained for local inspection.' : 'Normalized text is the representation used for passage citations.'}</p>
    {loading ? <p role="status">Reading retained evidence…</p> : read ? <><p>{read.revision.outcome} · characters {read.offset}–{read.offset + read.text.length} of {read.totalCharacters}</p><pre className="source-passage-text">{read.text || 'This representation contains no text.'}</pre><div className="toolbar-actions"><button className="secondary-button" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 16_000))}>Previous section</button><button className="secondary-button" type="button" disabled={!read.truncated} onClick={() => setOffset(read.offset + read.text.length)}>Next section</button></div></> : null}
  </Modal>
}

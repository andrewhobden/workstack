import { useEffect, useRef, useState } from 'react'
import type { WikiRevision, WikiRevisionReview } from '../../core/wiki-revisions'
import type { DesktopApi } from '../../shared/desktop-api'
import { Modal } from './Modal'

const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

export function WikiReviewPanel({ api, projectId, onPublished }: { api: DesktopApi; projectId: string; onPublished(): void }): JSX.Element {
  const [revisions, setRevisions] = useState<WikiRevision[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    let current = true
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try { const values = await api.wikiRevisions.list(projectId); if (current) { setRevisions(values); setError(undefined) } }
      catch (reason) { if (current) setError(messageFor(reason)) }
      if (current) timer = window.setTimeout(() => void poll(), 5_000)
    }
    void poll()
    return () => { current = false; window.clearTimeout(timer) }
  }, [api, projectId, refreshKey])
  return <section className="source-catalog" aria-labelledby="wiki-review-heading">
    <h2 id="wiki-review-heading">Wiki review and history</h2>
    <p className="muted">Generated changes become maintained knowledge after review. Previous published revisions remain available.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {revisions.length ? <ul className="source-catalog-list">{revisions.map((revision) => <li key={revision.id}><button className="source-title-button" type="button" onClick={() => setSelected(revision.id)}>{revision.title}</button><span className="source-readiness">{revision.status === 'proposed' ? 'Needs review' : revision.status}</span><small>By {revision.author} · {new Date(revision.createdAt).toLocaleString()}</small>{revision.actor ? <small>Reviewed by {revision.actor}{revision.reviewedAt ? ` · ${new Date(revision.reviewedAt).toLocaleString()}` : ''}</small> : null}</li>)}</ul> : <p className="muted">No wiki revisions yet. A completed generation run will appear here for review.</p>}
    {selected ? <WikiRevisionDialog api={api} projectId={projectId} revisionId={selected} onClose={() => setSelected(undefined)} onChanged={() => { setRefreshKey((key) => key + 1); onPublished() }} /> : null}
  </section>
}

function WikiRevisionDialog({ api, projectId, revisionId, onClose, onChanged }: { api: DesktopApi; projectId: string; revisionId: string; onClose(): void; onChanged(): void }): JSX.Element {
  const [review, setReview] = useState<WikiRevisionReview>()
  const [error, setError] = useState<string>()
  const [actor, setActor] = useState('local-user')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string>()
  const [selectedSlug, setSelectedSlug] = useState<string>()
  const locked = useRef(false)
  const reload = async (id: string): Promise<void> => { setReview(await api.wikiRevisions.review(projectId, id)) }
  useEffect(() => {
    let current = true
    void api.wikiRevisions.review(projectId, revisionId).then((value) => { if (current) { setReview(value); setSelectedSlug(value.changes[0]?.slug) } }).catch((reason) => { if (current) setError(messageFor(reason)) })
    return () => { current = false }
  }, [api, projectId, revisionId])
  const act = async (action: 'publish' | 'reject' | 'restore' | 'reconcile'): Promise<void> => {
    if (locked.current || !actor.trim()) return
    if (action !== 'publish' && !note.trim()) { setError('Enter a reason before rejecting, reconciling, or restoring a revision.'); return }
    locked.current = true; setBusy(action); setError(undefined)
    try {
      const targetId = review?.revision.id ?? revisionId
      if (action === 'publish') setReview(await api.wikiRevisions.publish(projectId, targetId, actor, note))
      else if (action === 'reject') { await api.wikiRevisions.reject(projectId, targetId, actor, note); await reload(targetId) }
      else if (action === 'reconcile') setReview(await api.wikiRevisions.reconcile(projectId, targetId, actor, note))
      else setReview(await api.wikiRevisions.restore(projectId, targetId, actor, note))
      onChanged()
    } catch (reason) { setError(messageFor(reason)) }
    finally { locked.current = false; setBusy(undefined) }
  }
  const change = review?.changes.find((entry) => entry.slug === selectedSlug) ?? review?.changes[0]
  return <Modal className="source-detail-dialog wiki-review-dialog" title={review?.revision.title ?? 'Review wiki revision'} onCancel={onClose}>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {!review ? <p role="status">Loading proposed changes…</p> : <>
      <p><strong>{review.revision.status === 'proposed' ? 'Awaiting review' : review.revision.status}</strong> · by {review.revision.author}</p>
      <p className="source-notice">{review.revision.rationale}</p>
      <dl className="source-facts"><dt>Revision</dt><dd>{review.revision.id}</dd><dt>Based on</dt><dd>{review.revision.baseRevisionId ?? 'No previous generated revision'}</dd><dt>Created</dt><dd>{new Date(review.revision.createdAt).toLocaleString()}</dd>{review.revision.actor ? <><dt>Reviewer</dt><dd>{review.revision.actor}</dd><dt>Review note</dt><dd>{review.revision.reviewNote || 'No note supplied'}</dd></> : null}</dl>
      <details><summary>Supporting evidence</summary>{Object.entries(review.revision.evidence).length ? <dl className="source-facts">{Object.entries(review.revision.evidence).map(([name, value]) => <div key={name}><dt>{name.replaceAll('_', ' ')}</dt><dd><pre className="source-passage-text">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></dd></div>)}</dl> : <p className="muted">No supporting evidence was attached.</p>}</details>
      {review.changes.length ? <>
        <label className="field-label">Changed article<select aria-label="Changed article" value={change?.slug} onChange={(event) => setSelectedSlug(event.target.value)}>{review.changes.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.slug}{!entry.before ? ' (new)' : !entry.after ? ' (removed)' : ''}</option>)}</select></label>
        {change ? <div className="wiki-source-comparison"><section aria-label="Previous article"><h3>Before</h3><pre className="source-passage-text">{change.before || 'No previous article.'}</pre></section><section aria-label="Proposed article"><h3>{review.revision.status === 'proposed' ? 'Proposed' : 'After'}</h3><pre className="source-passage-text">{change.after || 'Article removed.'}</pre></section></div> : null}
      </> : <p className="muted">This revision has no changed articles.</p>}
      {review.revision.status === 'proposed' || review.revision.status === 'superseded' ? <form onSubmit={(event) => { event.preventDefault(); void act(review.revision.status === 'proposed' ? 'publish' : 'restore') }}>
        <label className="field-label">Reviewer identity<input aria-label="Reviewer identity" required maxLength={200} value={actor} onChange={(event) => setActor(event.target.value)} /></label>
        <label className="field-label">Review note or reason<textarea aria-label="Review note or reason" maxLength={20_000} required={review.revision.status === 'superseded'} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <p className="muted">{review.revision.status === 'proposed' ? 'Publishing makes these pages available to task context. A reason is required to reject them.' : 'Restoring publishes the selected snapshot as a new audited revision. Enter the reason for the restoration.'}</p>
        <div className="modal-actions">{review.revision.status === 'proposed' ? <button className="secondary-button" type="button" disabled={Boolean(busy) || !actor.trim()} onClick={() => void act('reconcile')}>Reconcile with current</button> : null}{review.revision.status === 'proposed' ? <button className="secondary-button" type="button" disabled={Boolean(busy) || !actor.trim()} onClick={() => void act('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject proposal'}</button> : null}<button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy ? 'Saving review…' : review.revision.status === 'proposed' ? 'Publish reviewed revision' : 'Restore this revision'}</button></div>
      </form> : null}
    </>}
  </Modal>
}

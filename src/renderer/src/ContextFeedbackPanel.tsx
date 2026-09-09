import { useEffect, useRef, useState } from 'react'
import type { ContextFeedback, ContextFeedbackEvent, ContextFeedbackInput, ContextFeedbackTriage } from '../../core/context-feedback-contracts'
import type { ContextPacket } from '../../core/context-packet-contracts'
import type { ProjectSource } from '../../core/source-catalog'
import type { DesktopApi } from '../../shared/desktop-api'

const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const label = (value: string): string => value.replaceAll('_', ' ')

export function ContextFeedbackPanel({ api, projectId, packet, sources }: { api: DesktopApi; projectId: string; packet: ContextPacket; sources: ProjectSource[] }): JSX.Element {
  const [feedback, setFeedback] = useState<ContextFeedback[]>([])
  const [error, setError] = useState<string>()
  const [category, setCategory] = useState<ContextFeedbackInput['category']>('missing_context')
  const [note, setNote] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [actor, setActor] = useState('local-user')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const lock = useRef(false)
  useEffect(() => {
    let current = true
    void api.contextFeedback.list(projectId, { packetId: packet.id }).then((values) => { if (current) setFeedback(values) }).catch((reason) => { if (current) setError(messageFor(reason)) })
    return () => { current = false }
  }, [api, projectId, packet.id, revision])
  const submit = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setSaved(false)
    try { await api.contextFeedback.create(projectId, { packetId: packet.id, workItemId: packet.workItemId, category, note, sourceIds, actor, authorKind: 'human' }); setNote(''); setSourceIds([]); setSaved(true); setRevision((value) => value + 1) }
    catch (reason) { setError(messageFor(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <details className="context-feedback-panel"><summary>Context feedback and follow-up ({feedback.length})</summary>
    <p className="muted">Record missing, stale, or incorrect evidence against this exact packet. Reports begin as proposals for review.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{saved ? <p role="status">Context feedback saved for review.</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}><fieldset className="source-import-fields" disabled={busy}>
      <label className="field-label">Feedback category<select aria-label="Context feedback category" value={category} onChange={(event) => setCategory(event.target.value as ContextFeedbackInput['category'])}>{['missing_context', 'incorrect_context', 'stale_context', 'citation', 'other'].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label className="field-label">What needs to change?<textarea aria-label="Context feedback note" required maxLength={20_000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <details><summary>Related sources</summary><div className="directory-split-selections">{sources.map((source) => <label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={(event) => setSourceIds((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} />{source.title}</label>)}</div></details>
      <label className="field-label">Reporter identity<input aria-label="Context feedback reporter" required maxLength={200} value={actor} onChange={(event) => setActor(event.target.value)} /></label>
      <button className="secondary-button" type="submit">{busy ? 'Saving feedback…' : 'Record context feedback'}</button>
    </fieldset></form>
    <ul className="source-job-list">{feedback.map((entry) => <li key={entry.id}><strong>{label(entry.category)} · {entry.status}</strong><p>{entry.note}</p><small>{entry.authorKind} · {entry.actor} · {new Date(entry.createdAt).toLocaleString()}</small>{entry.sourceReferences.length ? <details><summary>Source revisions at report time</summary>{entry.sourceReferences.map((reference) => <p className="source-origin" key={reference.sourceId}>{sources.find((source) => source.id === reference.sourceId)?.title ?? reference.sourceId}: packet {reference.packetRevisionId ?? 'not included'}; reported current {reference.revisionId ?? 'unavailable'}</p>)}</details> : null}<FeedbackReview api={api} projectId={projectId} feedback={entry} onChanged={() => setRevision((value) => value + 1)} /></li>)}</ul>
  </details>
}

function FeedbackReview({ api, projectId, feedback, onChanged }: { api: DesktopApi; projectId: string; feedback: ContextFeedback; onChanged(): void }): JSX.Element {
  const [actor, setActor] = useState('local-user')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<ContextFeedbackTriage['status']>('triaged')
  const [action, setAction] = useState<ContextFeedbackTriage['action']>('knowledge_correction')
  const [target, setTarget] = useState('')
  const [events, setEvents] = useState<ContextFeedbackEvent[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const save = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try { await api.contextFeedback.triage(projectId, feedback.id, { expectedVersion: feedback.version, status, action, ...(target.trim() ? { target } : {}), actor, note }); setEvents(await api.contextFeedback.history(projectId, feedback.id)); setNote(''); onChanged() }
    catch (reason) { setError(messageFor(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <details><summary>Review feedback</summary>{feedback.triageNote ? <p>Latest review: {feedback.triageNote} · {feedback.triagedBy}</p> : null}{error ? <p className="inline-error" role="alert">{error}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void save() }}><fieldset className="source-import-fields" disabled={busy}><div className="knowledge-filter-row"><label className="field-label">Review outcome<select aria-label="Feedback review outcome" value={status} onChange={(event) => setStatus(event.target.value as ContextFeedbackTriage['status'])}><option value="triaged">Triaged</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label><label className="field-label">Follow-up action<select aria-label="Feedback follow-up action" value={action} onChange={(event) => setAction(event.target.value as ContextFeedbackTriage['action'])}><option value="knowledge_correction">Knowledge correction</option><option value="fixture">Regression test case</option><option value="no_change">No change</option></select></label></div><label className="field-label">Follow-up reference<input aria-label="Feedback follow-up reference" placeholder="Issue, knowledge record, or test case" value={target} onChange={(event) => setTarget(event.target.value)} /></label><label className="field-label">Review note<textarea aria-label="Feedback review note" required value={note} onChange={(event) => setNote(event.target.value)} /></label><label className="field-label">Reviewer identity<input aria-label="Feedback reviewer identity" required value={actor} onChange={(event) => setActor(event.target.value)} /></label><button className="secondary-button" type="submit">Save feedback review</button></fieldset></form>
    <p className="muted">This records a follow-up decision. Knowledge changes and new test cases are reviewed in their own workflows.</p>
    <details onToggle={(event) => { if (event.currentTarget.open) void api.contextFeedback.history(projectId, feedback.id).then(setEvents).catch((reason) => setError(messageFor(reason))) }}><summary>Feedback history</summary><ol className="source-job-list">{events.map((entry) => <li key={entry.id}><strong>{entry.snapshot.status} · {entry.actor}</strong><p>{entry.note}</p><small>{new Date(entry.createdAt).toLocaleString()}</small></li>)}</ol></details>
  </details>
}

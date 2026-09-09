import { useEffect, useRef, useState } from 'react'
import { recordStatuses, type KnowledgeFinding, type KnowledgeRecord, type KnowledgeRecordHistory, type KnowledgeRecordInput, type KnowledgeRecordKind, type KnowledgeRecordStatus, type KnowledgeReference, type KnowledgeReview } from '../../core/knowledge-record-contracts'
import type { SourceCitation } from '../../core/source-catalog'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import { KnowledgeReferenceFields } from './KnowledgeReferenceFields'
import { referenceLabel } from './knowledge-reference-label'
import { MarkdownDocument } from './MarkdownDocument'
import { Modal } from './Modal'
import { SourceCitationReader } from './SourceCatalogPanel'

const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const readable = (value: string): string => value.replaceAll('_', ' ')

export function KnowledgeRecordsPanel({ api, projectId, workItems, initialRecordId, onClose }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; initialRecordId?: string; onClose(): void }): JSX.Element {
  const [records, setRecords] = useState<KnowledgeRecord[]>([])
  const [findings, setFindings] = useState<KnowledgeFinding[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string | undefined>(initialRecordId)
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState('all')
  useEffect(() => {
    let current = true
    setLoading(true)
    void Promise.all([api.knowledgeRecords.list(projectId), api.knowledgeRecords.checks(projectId)]).then(([items, checks]) => { if (current) { setRecords(items); setFindings(checks); setError(undefined) } }).catch((reason) => { if (current) setError(messageFor(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, revision])
  if (selected) return <KnowledgeRecordDialog key={selected} api={api} projectId={projectId} workItems={workItems} recordId={selected === 'new' ? undefined : selected} records={records} onClose={() => { setSelected(undefined); setRevision((value) => value + 1) }} />
  const visible = records.filter((record) => (kind === 'all' || record.kind === kind) && `${record.title} ${record.markdown} ${record.status}`.toLowerCase().includes(filter.toLowerCase()))
  return <Modal className="source-detail-dialog" title="Decisions, requirements and risks" onCancel={onClose}>
    <p className="muted">Keep governing decisions, requirements, and open risks explicit. A review records whether guidance still holds; an edit preserves a separate history.</p>
    <div className="toolbar-actions"><button className="primary-button" type="button" onClick={() => setSelected('new')}>New knowledge record</button><button className="secondary-button" type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Run knowledge checks</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Loading records and checks…</p> : null}
    <details open={findings.length > 0}><summary>Knowledge checks ({findings.length})</summary>{findings.length ? <ul className="source-job-list">{findings.map((finding) => <li key={finding.id}><strong>{finding.severity} · {readable(finding.code)}</strong><p>{finding.reason}</p><p className="muted">{finding.action}</p><button className="secondary-button" type="button" onClick={() => setSelected(finding.recordId)}>Review {records.find((record) => record.id === finding.recordId)?.title ?? 'affected record'}</button></li>)}</ul> : <p className="muted">No current findings. Age prompts review; it does not prove a record is wrong.</p>}</details>
    <div className="knowledge-filter-row"><label className="field-label">Record type<select aria-label="Filter knowledge record type" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All types</option><option value="decision">Decisions</option><option value="requirement">Requirements</option><option value="risk">Risks</option></select></label><label className="field-label">Find a record<input type="search" aria-label="Find knowledge records" value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
    {visible.length ? <ul className="source-catalog-list">{visible.map((record) => <li key={record.id}><button className="source-title-button" type="button" onClick={() => setSelected(record.id)}>{record.title}</button><span className="source-readiness">{record.kind} · {record.status} · {readable(record.readiness)}</span><small>{record.rationale || record.markdown.slice(0, 180)}</small>{record.supersededBy ? <small>Replaced by {records.find((candidate) => candidate.id === record.supersededBy)?.title ?? record.supersededBy}</small> : null}</li>)}</ul> : <p className="muted">No matching records. Add the decisions, requirements, and risks that agents need to understand.</p>}
  </Modal>
}

function KnowledgeRecordDialog({ api, projectId, workItems, recordId, records, onClose }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; recordId?: string; records: KnowledgeRecord[]; onClose(): void }): JSX.Element {
  const [record, setRecord] = useState<KnowledgeRecord>()
  const [history, setHistory] = useState<KnowledgeRecordHistory[]>([])
  const [reviews, setReviews] = useState<KnowledgeReview[]>([])
  const [loading, setLoading] = useState(Boolean(recordId))
  const [kind, setKind] = useState<KnowledgeRecordKind>('decision')
  const [status, setStatus] = useState<KnowledgeRecordStatus>('proposed')
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [rationale, setRationale] = useState('')
  const [references, setReferences] = useState<KnowledgeReference[]>([])
  const [confidence, setConfidence] = useState('')
  const [reviewDue, setReviewDue] = useState('')
  const [actor, setActor] = useState('local-user')
  const [reason, setReason] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [citation, setCitation] = useState<SourceCitation>()
  const lock = useRef(false)
  const adopt = (value: KnowledgeRecord): void => { setRecord(value); setKind(value.kind); setStatus(value.status); setTitle(value.title); setMarkdown(value.markdown); setRationale(value.rationale); setReferences(value.references); setConfidence(value.confidence === undefined ? '' : String(value.confidence)); setReviewDue(value.reviewDueAt?.slice(0, 10) ?? '') }
  useEffect(() => {
    let current = true
    if (recordId) void Promise.all([api.knowledgeRecords.get(projectId, recordId), api.knowledgeRecords.history(projectId, recordId), api.knowledgeRecords.reviews(projectId, recordId)]).then(([value, versions, recordReviews]) => { if (current) { adopt(value); setHistory(versions); setReviews(recordReviews) } }).catch((failure) => { if (current) setError(messageFor(failure)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, recordId])
  const mutate = async (operation: () => Promise<KnowledgeRecord>, message: string, preserveDraft = false): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setSaved(undefined)
    try { const value = await operation(); if (preserveDraft) setRecord(value); else adopt(value); const [versions, recordReviews] = await Promise.all([api.knowledgeRecords.history(projectId, value.id), api.knowledgeRecords.reviews(projectId, value.id)]); setHistory(versions); setReviews(recordReviews); setSaved(message); if (!preserveDraft) setReason('') }
    catch (failure) { setError(messageFor(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const save = async (): Promise<void> => {
    const input: KnowledgeRecordInput = { kind, title, status, markdown, rationale, references, ...(confidence !== '' ? { confidence: Number(confidence) } : {}), ...(reviewDue ? { reviewDueAt: new Date(`${reviewDue}T00:00:00.000Z`).toISOString() } : {}) }
    await mutate(() => record ? api.knowledgeRecords.update(projectId, record.id, { title, status, markdown, rationale, references, confidence: input.confidence ?? null, reviewDueAt: input.reviewDueAt ?? null, expectedVersion: record.version }, actor, reason) : api.knowledgeRecords.create(projectId, input, actor), 'Knowledge record saved. Editing does not add a substantive review.')
  }
  if (citation) return <SourceCitationReader api={api} projectId={projectId} citation={citation} onClose={() => setCitation(undefined)} />
  return <Modal className="source-detail-dialog" title={record?.title ?? 'New knowledge record'} onCancel={onClose}>
    {error ? <><p className="inline-error" role="alert">{error}</p>{record ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void mutate(() => api.knowledgeRecords.get(projectId, record.id), 'Loaded the latest saved record. The previous local draft was replaced.')}>Reload saved record and replace draft</button> : null}</> : null}{saved ? <p role="status">{saved}</p> : null}
    {loading ? <p role="status">Reading record history…</p> : <>
      {record ? <><p className="source-notice">{record.kind} · {record.status} · {readable(record.readiness)}{record.supersededBy ? ` · superseded by ${record.supersededBy}` : ''}</p><details><summary>Read saved record</summary><MarkdownDocument content={record.markdown} /><p>{record.rationale}</p><dl className="source-facts"><dt>Stable ID</dt><dd>{record.id}</dd><dt>Saved version</dt><dd>{record.version}</dd><dt>Last reviewed</dt><dd>{record.lastReviewedAt ? new Date(record.lastReviewedAt).toLocaleString() : 'Not reviewed'}</dd></dl><ul className="knowledge-reference-list">{record.references.map((reference, index) => <li key={index}>{reference.kind === 'source' ? <button type="button" className="source-title-button" onClick={() => setCitation(reference.citation)}>{referenceLabel(reference, workItems)}</button> : <span>{referenceLabel(reference, workItems)}</span>}</li>)}</ul></details></> : null}
      <form onSubmit={(event) => { event.preventDefault(); void save() }}><fieldset className="source-import-fields" disabled={busy}>
        <div className="knowledge-filter-row"><label className="field-label">Record type<select aria-label="Knowledge record type" value={kind} disabled={Boolean(record)} onChange={(event) => { const next = event.target.value as KnowledgeRecordKind; setKind(next); setStatus(recordStatuses[next][0]) }}><option value="decision">Decision</option><option value="requirement">Requirement</option><option value="risk">Risk</option></select></label><label className="field-label">Lifecycle status<select aria-label="Knowledge record status" value={status} onChange={(event) => setStatus(event.target.value as KnowledgeRecordStatus)}>{recordStatuses[kind].filter((value) => value !== 'superseded' || record?.status === 'superseded').map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
        <label className="field-label">Title<input aria-label="Knowledge record title" required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-label">Guidance or finding<textarea aria-label="Knowledge record content" required value={markdown} onChange={(event) => setMarkdown(event.target.value)} /></label>
        <label className="field-label">Rationale<textarea aria-label="Knowledge record rationale" maxLength={20_000} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
        <div className="knowledge-filter-row"><label className="field-label">Confidence (0–1, optional)<input aria-label="Knowledge record confidence" type="number" min={0} max={1} step={0.01} value={confidence} onChange={(event) => setConfidence(event.target.value)} /></label><label className="field-label">Review due (optional)<input aria-label="Knowledge review due date" type="date" value={reviewDue} onChange={(event) => setReviewDue(event.target.value)} /></label></div>
        <KnowledgeReferenceFields api={api} projectId={projectId} workItems={workItems} references={references} onChange={setReferences} />
        <label className="field-label">Editor identity<input aria-label="Knowledge editor identity" required maxLength={200} value={actor} onChange={(event) => setActor(event.target.value)} /></label>
        {record ? <label className="field-label">Reason for change<textarea aria-label="Knowledge change reason" required maxLength={20_000} value={reason} onChange={(event) => setReason(event.target.value)} /></label> : null}
        <div className="modal-actions"><button className="primary-button" type="submit">{busy ? 'Saving record…' : 'Save knowledge record'}</button></div>
      </fieldset></form>
      {record ? <>
        <details><summary>Review or supersede this record</summary><p className="muted">Reviewing checks the substance of the saved version. Supersession preserves its rationale and points to a replacement.</p><label className="field-label">Review note or supersession reason<textarea aria-label="Knowledge review note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label><div className="toolbar-actions"><button className="secondary-button" type="button" disabled={busy || !reviewNote.trim() || !actor.trim()} onClick={() => void mutate(async () => { await api.knowledgeRecords.review(projectId, record.id, actor, reviewNote, 'confirmed', record.version); return api.knowledgeRecords.get(projectId, record.id) }, 'Review recorded for the saved guidance.', true)}>Confirm saved guidance</button><button className="secondary-button" type="button" disabled={busy || !reviewNote.trim() || !actor.trim()} onClick={() => void mutate(async () => { await api.knowledgeRecords.review(projectId, record.id, actor, reviewNote, 'needs_changes', record.version); return api.knowledgeRecords.get(projectId, record.id) }, 'Requested changes to this record.', true)}>Request changes</button></div><label className="field-label">Replacement record<select aria-label="Superseding knowledge record" value={replacementId} onChange={(event) => setReplacementId(event.target.value)}><option value="">Choose a replacement</option>{records.filter((candidate) => candidate.id !== record.id && candidate.kind === record.kind && candidate.current).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label><button className="secondary-button" type="button" disabled={busy || !replacementId || !reviewNote.trim() || !actor.trim() || Boolean(record.supersededBy)} onClick={() => void mutate(() => api.knowledgeRecords.supersede(projectId, record.id, replacementId, actor, reviewNote), 'Record superseded; its history is retained.')}>Supersede with selected record</button></details>
        <details><summary>Review history ({reviews.length})</summary><ol className="source-job-list">{reviews.map((review) => <li key={review.id}><strong>{readable(review.outcome)} · {review.actor}</strong><small>Version {review.recordVersion} · {new Date(review.reviewedAt).toLocaleString()}</small><p>{review.note}</p></li>)}</ol></details>
        <details><summary>Saved history ({history.length})</summary><ol className="source-job-list">{history.map((version) => <li key={version.version}><strong>Version {version.version} · {version.actor}</strong><small>{new Date(version.changedAt).toLocaleString()}</small><p>{version.reason}</p><details><summary>Read version {version.version}</summary><p>{version.snapshot.status} · {version.snapshot.rationale}</p><pre className="source-passage-text">{version.snapshot.markdown}</pre></details></li>)}</ol></details>
      </> : null}
    </>}
  </Modal>
}

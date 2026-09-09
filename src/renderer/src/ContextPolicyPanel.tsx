import { useEffect, useRef, useState } from 'react'
import { contextCategories, type ContextCategory, type ContextPolicy, type ContextPolicyInput } from '../../core/context-packet-contracts'
import type { KnowledgeRecord } from '../../core/knowledge-record-contracts'
import type { ProjectSource } from '../../core/source-catalog'
import type { DesktopApi } from '../../shared/desktop-api'

const categoryLabel = (category: ContextCategory): string => category.replaceAll('_', ' ')

export function ContextPolicyPanel({ api, projectId }: { api: DesktopApi; projectId: string }): JSX.Element {
  const [policy, setPolicy] = useState<ContextPolicy>()
  const [draft, setDraft] = useState<ContextPolicyInput>()
  const [sources, setSources] = useState<ProjectSource[]>([])
  const [records, setRecords] = useState<KnowledgeRecord[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const lock = useRef(false)
  useEffect(() => {
    let current = true
    void Promise.all([api.contextPackets.policy(projectId), api.sourceCatalog.list(projectId), api.knowledgeRecords.list(projectId)]).then(([value, projectSources, projectRecords]) => { if (current) { setPolicy(value); setDraft({ ...value, expectedVersion: value.version }); setSources(projectSources); setRecords(projectRecords) } }).catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false }
  }, [api, projectId])
  const save = async (): Promise<void> => {
    if (!draft || lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setSaved(false)
    try { const value = await api.contextPackets.updatePolicy(projectId, { expectedVersion: draft.expectedVersion, requirements: draft.requirements, sourcePins: draft.sourcePins, requiredRecordIds: draft.requiredRecordIds, allowSoftOverride: draft.allowSoftOverride, tokenBudget: draft.tokenBudget, operatorInstructions: draft.operatorInstructions }); setPolicy(value); setDraft({ ...value, expectedVersion: value.version }); setSaved(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="settings-section" aria-labelledby="context-policy-heading">
    <h2 id="context-policy-heading">Agent context requirements</h2>
    <p>Choose which evidence agents need before starting work. Task integrity, unavailable artifacts, and unfinished prerequisites always block execution.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{saved ? <p role="status">Context requirements saved as policy version {policy?.version}. Existing previews must be rebuilt.</p> : null}
    {draft ? <details><summary>Edit context policy · version {policy?.version}</summary><form onSubmit={(event) => { event.preventDefault(); void save() }}><fieldset className="source-import-fields" disabled={busy}>
      <p className="muted">Required gaps block execution. Reviewable gaps require an explicit reason if the policy permits proceeding. Informational categories remain visible in the packet.</p>
      <div className="context-policy-categories">{contextCategories.map((category) => <label className="field-label" key={category}>{categoryLabel(category)}<select aria-label={`Context requirement ${category}`} value={draft.requirements.find((entry) => entry.category === category)?.severity ?? 'info'} onChange={(event) => setDraft((current) => current ? { ...current, requirements: [...current.requirements.filter((entry) => entry.category !== category), ...(event.target.value === 'info' ? [] : [{ category, severity: event.target.value as 'hard' | 'soft' }])] } : current)}><option value="info">Informational</option><option value="hard">Required before execution</option><option value="soft">Reviewable gap</option></select></label>)}</div>
      <label className="confirmation-check"><input type="checkbox" checked={draft.allowSoftOverride} onChange={(event) => setDraft({ ...draft, allowSoftOverride: event.target.checked })} />Allow a recorded reason to proceed with reviewable gaps</label>
      <label className="field-label">Context token budget<input aria-label="Context token budget" type="number" min={4000} max={64000} required value={draft.tokenBudget} onChange={(event) => setDraft({ ...draft, tokenBudget: Number(event.target.value) })} /></label>
      <label className="field-label">Operator instructions<textarea aria-label="Context operator instructions" maxLength={2000} value={draft.operatorInstructions} onChange={(event) => setDraft({ ...draft, operatorInstructions: event.target.value })} /></label>
      <h3>Required project sources</h3><p className="muted">Pinned sources must be ready and are included in the chosen section for every task.</p>
      {sources.map((source) => <label className="field-label" key={source.id}>{source.title} · {source.state}<select aria-label={`Required source ${source.title}`} value={draft.sourcePins.find((pin) => pin.sourceId === source.id)?.category ?? ''} onChange={(event) => setDraft({ ...draft, sourcePins: [...draft.sourcePins.filter((pin) => pin.sourceId !== source.id), ...(event.target.value ? [{ sourceId: source.id, category: event.target.value as ContextCategory }] : [])] })}><option value="">Choose by task relevance</option>{contextCategories.map((category) => <option key={category} value={category}>Required · {categoryLabel(category)}</option>)}</select></label>)}
      {draft.sourcePins.filter((pin) => !sources.some((source) => source.id === pin.sourceId)).map((pin) => <p className="source-notice" key={pin.sourceId}>Missing required source: {pin.sourceId}<button className="secondary-button" type="button" onClick={() => setDraft({ ...draft, sourcePins: draft.sourcePins.filter((entry) => entry.sourceId !== pin.sourceId) })}>Remove missing source requirement</button></p>)}
      <h3>Required decisions, requirements and risks</h3><div className="directory-split-selections">{records.map((record) => <label key={record.id}><input type="checkbox" checked={draft.requiredRecordIds.includes(record.id)} onChange={(event) => setDraft({ ...draft, requiredRecordIds: event.target.checked ? [...draft.requiredRecordIds, record.id] : draft.requiredRecordIds.filter((id) => id !== record.id) })} />{record.title} · {record.status}</label>)}</div>
      {draft.requiredRecordIds.filter((id) => !records.some((record) => record.id === id)).map((id) => <p className="source-notice" key={id}>Missing required guidance: {id}<button className="secondary-button" type="button" onClick={() => setDraft({ ...draft, requiredRecordIds: draft.requiredRecordIds.filter((entry) => entry !== id) })}>Remove missing guidance requirement</button></p>)}
      <button className="secondary-button" type="submit">{busy ? 'Saving context policy…' : 'Save context requirements'}</button>
    </fieldset></form></details> : !error ? <p role="status">Loading context policy…</p> : null}
  </section>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { contextCategories, type ContextApproval, type ContextCategory, type ContextPacket, type ContextPacketUsage, type ContextPreferencesInput, type ContextSectionRead } from '../../core/context-packet-contracts'
import type { ProjectSource, SourceCitation } from '../../core/source-catalog'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import { ContextPolicyPanel } from './ContextPolicyPanel'
import { ContextFeedbackPanel } from './ContextFeedbackPanel'
import { KnowledgeRecordsPanel } from './KnowledgeRecordsPanel'
import { Modal } from './Modal'
import { SourceCitationReader, SourceDetailDialog } from './SourceCatalogPanel'

const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const label = (value: string): string => value.replaceAll('_', ' ')
type PacketSummary = Pick<ContextPacket, 'id' | 'workItemId' | 'version' | 'createdAt' | 'readiness' | 'canExecute' | 'previousPacketId' | 'fingerprint'>

export function TaskContextDialog({ api, projectId, workItem, mode = 'inspect', prompt, onPromptChange, onExecute, onClose }: { api: DesktopApi; projectId: string; workItem: WorkItem; mode?: 'inspect' | 'start' | 'restart'; prompt?: string; onPromptChange?(value: string): void; onExecute?(approval: ContextApproval): Promise<boolean | void>; onClose(): void }): JSX.Element {
  const [approval, setApproval] = useState<ContextApproval>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [preflightError, setPreflightError] = useState<string>()
  const [preflight, setPreflight] = useState<Awaited<ReturnType<DesktopApi['workItems']['preflight']>>>()
  const [citation, setCitation] = useState<SourceCitation>()
  const [sourceId, setSourceId] = useState<string>()
  const [recordId, setRecordId] = useState<string>()
  const [showPolicy, setShowPolicy] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const executionLock = useRef(false)
  const acceptApproval = useCallback((value: ContextApproval | undefined): void => { setApproval(value); if (value) setError(undefined) }, [])
  useEffect(() => {
    let current = true
    if (mode !== 'inspect') void api.workItems.preflight(projectId, workItem.id).then((value) => { if (current) setPreflight(value) }).catch((reason) => { if (current) setPreflightError(messageFor(reason)) })
    return () => { current = false }
  }, [api, projectId, workItem.id, mode])
  const execute = async (): Promise<void> => {
    if (!approval || !onExecute || executionLock.current) return
    executionLock.current = true; setBusy(true); setError(undefined)
    try { if (await onExecute(approval) !== false) onClose() }
    catch (reason) { setError(messageFor(reason)); setApproval(undefined) }
    finally { executionLock.current = false; setBusy(false) }
  }
  const returnToPreview = (): void => { setSourceId(undefined); setRecordId(undefined); setShowPolicy(false); setApproval(undefined); setPreviewKey((value) => value + 1) }
  if (sourceId) return <SourceDetailDialog api={api} projectId={projectId} sourceId={sourceId} onClose={returnToPreview} />
  if (recordId) return <KnowledgeRecordsPanel api={api} projectId={projectId} workItems={[workItem]} initialRecordId={recordId} onClose={returnToPreview} />
  if (showPolicy) return <Modal className="source-detail-dialog" title="Project context requirements" onCancel={returnToPreview}><ContextPolicyPanel api={api} projectId={projectId} /></Modal>
  return <><Modal active={!citation} className="source-detail-dialog" title={mode === 'start' ? `Start Copilot for ${workItem.displayId}` : mode === 'restart' ? `Restart Copilot for ${workItem.displayId}` : `Task context for ${workItem.displayId}`} onCancel={onClose}>
    <p><strong>{workItem.title}</strong>{mode === 'inspect' ? '' : ' · Copilot opens in a Terminal session with Workstack MCP.'}</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {preflightError ? <p className="inline-error" role="alert">{preflightError} Close and reopen this task context to check agent capabilities again.</p> : null}
    {mode !== 'inspect' ? preflight ? <details><summary>Execution profile: {preflight.profile}</summary><p>Workspace: {preflight.workspacePath}</p><p>Scope: {preflight.capabilities.scope === 'user' ? 'Your user account, including files outside the workspace' : 'Workspace'}. Read: {preflight.capabilities.readFiles ? 'yes' : 'no'}; write: {preflight.capabilities.writeFiles ? 'yes' : 'no'}; network: {preflight.capabilities.network ? 'yes' : 'no'}; external processes: {preflight.capabilities.externalProcesses ? 'yes' : 'no'}.</p>{preflight.reason ? <p role="status">{preflight.reason}</p> : null}</details> : <p role="status">{preflightError ? 'Agent capabilities could not be checked.' : 'Checking agent capabilities…'}</p> : null}
    <ContextPacketPreview key={previewKey} api={api} projectId={projectId} workItem={workItem} onApprovalChange={acceptApproval} onCitation={setCitation} onSource={setSourceId} onRecord={setRecordId} onPolicy={() => setShowPolicy(true)} />
    {mode === 'start' ? <><label className="field-label">Initial prompt<textarea aria-label="Initial Copilot prompt" required value={prompt ?? ''} onChange={(event) => onPromptChange?.(event.target.value)} /></label><p className="muted">This prompt is recorded with the context packet when the agent starts.</p></> : null}
    <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{mode === 'inspect' ? 'Close context' : 'Cancel'}</button>{mode !== 'inspect' ? <button className="primary-button" type="button" disabled={busy || !approval || !preflight?.supported || (mode === 'start' && !prompt?.trim())} onClick={() => void execute()}>{busy ? 'Opening…' : mode === 'restart' ? 'Restart with reviewed context' : 'Start Copilot'}</button> : null}</div>
  </Modal>{citation ? <SourceCitationReader api={api} projectId={projectId} citation={citation} onClose={() => setCitation(undefined)} /> : null}</>
}

function ContextPacketPreview({ api, projectId, workItem, onApprovalChange, onCitation, onSource, onRecord, onPolicy }: { api: DesktopApi; projectId: string; workItem: WorkItem; onApprovalChange(value: ContextApproval | undefined): void; onCitation(citation: SourceCitation): void; onSource(id: string): void; onRecord(id: string): void; onPolicy(): void }): JSX.Element {
  const [packet, setPacket] = useState<ContextPacket>()
  const [history, setHistory] = useState<PacketSummary[]>([])
  const [usage, setUsage] = useState<ContextPacketUsage[]>([])
  const [sources, setSources] = useState<ProjectSource[]>([])
  const [preferences, setPreferences] = useState<ContextPreferencesInput>()
  const [savedPreferences, setSavedPreferences] = useState<ContextPreferencesInput>()
  const [dirty, setDirty] = useState(false)
  const [historical, setHistorical] = useState(false)
  const [previewValid, setPreviewValid] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [overrideReason, setOverrideReason] = useState('')
  const [section, setSection] = useState<{ category: ContextCategory; offset: number }>()
  const [read, setRead] = useState<ContextSectionRead>()
  const [reading, setReading] = useState(false)
  const lock = useRef(false)
  const alive = useRef(true)
  const adopt = useCallback((value: ContextPacket, old = false): void => { const draft = { expectedVersion: value.preferences.version, sourcePins: value.preferences.sourcePins, excludedSourceIds: value.preferences.excludedSourceIds }; setPacket(value); setPreferences(draft); setSavedPreferences(draft); setDirty(false); setHistorical(old); setPreviewValid(!old); setSection(undefined); setRead(undefined) }, [])
  useEffect(() => {
    alive.current = true
    void Promise.all([api.contextPackets.preview(projectId, workItem.id), api.sourceCatalog.list(projectId)]).then(async ([value, catalog]) => { const packets = await api.contextPackets.list(projectId, workItem.id); if (alive.current) { adopt(value); setSources(catalog); setHistory(packets) } }).catch((reason) => { if (alive.current) setError(messageFor(reason)) }).finally(() => { if (alive.current) setBusy(false) })
    return () => { alive.current = false }
  }, [api, projectId, workItem.id, adopt])
  useEffect(() => { onApprovalChange(packet?.canExecute && previewValid && !busy && !dirty && !historical ? { packetId: packet.id, ...(packet.softOverrideReason ? { softOverrideReason: packet.softOverrideReason } : {}) } : undefined) }, [packet, previewValid, busy, dirty, historical, onApprovalChange])
  useEffect(() => {
    let current = true
    setUsage([])
    if (packet) void api.contextPackets.usage(projectId, packet.id).then((values) => { if (current) setUsage(values) }).catch((reason) => { if (current) setError(messageFor(reason)) })
    return () => { current = false }
  }, [api, projectId, packet])
  useEffect(() => {
    let current = true
    setRead(undefined)
    if (packet && section) { setReading(true); void api.contextPackets.readSection(projectId, packet.id, section.category, section.offset).then((value) => { if (current) setRead(value) }).catch((reason) => { if (current) setError(messageFor(reason)) }).finally(() => { if (current) setReading(false) }) }
    return () => { current = false }
  }, [api, projectId, packet, section])
  const rebuild = async (savePreferences = false, useOverride = false): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setPreviewValid(false); setError(undefined); onApprovalChange(undefined)
    try {
      if (savePreferences && preferences) { const value = await api.contextPackets.updatePreferences(projectId, workItem.id, preferences); const draft = { expectedVersion: value.version, sourcePins: value.sourcePins, excludedSourceIds: value.excludedSourceIds }; setPreferences(draft); setSavedPreferences(draft); setDirty(false) }
      const value = await api.contextPackets.preview(projectId, workItem.id, useOverride && packet ? { packetId: packet.id, softOverrideReason: overrideReason } : undefined)
      if (alive.current) { adopt(value); setHistory(await api.contextPackets.list(projectId, workItem.id)); setSources(await api.sourceCatalog.list(projectId)) }
    } catch (reason) { if (alive.current) setError(messageFor(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const selectPacket = async (id: string): Promise<void> => {
    setBusy(true); setError(undefined)
    try { adopt(await api.contextPackets.get(projectId, id), true) }
    catch (reason) { setError(messageFor(reason)) }
    finally { setBusy(false) }
  }
  return <section className="task-context-preview" aria-label="Exact task context">
    <div className="toolbar-actions"><button className="secondary-button" type="button" disabled={busy || dirty} onClick={() => void rebuild()}>Rebuild context preview</button><button className="secondary-button" type="button" disabled={busy || dirty} onClick={onPolicy}>Project context requirements</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{busy ? <p role="status">Building context from current project evidence…</p> : null}
    {packet ? <>
      <p className="source-notice" role="status"><strong>{label(packet.readiness)}</strong> · {packet.canExecute ? 'Execution requirements satisfied' : 'Execution requires attention'}{historical ? ' · historical packet; rebuild to use current evidence' : ''}</p>
      <p className="muted">Packet {packet.id} · version {packet.version} · policy {packet.policy.version} · {new Date(packet.createdAt).toLocaleString()}</p>
      <p>{packet.budget.used.toLocaleString()} / {packet.budget.limit.toLocaleString()} conservative budget units · {label(packet.retrieval.mode)} retrieval</p>
      {packet.softOverrideReason ? <p className="source-notice">Recorded reason for proceeding: {packet.softOverrideReason}</p> : null}
      {packet.gaps.length ? <section aria-label="Context evidence gaps"><h3>Evidence gaps and repair actions</h3><ul className="source-job-list">{packet.gaps.map((gap) => <li key={gap.id}><strong>{gap.severity === 'hard' ? 'Required' : gap.severity === 'soft' ? 'Reviewable' : 'Informational'} · {label(gap.category)}</strong><p>{gap.reason}</p><p className="muted">{gap.action}</p><div className="toolbar-actions">{gap.sourceId ? <button className="secondary-button" type="button" disabled={busy || dirty} onClick={() => onSource(gap.sourceId!)}>Inspect affected source</button> : null}{gap.recordId ? <button className="secondary-button" type="button" disabled={busy || dirty} onClick={() => onRecord(gap.recordId!)}>Review affected guidance</button> : null}</div></li>)}</ul></section> : null}
      {!packet.canExecute && !packet.gaps.some((gap) => gap.severity === 'hard') && packet.gaps.some((gap) => gap.severity === 'soft') && packet.policy.allowSoftOverride && !historical ? <form onSubmit={(event) => { event.preventDefault(); void rebuild(false, true) }}><label className="field-label">Reason to proceed with reviewable gaps<textarea aria-label="Context override reason" required maxLength={2000} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label><button className="secondary-button" type="submit" disabled={busy || dirty || !overrideReason.trim()}>Record reason and rebuild context</button></form> : null}
      <h3>Included sections</h3><ul className="context-section-list">{packet.sections.map((entry) => <li key={entry.category}><strong>{entry.title}</strong><span>{label(entry.state)}{entry.required ? ' · required' : ''}</span>{entry.state === 'included' ? <button className="secondary-button" type="button" onClick={() => setSection({ category: entry.category, offset: 0 })}>Read {entry.title}</button> : null}{entry.citations.map((citation) => <button className="source-title-button" type="button" key={citation.passageId} onClick={() => onCitation(citation)}>Exact evidence · lines {citation.startLine}–{citation.endLine}</button>)}</li>)}</ul>
      {section ? <section className="context-full-section" aria-label="Full context section"><h3>{label(section.category)}</h3>{reading ? <p role="status">Reading saved section…</p> : read ? <><p>Characters {read.offset}–{read.offset + read.text.length} of {read.totalCharacters}</p><pre className="source-passage-text">{read.text}</pre><div className="toolbar-actions"><button className="secondary-button" type="button" disabled={read.offset === 0} onClick={() => setSection({ category: read.category, offset: Math.max(0, read.offset - 12_000) })}>Previous context section</button><button className="secondary-button" type="button" disabled={read.nextOffset === null} onClick={() => { if (read.nextOffset !== null) setSection({ category: read.category, offset: read.nextOffset }) }}>Next context section</button></div></> : null}</section> : null}
      {preferences && !historical ? <details><summary>Pin or exclude task sources</summary><p className="muted">Pinned sources become mandatory for this task. Project requirements still apply. Saving choices builds a new packet.</p><form onSubmit={(event) => { event.preventDefault(); void rebuild(true) }}><fieldset className="source-import-fields" disabled={busy}>{sources.map((source) => <label className="field-label" key={source.id}>{source.title} · {source.state}<select aria-label={`Task context source ${source.title}`} value={preferences.excludedSourceIds.includes(source.id) ? 'excluded' : preferences.sourcePins.find((pin) => pin.sourceId === source.id)?.category ?? ''} onChange={(event) => { setDirty(true); setPreferences({ ...preferences, sourcePins: [...preferences.sourcePins.filter((pin) => pin.sourceId !== source.id), ...(!event.target.value || event.target.value === 'excluded' ? [] : [{ sourceId: source.id, category: event.target.value as ContextCategory }])], excludedSourceIds: [...preferences.excludedSourceIds.filter((id) => id !== source.id), ...(event.target.value === 'excluded' ? [source.id] : [])] }) }}><option value="">Choose by task relevance</option><option value="excluded">Exclude from optional context</option>{contextCategories.map((category) => <option key={category} value={category}>Required · {label(category)}</option>)}</select></label>)}{dirty ? <p role="status">Source choices have changed. Save and rebuild before execution.</p> : null}<button className="secondary-button" type="submit" disabled={!dirty}>Save source choices and rebuild</button>{dirty ? <button className="secondary-button" type="button" onClick={() => { setPreferences(savedPreferences); setDirty(false) }}>Discard unsaved source choices</button> : null}</fieldset></form></details> : null}
      <details><summary>Repository and source revisions</summary><dl className="source-facts"><dt>Repository</dt><dd>{packet.repository.rootPath}</dd><dt>Base commit</dt><dd>{packet.repository.head ?? 'Directory snapshot'}</dd><dt>Working tree</dt><dd>{packet.repository.workingTreeHash}</dd><dt>Task revision</dt><dd>{packet.taskRevision}</dd><dt>Corpus revision</dt><dd>{packet.retrieval.corpusRevision}</dd></dl>{packet.repository.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}<ul className="source-job-list">{packet.manifest.map((entry) => <li key={entry.sourceId}><strong>{sources.find((source) => source.id === entry.sourceId)?.title ?? entry.sourceId}</strong><small>Revision {entry.revisionId}</small><code>{entry.contentHash}</code></li>)}</ul></details>
      {packet.budget.omissions.length ? <details><summary>Content omitted from the inline brief ({packet.budget.omissions.length})</summary><ul className="source-job-list">{packet.budget.omissions.map((omission, index) => <li key={index}><strong>{label(omission.category)} · {omission.characters} characters</strong><p>{omission.reason}</p><small>{omission.locator}</small></li>)}</ul></details> : null}
      <details><summary>Saved agent brief</summary><pre className="source-passage-text">{packet.launchMarkdown}</pre></details>
      {api.contextFeedback ? <ContextFeedbackPanel key={packet.id} api={api} projectId={projectId} packet={packet} sources={sources} /> : null}
      <details><summary>Packet history ({history.length}) and execution evidence</summary><ul className="source-job-list">{history.map((entry) => <li key={entry.id}><button className="source-title-button" type="button" disabled={busy || dirty} onClick={() => void selectPacket(entry.id)}>Version {entry.version} · {label(entry.readiness)} · {new Date(entry.createdAt).toLocaleString()}</button></li>)}</ul>{usage.length ? <ul className="source-job-list">{usage.map((entry) => <li key={entry.id}><strong>{entry.kind} · {entry.state} · {entry.actor}</strong>{entry.reason ? <p>{entry.reason}</p> : null}{entry.promptMarkdown ? <details><summary>Exact prompt used for this {entry.kind}</summary><pre className="source-passage-text">{entry.promptMarkdown}</pre></details> : null}</li>)}</ul> : <p className="muted">No execution has used this packet yet.</p>}</details>
    </> : null}
  </section>
}

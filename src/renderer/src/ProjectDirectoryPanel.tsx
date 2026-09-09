import { useEffect, useRef, useState } from 'react'
import type { KnowledgeReference } from '../../core/knowledge-record-contracts'
import type { DirectoryLookup, ProjectEntity, ProjectEntityDetail, ProjectEntityInput } from '../../core/project-directory-contracts'
import type { SourceCitation } from '../../core/source-catalog'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import { KnowledgeReferenceFields } from './KnowledgeReferenceFields'
import { MarkdownDocument } from './MarkdownDocument'
import { Modal } from './Modal'
import { SourceCitationReader } from './SourceCatalogPanel'

const messageFor = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

export function ProjectDirectoryPanel({ api, projectId, workItems, initialEntityId, onClose }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; initialEntityId?: string; onClose(): void }): JSX.Element {
  const [entities, setEntities] = useState<ProjectEntity[]>([])
  const [lookup, setLookup] = useState<DirectoryLookup>()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | undefined>(initialEntityId)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true)
    void api.projectDirectory.list(projectId).then((items) => { if (current) { setEntities(items); setError(undefined) } }).catch((reason) => { if (current) setError(messageFor(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, revision])
  useEffect(() => {
    let current = true
    setLookup(undefined)
    if (query.trim()) void api.projectDirectory.lookup(projectId, query).then((result) => { if (current) setLookup(result) }).catch((reason) => { if (current) setError(messageFor(reason)) })
    return () => { current = false }
  }, [api, projectId, query, revision])
  if (selected) return <ProjectEntityDialog key={selected} api={api} projectId={projectId} workItems={workItems} entities={entities} entityId={selected === 'new' ? undefined : selected} onOpenEntity={setSelected} onClose={() => { setSelected(undefined); setRevision((value) => value + 1) }} />
  const visible = query.trim() ? lookup?.candidates ?? [] : entities
  return <Modal className="source-detail-dialog" title="Components and glossary" onCancel={onClose}>
    <p className="muted">Give project components and terms stable names, approved aliases, and definitions. Ambiguous spellings remain explicit candidates.</p>
    <div className="toolbar-actions"><button className="primary-button" type="button" onClick={() => setSelected('new')}>New directory entry</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{loading ? <p role="status">Loading project directory…</p> : null}
    <label className="field-label">Find a name or alias<input type="search" aria-label="Find component or glossary term" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {lookup?.match === 'ambiguous' ? <p className="source-notice" role="status">This name matches more than one entry. Choose the intended concept; no entries have been merged.</p> : lookup?.match === 'suggestion' ? <p className="source-notice">These are possible matches. An unapproved spelling is not an established alias.</p> : null}
    {visible.length ? <ul className="source-catalog-list">{visible.map((entity) => <li key={entity.id}><button className="source-title-button" type="button" onClick={() => setSelected(entity.id)}>{entity.displayName}</button><span className="source-readiness">{entity.kind === 'term' ? 'Glossary term' : 'Component'} · {entity.status}</span><p>{entity.definition}</p><small>Aliases: {entity.aliases.join(', ') || 'None'}</small></li>)}</ul> : <p className="muted">{query ? 'No matching component or term.' : 'No directory entries yet. Add the names and abbreviations agents will encounter.'}</p>}
  </Modal>
}

function ProjectEntityDialog({ api, projectId, workItems, entities, entityId, onOpenEntity, onClose }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; entities: ProjectEntity[]; entityId?: string; onOpenEntity(id: string): void; onClose(): void }): JSX.Element {
  const [availableEntities, setAvailableEntities] = useState(entities)
  const [detail, setDetail] = useState<ProjectEntityDetail>()
  const [kind, setKind] = useState<ProjectEntityInput['kind']>('component')
  const [displayName, setDisplayName] = useState('')
  const [aliases, setAliases] = useState('')
  const [definition, setDefinition] = useState('')
  const [references, setReferences] = useState<KnowledgeReference[]>([])
  const [actor, setActor] = useState('local-user')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(Boolean(entityId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [correctionReason, setCorrectionReason] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [splitName, setSplitName] = useState('')
  const [splitDefinition, setSplitDefinition] = useState('')
  const [splitAliases, setSplitAliases] = useState<string[]>([])
  const [splitMentions, setSplitMentions] = useState<string[]>([])
  const [citation, setCitation] = useState<SourceCitation>()
  const lock = useRef(false)
  const adopt = (value: ProjectEntityDetail): void => { setDetail(value); setKind(value.entity.kind); setDisplayName(value.entity.displayName); setAliases(value.entity.aliases.join('\n')); setDefinition(value.entity.definition); setReferences(value.entity.references) }
  useEffect(() => {
    let current = true
    if (entityId) void api.projectDirectory.detail(projectId, entityId).then((value) => { if (current) adopt(value) }).catch((failure) => { if (current) setError(messageFor(failure)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, entityId])
  const save = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setSaved(false)
    try {
      const input: ProjectEntityInput = { kind, displayName, aliases: aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), definition, references }
      const value = detail ? await api.projectDirectory.update(projectId, detail.entity.id, { displayName, aliases: input.aliases, definition, references, expectedVersion: detail.entity.version }, actor, reason) : await api.projectDirectory.create(projectId, input, actor)
      adopt(await api.projectDirectory.detail(projectId, value.id)); setReason(''); setSaved(true)
    } catch (failure) { setError(messageFor(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const correct = async (operation: () => Promise<ProjectEntityDetail>): Promise<void> => {
    if (lock.current || !actor.trim() || !correctionReason.trim()) return
    lock.current = true; setBusy(true); setError(undefined); setSaved(false)
    try { adopt(await operation()); setSaved(true); setCorrectionReason(''); setMergeTarget(''); setSplitAliases([]); setSplitMentions([]) }
    catch (failure) { setError(messageFor(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  if (citation) return <SourceCitationReader api={api} projectId={projectId} citation={citation} onClose={() => setCitation(undefined)} />
  return <Modal className="source-detail-dialog" title={detail?.entity.displayName ?? 'New directory entry'} onCancel={onClose}>
    {error ? <><p className="inline-error" role="alert">{error}</p>{detail ? <button className="secondary-button" type="button" disabled={busy} onClick={() => { setBusy(true); void Promise.all([api.projectDirectory.detail(projectId, detail.entity.id), api.projectDirectory.list(projectId)]).then(([current, choices]) => { adopt(current); setAvailableEntities(choices); setError(undefined) }).catch((failure) => setError(messageFor(failure))).finally(() => setBusy(false)) }}>Reload saved entries and replace draft</button> : null}</> : null}{saved ? <p role="status">Directory entry saved.</p> : null}
    {loading ? <p role="status">Reading definition and source mentions…</p> : <>
      {detail ? <><p>{detail.entity.kind} · {detail.entity.status}</p>{detail.entity.id !== detail.canonicalEntity.id ? <p className="source-notice">This identity was merged into <button className="source-title-button" type="button" onClick={() => onOpenEntity(detail.canonicalEntity.id)}>{detail.canonicalEntity.displayName}</button>. Its previous identity and history are retained.</p> : null}<details><summary>Read saved definition</summary><MarkdownDocument content={detail.entity.definition} /><p className="source-origin">Stable ID: {detail.entity.id}</p></details></> : null}
      <form onSubmit={(event) => { event.preventDefault(); void save() }}><fieldset className="source-import-fields" disabled={busy || detail?.entity.status === 'merged'}>
        <label className="field-label">Entry type<select aria-label="Directory entry type" value={kind} disabled={Boolean(detail)} onChange={(event) => setKind(event.target.value as ProjectEntityInput['kind'])}><option value="component">Component</option><option value="term">Glossary term</option></select></label>
        <label className="field-label">Canonical name<input aria-label="Directory canonical name" required maxLength={200} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="field-label">Approved aliases (one per line)<textarea aria-label="Directory aliases" value={aliases} onChange={(event) => setAliases(event.target.value)} /></label>
        <label className="field-label">Definition<textarea aria-label="Directory definition" required maxLength={20_000} value={definition} onChange={(event) => setDefinition(event.target.value)} /></label>
        <KnowledgeReferenceFields api={api} projectId={projectId} workItems={workItems} references={references} onChange={setReferences} />
        <label className="field-label">Editor identity<input aria-label="Directory editor identity" required maxLength={200} value={actor} onChange={(event) => setActor(event.target.value)} /></label>
        {detail ? <label className="field-label">Reason for change<textarea aria-label="Directory change reason" required value={reason} onChange={(event) => setReason(event.target.value)} /></label> : null}
        <div className="modal-actions"><button className="primary-button" type="submit">{busy ? 'Saving entry…' : 'Save directory entry'}</button></div>
      </fieldset></form>
      {detail ? <>
        <h3>Source mentions</h3>{detail.mentions.length ? <ul className="source-job-list">{detail.mentions.map((mention) => <li key={mention.id}><strong>“{mention.surface}” · {mention.resolution}</strong><small>{mention.historical ? 'Historical revision' : 'Current revision'} · {mention.readiness} · characters {mention.startOffset}–{mention.endOffset}</small>{mention.candidateIds.length > 1 ? <p className="source-notice">Ambiguous mention. Candidates: {mention.candidateIds.map((id) => availableEntities.find((entity) => entity.id === id)?.displayName ?? id).join(', ')}</p> : null}<button className="secondary-button" type="button" onClick={() => setCitation(mention.citation)}>Read exact mention evidence</button></li>)}</ul> : <p className="muted">No indexed source mentions yet.</p>}
        {detail.mentionsTruncated ? <p className="source-notice">This view shows up to {detail.mentionLimits.returned} mentions, with {detail.mentionLimits.perSource} indexed per source. Additional mentions were omitted.</p> : null}
        {detail.entity.status === 'active' ? <details><summary>Correct names, matches, or duplicate entries</summary>
          <label className="field-label">Correction reason<textarea aria-label="Directory correction reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} /></label>
          <p className="muted">Corrections use the editor identity above and retain an audit history. They apply to the saved entry.</p>
          {detail.mentions.length ? <><h3>Resolve source mentions</h3><ul className="source-job-list">{detail.mentions.map((mention) => <li key={mention.id}><strong>“{mention.surface}” · {mention.resolution}</strong><div className="toolbar-actions">{availableEntities.filter((entity) => entity.status === 'active' && (mention.candidateIds.includes(entity.id) || entity.id === detail.entity.id)).map((entity) => <button className="secondary-button" type="button" key={entity.id} disabled={busy || !correctionReason.trim() || !actor.trim()} onClick={() => void correct(async () => { await api.projectDirectory.resolveMention(projectId, mention.id, entity.id, actor, correctionReason); return api.projectDirectory.detail(projectId, detail.entity.id) })}>Resolve as {entity.displayName}</button>)}<button className="secondary-button" type="button" disabled={busy || !correctionReason.trim() || !actor.trim()} onClick={() => void correct(async () => { await api.projectDirectory.resolveMention(projectId, mention.id, null, actor, correctionReason); return api.projectDirectory.detail(projectId, detail.entity.id) })}>Dismiss this mention</button></div></li>)}</ul></> : null}
          <h3>Merge a duplicate</h3><label className="field-label">Surviving entry<select aria-label="Surviving directory entry" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Choose the surviving entry</option>{availableEntities.filter((entity) => entity.id !== detail.entity.id && entity.kind === detail.entity.kind && entity.status === 'active').map((entity) => <option key={entity.id} value={entity.id}>{entity.displayName}</option>)}</select></label>
          {mergeTarget ? <p className="source-notice">{detail.entity.displayName} will become a historical identity for {availableEntities.find((entity) => entity.id === mergeTarget)?.displayName}. Its aliases and references move to that entry; its saved definition remains in history.</p> : null}
          <button className="secondary-button" type="button" disabled={busy || !mergeTarget || !correctionReason.trim() || !actor.trim()} onClick={() => { const target = availableEntities.find((entity) => entity.id === mergeTarget); if (target) void correct(() => api.projectDirectory.merge(projectId, detail.entity.id, target.id, { actor, reason: correctionReason, expectedSourceVersion: detail.entity.version, expectedTargetVersion: target.version })) }}>Merge into selected entry</button>
          <h3>Split a mistaken match</h3><label className="field-label">New canonical name<input aria-label="Split entry name" value={splitName} onChange={(event) => setSplitName(event.target.value)} /></label><label className="field-label">New definition<textarea aria-label="Split entry definition" value={splitDefinition} onChange={(event) => setSplitDefinition(event.target.value)} /></label>
          <p className="muted">Choose aliases and mentions to move into the new identity.</p><div className="directory-split-selections">{detail.entity.aliases.map((alias) => <label key={alias}><input type="checkbox" checked={splitAliases.includes(alias)} onChange={(event) => setSplitAliases((current) => event.target.checked ? [...current, alias] : current.filter((value) => value !== alias))} />Move alias {alias}</label>)}{detail.mentions.map((mention) => <label key={mention.id}><input type="checkbox" checked={splitMentions.includes(mention.id)} onChange={(event) => setSplitMentions((current) => event.target.checked ? [...current, mention.id] : current.filter((value) => value !== mention.id))} />Move “{mention.surface}” at lines {mention.citation.startLine}–{mention.citation.endLine}</label>)}</div>
          <button className="secondary-button" type="button" disabled={busy || !splitName.trim() || !splitDefinition.trim() || !correctionReason.trim() || !actor.trim()} onClick={() => void correct(() => api.projectDirectory.split(projectId, detail.entity.id, { actor, reason: correctionReason, expectedVersion: detail.entity.version, entry: { kind: detail.entity.kind, displayName: splitName, definition: splitDefinition, references: detail.entity.references }, aliases: splitAliases, mentionIds: splitMentions }))}>Create separate identity</button>
        </details> : null}
        <details><summary>Directory history ({detail.history.length})</summary><ol className="source-job-list">{detail.history.map((entry) => <li key={entry.id}><strong>{entry.action} · {entry.actor}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small><p>{entry.reason}</p><details><summary>Read saved entry</summary><p>{entry.snapshot.displayName} · aliases: {entry.snapshot.aliases.join(', ')}</p><pre className="source-passage-text">{entry.snapshot.definition}</pre></details></li>)}</ol></details>
      </> : null}
    </>}
  </Modal>
}

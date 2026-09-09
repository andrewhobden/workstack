import { useEffect, useMemo, useRef, useState } from 'react'
import type { SourceInventory } from '../../core/source-intake-types'
import type { SourcePolicy } from '../../core/source-catalog'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import { Modal } from './Modal'

const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${Math.ceil(value / 1024)} KiB` : `${value} B`

export function SourceImportSheet({ api, projectId, workItems, onClose, onImported }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; onClose(): void; onImported(): void }): JSX.Element {
  const [inventory, setInventory] = useState<SourceInventory>()
  const [paths, setPaths] = useState<string[]>([])
  const [github, setGithub] = useState('')
  const [policy, setPolicy] = useState<SourcePolicy>('tracked_content')
  const [workItemId, setWorkItemId] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [previewRequest, setPreviewRequest] = useState(0)
  const locked = useRef(false)
  useEffect(() => {
    let current = true
    setLoading(true); setError(undefined)
    void api.sourceCatalog.previewRepository(projectId).then((preview) => {
      if (!current) return
      setInventory(preview)
      let size = 0
      const suggested: string[] = []
      preview.entries.forEach((entry) => {
        if (entry.suggested && !entry.excludedReason && suggested.length < preview.limits.maxFiles && size + entry.sizeBytes <= preview.limits.maxTotalBytes) { suggested.push(entry.path); size += entry.sizeBytes }
      })
      setPaths(suggested)
    }).catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, projectId, previewRequest])
  const selected = useMemo(() => new Set(paths), [paths])
  const selectedBytes = inventory?.entries.reduce((total, entry) => total + (selected.has(entry.path) ? entry.sizeBytes : 0), 0) ?? 0
  const githubUrls = [...new Set(github.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
  const submit = async (): Promise<void> => {
    if (!inventory || locked.current || (!paths.length && !githubUrls.length)) return
    if (githubUrls.length > inventory.limits.maxGithubSources) { setError(`Select at most ${inventory.limits.maxGithubSources} GitHub sources.`); return }
    locked.current = true; setSubmitting(true); setError(undefined)
    try {
      await api.sourceCatalog.importSelection(projectId, { paths, githubUrls, policy, ...(workItemId ? { workItemId } : {}) })
      onImported()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { locked.current = false; setSubmitting(false) }
  }
  return <Modal className="source-detail-dialog" title="Import project sources" onCancel={onClose}>
    <p className="muted">Preview local files, then choose the evidence to acquire. GitHub sources use the desktop app’s existing GitHub authorization.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Previewing repository scope…</p> : !inventory ? <button className="secondary-button" type="button" onClick={() => setPreviewRequest((value) => value + 1)}>Retry scope preview</button> : <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <fieldset disabled={submitting} className="source-import-fields">
        <p className="source-notice">Up to {inventory.limits.maxFiles} selected files; {bytes(inventory.limits.maxFileBytes)} per file; {bytes(inventory.limits.maxTotalBytes)} total. Repository inventory is bounded to {inventory.limits.maxInventoryFiles} files.</p>
        {inventory.commit ? <p className="muted source-origin">Previewed commit: {inventory.commit}</p> : null}
        {inventory.limited ? <p className="source-notice" role="status">The inventory limit was reached. This preview is incomplete; only listed selections will be imported.</p> : null}
        {inventory.diagnostics.length ? <details open><summary>Scope diagnostics</summary><ul>{inventory.diagnostics.map((entry, index) => <li key={index}>{entry}</li>)}</ul></details> : null}
        <div className="source-section-heading"><h3>Repository files</h3><button className="secondary-button" type="button" onClick={() => setPaths([])}>Clear selection</button></div>
        <label className="search-field"><span className="sr-only">Filter repository files</span><input type="search" aria-label="Filter repository files" placeholder="Filter listed paths" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <p role="status">{paths.length} files selected · {bytes(selectedBytes)}</p>
        <ul className="source-inventory-list">{inventory.entries.filter((entry) => entry.path.toLowerCase().includes(filter.toLowerCase())).map((entry) => {
          const overBudget = !selected.has(entry.path) && (paths.length >= inventory.limits.maxFiles || selectedBytes + entry.sizeBytes > inventory.limits.maxTotalBytes)
          return <li key={entry.path}><label><input type="checkbox" aria-label={`Import ${entry.path}`} disabled={Boolean(entry.excludedReason) || overBudget} checked={selected.has(entry.path)} onChange={(event) => setPaths((current) => event.target.checked ? [...current, entry.path] : current.filter((value) => value !== entry.path))} /><span><strong>{entry.path}</strong><small>{entry.kind} · {bytes(entry.sizeBytes)}{entry.suggested ? ' · suggested' : ''}</small>{entry.excludedReason ? <small className="source-state-reason">Excluded: {entry.excludedReason}</small> : overBudget ? <small>Selection limit reached</small> : null}</span></label></li>
        })}</ul>
        <h3>Selected GitHub sources</h3>
        <label className="field-label">GitHub URLs (one per line)<textarea aria-label="GitHub source URLs" placeholder="https://github.com/owner/repository/issues/123" value={github} onChange={(event) => setGithub(event.target.value)} /></label>
        <p className="muted">Repository files, issues, and pull requests only. Up to {inventory.limits.maxGithubSources} URLs; {inventory.limits.maxGithubComments} comments and {inventory.limits.maxGithubPages} pages per discussion. Text is bounded to {inventory.limits.maxTextCharacters.toLocaleString()} characters. Truncation and access failures remain visible in source history.</p>
        <label className="field-label">Intake policy<select aria-label="Intake policy" value={policy} onChange={(event) => setPolicy(event.target.value as SourcePolicy)}><option value="tracked_content">Track content changes</option><option value="import_once">Import once</option><option value="metadata_only">Check metadata only</option></select></label>
        {policy === 'metadata_only' ? <p className="source-notice">Metadata checks do not acquire searchable source content. Existing full revisions are retained with freshness limitations.</p> : null}
        <label className="field-label">Related work item<select aria-label="Related source work item" value={workItemId} onChange={(event) => setWorkItemId(event.target.value)}><option value="">Project-wide evidence</option>{workItems.map((item) => <option key={item.id} value={item.id}>{item.displayId}: {item.title}</option>)}</select></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!paths.length && !githubUrls.length}>{submitting ? 'Queueing sources…' : 'Import selected sources'}</button></div>
      </fieldset>
    </form>}
  </Modal>
}

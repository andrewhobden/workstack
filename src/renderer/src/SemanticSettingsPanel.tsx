import { useEffect, useRef, useState } from 'react'
import type { SemanticStatus } from '../../core/semantic-index-contracts'
import type { DesktopApi } from '../../shared/desktop-api'

export function SemanticSettingsPanel({ api, projectId }: { api: DesktopApi; projectId: string }): JSX.Element {
  const [status, setStatus] = useState<SemanticStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    const refresh = (): void => { void api.semantic.status(projectId).then((value) => { if (generation.current === current) setStatus(value) }).catch((reason) => { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason)) }) }
    setStatus(undefined); setError(undefined); refresh()
    const timer = setInterval(refresh, 2000)
    return () => { generation.current += 1; clearInterval(timer) }
  }, [api, projectId])
  const act = async (operation: () => Promise<SemanticStatus | undefined>): Promise<void> => {
    if (lock.current) return
    const current = generation.current
    lock.current = true; setBusy(true); setError(undefined)
    try { const value = await operation(); if (value && current === generation.current) setStatus(value) }
    catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; if (current === generation.current) setBusy(false) }
  }
  return <section className="settings-section" aria-labelledby="semantic-settings-heading">
    <h2 id="semantic-settings-heading">Local semantic search</h2>
    <p>Optionally add meaning-based passage matches using a local word-vector pack. Search always keeps exact identifiers and lexical matches. Model quality depends on the vocabulary you select.</p>
    <p className="muted">No model is downloaded and no source content leaves this computer. Packs contain JSON vectors, up to 8 MiB, 10,000 words and 128 dimensions. The index covers up to 5,000 current passages; decisions and directory entries use lexical search.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {status ? <>
      <p role="status">{status.enabled ? `Enabled · ${status.model?.modelId} ${status.model?.version} · ${status.indexedPassages} of ${status.eligiblePassages} eligible passages indexed` : 'Disabled · lexical search is active'}</p>
      {status.model ? <details><summary>Model identity</summary><p>{status.model.path}</p><p>SHA-256: <code>{status.model.hash}</code></p><p>{status.model.vocabularySize} words · {status.model.dimensions} dimensions</p></details> : null}
      {status.truncated ? <p className="source-notice">This project exceeds the 5,000-passage semantic budget. Lexical search still covers eligible project evidence.</p> : null}
      <div className="settings-actions"><button className="secondary-button" type="button" disabled={busy || status.busy} onClick={() => void act(() => api.semantic.chooseModel(projectId))}>Choose local vector pack</button>{status.enabled ? <><button className="secondary-button" type="button" disabled={busy} onClick={() => void act(() => api.semantic.reindex(projectId))}>Rebuild local index</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void act(() => api.semantic.disable(projectId))}>Disable semantic search</button></> : null}</div>
      {status.jobs.length ? <details><summary>Indexing jobs · {status.jobs.filter((job) => job.status === 'completed').length} completed</summary><ul>{status.jobs.slice(-100).map((job) => <li key={job.id}><strong>{job.sourceId}</strong> · {job.status} · attempt {job.attempts}{job.errorMessage ? <p>{job.errorMessage}</p> : null}{job.status === 'failed' ? <button className="secondary-button" type="button" disabled={busy || !status.enabled} onClick={() => void act(() => api.semantic.retry(projectId, job.id))}>Retry indexing</button> : job.status !== 'completed' ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void act(() => api.semantic.cancel(projectId, job.id))}>Cancel indexing</button> : null}</li>)}</ul></details> : null}
    </> : !error ? <p role="status">Loading semantic settings…</p> : null}
  </section>
}

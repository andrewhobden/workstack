import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeDeliveryEvent } from '../../core/knowledge-delivery'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'

export function KnowledgeDeliveryPanel({ api, projectId, workItems }: { api: DesktopApi; projectId: string; workItems: WorkItem[] }): JSX.Element | null {
  const [events, setEvents] = useState<KnowledgeDeliveryEvent[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<number>()
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const retryInFlight = useRef(false)
  const revision = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const requestedRevision = revision.current
    try {
      const rows = await api.knowledgeDelivery.list(projectId)
      if (mounted.current && requestedRevision === revision.current) { setEvents(rows); setError(undefined) }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { inFlight.current = false }
  }, [api, projectId])
  useEffect(() => {
    mounted.current = true
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      await refresh()
      if (mounted.current) timer = window.setTimeout(() => void poll(), 5_000)
    }
    void poll()
    return () => { mounted.current = false; window.clearTimeout(timer) }
  }, [refresh])
  const retry = async (id: number): Promise<void> => {
    if (retryInFlight.current) return
    retryInFlight.current = true
    setBusy(id)
    setError(undefined)
    try {
      const updated = await api.knowledgeDelivery.retry(projectId, id)
      revision.current++
      if (mounted.current) setEvents((current) => current.map((event) => event.id === id ? updated : event))
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      retryInFlight.current = false
      if (mounted.current) setBusy(undefined)
    }
  }
  const pending = events.filter((event) => event.status !== 'completed')
  if (!pending.length && !error) return null
  return <section className="knowledge-automation" aria-labelledby="knowledge-delivery-heading">
    <div><h2 id="knowledge-delivery-heading">Completion knowledge delivery</h2><p>Task completion is saved. These updates are still being delivered to project knowledge.</p></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <ul className="source-job-list">{pending.map((event) => {
      const item = workItems.find((candidate) => candidate.id === event.workItemId)
      return <li key={event.id}>
        <strong>{item ? `${item.displayId}: ${item.title}` : event.workItemId}</strong>
        <span>{event.status} · {event.attempts} attempt{event.attempts === 1 ? '' : 's'}</span>
        <small>{event.prUrl}</small>
        {event.errorMessage ? <p className="inline-error">{event.errorMessage}</p> : null}
        {event.nextAttemptAt ? <small>Automatic retry: {new Date(event.nextAttemptAt).toLocaleString()}</small> : event.status === 'failed' ? <small>Automatic retries stopped. Correct the cause, then retry this delivery.</small> : null}
        {event.status === 'failed' ? <button className="secondary-button" disabled={busy !== undefined} type="button" onClick={() => void retry(event.id)}>{busy === event.id ? 'Queueing delivery…' : 'Retry delivery'}</button> : null}
      </li>
    })}</ul>
  </section>
}

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { TaskCoordination } from '../../core/task-dependency-contracts'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import './TaskDependenciesPanel.css'

interface Draft { dependsOn: string; relatedTo: string; declaredPaths: string; declaredComponents: string }
const emptyDraft: Draft = { dependsOn: '', relatedTo: '', declaredPaths: '', declaredComponents: '' }
const entries = (text: string): string[] => text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)

export function TaskDependenciesPanel({ api, projectId, workItem, onOpenTask }: {
  api: DesktopApi; projectId: string; workItem: WorkItem; onOpenTask?: (id: string) => void
}): JSX.Element {
  const headingId = useId()
  const [coordination, setCoordination] = useState<TaskCoordination>()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const dirty = useRef(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])

  const adopt = useCallback((value: TaskCoordination): void => {
    setCoordination(value)
    if (!dirty.current) setDraft({
      dependsOn: value.prerequisites.map((task) => task.displayId).join('\n'),
      relatedTo: value.related.map((task) => task.displayId).join('\n'),
      declaredPaths: value.declaredPaths.join('\n'), declaredComponents: value.declaredComponents.join('\n')
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    generation.current++
    dirty.current = false
    inFlight.current = false
    setCoordination(undefined)
    setDraft(emptyDraft)
    setError(undefined)
    setSaved(false)
    setBusy(false)
    setEditing(false)
    const poll = async (): Promise<void> => {
      if (inFlight.current) { timer = window.setTimeout(() => void poll(), 5_000); return }
      const revision = generation.current
      try {
        const value = await api.taskDependencies.get(projectId, workItem.id)
        if (!cancelled && revision === generation.current) adopt(value)
      } catch (reason) {
        if (!cancelled && revision === generation.current) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 5_000)
      }
    }
    void poll()
    return () => { cancelled = true; invalidate(); window.clearTimeout(timer) }
  }, [api, projectId, workItem.id, adopt, invalidate])

  const change = (field: keyof Draft, value: string): void => {
    dirty.current = true
    setSaved(false)
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const save = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const revision = ++generation.current
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const value = await api.taskDependencies.update(projectId, workItem.id, {
        ...(workItem.status === 'backlog' ? { dependsOn: entries(draft.dependsOn) } : {}),
        relatedTo: entries(draft.relatedTo), declaredPaths: entries(draft.declaredPaths), declaredComponents: entries(draft.declaredComponents)
      })
      if (revision === generation.current) {
        dirty.current = false
        adopt(value)
        setSaved(true)
      }
    } catch (reason) {
      if (revision === generation.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (revision === generation.current) { inFlight.current = false; setBusy(false) }
    }
  }
  const taskLabel = (id: string, label: string): JSX.Element => onOpenTask
    ? <button type="button" className="text-button" onClick={() => onOpenTask(id)}>{label}</button>
    : <strong>{label}</strong>

  return <section className="task-dependencies-panel" aria-labelledby={headingId}>
    <h3 id={headingId}>Dependencies and overlapping work</h3>
    <p>Explicit prerequisites must finish before this task can be claimed. Related tasks and path overlaps provide advisory context.</p>
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {!coordination && !error ? <p role="status">Loading task dependencies…</p> : null}
    {coordination ? <>
      <p role="status"><strong>{coordination.readiness.ready ? 'Prerequisites ready' : 'Blocked by prerequisites'}</strong></p>
      <ul>{coordination.prerequisites.map((task) => <li key={task.workItemId}>
        {taskLabel(task.workItemId, `${task.displayId}: ${task.title}`)}
        <p>{task.satisfied ? 'Completed' : task.reason}</p>
        {task.outcome ? <details><summary>Prerequisite outcome</summary>
          <p className="task-outcome-text">{task.outcome.completion.summaryMarkdown}</p>
          {task.outcome.completion.validationMarkdown ? <p className="task-outcome-text">{task.outcome.completion.validationMarkdown}</p> : null}
          {task.outcome.completion.commitSha ? <p>Commit <code>{task.outcome.completion.commitSha}</code></p> : null}
          {task.outcome.completion.prUrl ? <a href={task.outcome.completion.prUrl} target="_blank" rel="noreferrer">View prerequisite pull request</a> : null}
        </details> : null}
      </li>)}</ul>
      {coordination.activeOverlaps.length ? <div><h4>Advisory overlaps with active workers</h4><p>Shared paths may be false positives. These overlaps do not block claims.</p>
        <ul>{coordination.activeOverlaps.map((task) => <li key={task.claimId}>
          {taskLabel(task.workItemId, `${task.displayId}: ${task.title}`)}
          <p>Agent: {task.agentDisplayName ?? task.agentId}{task.agentDisplayName ? ` (${task.agentId})` : ''}{task.sessionId ? ` · Session: ${task.sessionId}` : ''}</p>
          <ul>{task.evidence.map((evidence, index) => <li key={index}>
            {evidence.kind}: <code>{evidence.selectedValue}</code> overlaps <code>{evidence.activeValue}</code> ({evidence.basis === 'checkpoint' ? 'reported in the latest checkpoint' : 'declared scope'})
          </li>)}</ul>
        </li>)}</ul></div> : <p>No active overlaps found in declared scope or current worker checkpoints.</p>}
    </> : null}
    <button type="button" className="secondary-button" aria-expanded={editing} onClick={() => setEditing((current) => !current)}>{editing ? 'Hide task dependency editor' : 'Edit task dependencies'}</button>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="task-dependency-fields">
        <label>Prerequisite task IDs<textarea rows={2} value={draft.dependsOn} disabled={busy || !coordination || workItem.status !== 'backlog'} onChange={(event) => change('dependsOn', event.target.value)} placeholder="One task ID per line, e.g. WS-12" /></label>
        <label>Related task IDs<textarea rows={2} value={draft.relatedTo} disabled={busy || !coordination} onChange={(event) => change('relatedTo', event.target.value)} placeholder="One task ID per line" /></label>
        <label>Declared paths<textarea rows={2} value={draft.declaredPaths} disabled={busy || !coordination} onChange={(event) => change('declaredPaths', event.target.value)} placeholder="One repository-relative file or directory per line" /></label>
        <label>Declared components<textarea rows={2} value={draft.declaredComponents} disabled={busy || !coordination} onChange={(event) => change('declaredComponents', event.target.value)} placeholder="One component name per line" /></label>
      </div>
      <p>Remove a line to remove its link or scope. Prerequisites are editable while the task is in the backlog.</p>
      <button type="submit" className="secondary-button" disabled={busy || !coordination}>{busy ? 'Saving task context…' : 'Save task dependencies'}</button>
      {saved ? <p role="status">Task dependencies saved.</p> : null}
    </form> : null}
  </section>
}

import { useEffect, useRef, useState } from 'react'
import type { KnowledgeReference } from '../../core/knowledge-record-contracts'
import type { SourcePassage } from '../../core/source-catalog'
import type { WorkItem } from '../../core/types'
import type { DesktopApi } from '../../shared/desktop-api'
import { referenceLabel } from './knowledge-reference-label'

export function KnowledgeReferenceFields({ api, projectId, workItems, references, onChange }: { api: DesktopApi; projectId: string; workItems: WorkItem[]; references: KnowledgeReference[]; onChange(values: KnowledgeReference[]): void }): JSX.Element {
  const [kind, setKind] = useState<KnowledgeReference['kind']>('source')
  const [value, setValue] = useState('')
  const [passages, setPassages] = useState<SourcePassage[]>([])
  const [error, setError] = useState<string>()
  const [searching, setSearching] = useState(false)
  const [options, setOptions] = useState<Array<{ id: string; title: string }>>([])
  const generation = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    setOptions([])
    const pending = kind === 'record' ? api.knowledgeRecords?.list(projectId).then((records) => records.map((record) => ({ id: record.id, title: `${record.title} · ${record.status}` }))) : kind === 'entity' ? api.projectDirectory?.list(projectId).then((entities) => entities.map((entity) => ({ id: entity.id, title: entity.displayName }))) : kind === 'wiki' ? api.knowledge.listWiki(projectId).then((articles) => articles.map((article) => ({ id: article.slug, title: article.slug }))) : undefined
    void pending?.then((values) => { if (current) setOptions(values) }).catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false }
  }, [api, projectId, kind])
  const add = (reference: KnowledgeReference): void => {
    if (!references.some((current) => JSON.stringify(current) === JSON.stringify(reference))) onChange([...references, reference])
    setValue(''); setPassages([])
  }
  const search = async (): Promise<void> => {
    const request = ++generation.current
    setError(undefined); setSearching(true)
    try { const found = await api.sourceCatalog.search(projectId, value); if (alive.current && request === generation.current) setPassages(found) }
    catch (reason) { if (alive.current && request === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current && request === generation.current) setSearching(false) }
  }
  return <fieldset className="knowledge-reference-fields">
    <legend>Supporting evidence and affected scope</legend>
    {references.length ? <ul className="knowledge-reference-list">{references.map((reference, index) => <li key={index}><span>{referenceLabel(reference, workItems)}</span><button className="secondary-button" type="button" aria-label={`Remove reference ${index + 1}`} onClick={() => onChange(references.filter((_, candidate) => candidate !== index))}>Remove</button></li>)}</ul> : <p className="muted">No references yet. Accepted guidance should identify the evidence that supports it.</p>}
    <label className="field-label">Reference type<select aria-label="Reference type" value={kind} onChange={(event) => { generation.current++; setKind(event.target.value as KnowledgeReference['kind']); setValue(''); setPassages([]); setError(undefined); setSearching(false) }}><option value="source">Exact source passage</option><option value="file">Repository file</option><option value="work_item">Work item</option><option value="wiki">Wiki article</option><option value="record">Decision, requirement or risk</option><option value="entity">Component or glossary term</option></select></label>
    {kind === 'work_item' ? <label className="field-label">Related task<select aria-label="Reference work item" value={value} onChange={(event) => setValue(event.target.value)}><option value="">Choose a task</option>{workItems.map((item) => <option value={item.id} key={item.id}>{item.displayId}: {item.title}</option>)}</select></label> : kind === 'record' || kind === 'entity' || kind === 'wiki' ? <label className="field-label">Related record<select aria-label="Related knowledge reference" value={value} onChange={(event) => setValue(event.target.value)}><option value="">Choose a reference</option>{options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label> : <label className="field-label">{kind === 'source' ? 'Search source evidence' : 'Repository path'}<input aria-label="Reference value" value={value} maxLength={2000} onChange={(event) => { generation.current++; setValue(event.target.value); setPassages([]); setSearching(false) }} /></label>}
    <button className="secondary-button" type="button" disabled={!value.trim() || searching} onClick={() => {
      if (kind === 'source') { void search(); return }
      add(kind === 'file' ? { kind, path: value.trim() } : kind === 'wiki' ? { kind, slug: value.trim() } : { kind, id: value.trim() })
    }}>{kind === 'source' ? searching ? 'Searching evidence…' : 'Find source passages' : 'Add reference'}</button>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {passages.length ? <ul className="source-passage-results">{passages.map((passage) => <li key={passage.citation.passageId}><button className="retrieval-result" type="button" onClick={() => add({ kind: 'source', citation: passage.citation })}><strong>{passage.title}</strong><span>{passage.text}</span><small>Add exact revision · lines {passage.citation.startLine}–{passage.citation.endLine}</small></button></li>)}</ul> : null}
  </fieldset>
}

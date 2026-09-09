import type { KnowledgeReference } from '../../core/knowledge-record-contracts'
import type { WorkItem } from '../../core/types'

export function referenceLabel(reference: KnowledgeReference, workItems: WorkItem[] = []): string {
  if (reference.kind === 'source') return `Source passage · lines ${reference.citation.startLine}–${reference.citation.endLine} · ${reference.citation.locator}`
  if (reference.kind === 'file') return `File · ${reference.path}`
  if (reference.kind === 'wiki') return `Wiki article · ${reference.slug}`
  const item = reference.kind === 'work_item' ? workItems.find((candidate) => candidate.id === reference.id) : undefined
  return `${reference.kind === 'work_item' ? 'Task' : reference.kind === 'entity' ? 'Directory entry' : 'Knowledge record'} · ${item ? `${item.displayId}: ${item.title}` : reference.id}`
}

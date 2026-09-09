import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { ProjectStore } from './project-store'
import { SourceCatalogRepository } from './source-catalog'
import type { KnowledgeReference } from './knowledge-record-contracts'
import type { Clock } from './clock'
import { excludedEvidencePath } from './evidence-policy'

export function inspectKnowledgeReference(store: ProjectStore, reference: KnowledgeReference, clock?: Clock): { code: 'broken_reference' | 'stale_evidence'; reason: string } | undefined {
  try {
    if (reference.kind === 'source') {
      const passage = new SourceCatalogRepository(store, { clock }).readCitation(reference.citation).passage
      if (passage.historical || passage.readiness !== 'ready') return { code: 'stale_evidence', reason: `The cited source revision is ${passage.historical ? 'historical' : passage.readiness}; review against current evidence.` }
    } else if (reference.kind === 'file') {
      const absolute = path.resolve(store.project.rootPath, reference.path)
      const relative = path.relative(store.project.rootPath, absolute)
      if (path.isAbsolute(reference.path) || relative === '..' || relative.startsWith(`..${path.sep}`) || excludedEvidencePath(reference.path)) throw new Error('The file reference is outside permitted project evidence.')
      const actual = realpathSync(absolute)
      const actualRelative = path.relative(realpathSync(store.project.rootPath), actual)
      if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative) || !lstatSync(actual).isFile()) throw new Error('The file reference does not resolve to a project file.')
    } else if (reference.kind === 'work_item') {
      if (!store.database.prepare('SELECT id FROM work_items WHERE id = ?').get(reference.id)) throw new Error('The linked work item does not exist in this project.')
    } else if (reference.kind === 'record') {
      const record = store.database.prepare('SELECT status FROM knowledge_records WHERE id = ?').get(reference.id) as { status: string } | undefined
      if (!record) throw new Error('The linked knowledge record does not exist in this project.')
      if (record.status === 'superseded') return { code: 'stale_evidence', reason: 'The linked knowledge record has been superseded; follow its replacement.' }
    } else if (reference.kind === 'entity') {
      const entity = store.database.prepare('SELECT status FROM project_entities WHERE id = ?').get(reference.id) as { status: string } | undefined
      if (!entity) throw new Error('The linked component or term does not exist in this project.')
      if (entity.status === 'retired') return { code: 'stale_evidence', reason: 'The linked component or term is retired.' }
    } else {
      const source = store.database.prepare('SELECT id FROM source_catalog WHERE id = ?').get(`wiki:${reference.slug}`) as { id: string } | undefined
      if (source) {
        const state = new SourceCatalogRepository(store, { clock }).getSource(source.id)
        if (!state.currentRevisionId || state.deletedAt) throw new Error('The linked wiki article is no longer published.')
        if (state.state !== 'ready') return { code: 'stale_evidence', reason: `The linked wiki article is ${state.state}.` }
      } else if (!lstatSync(path.join(store.paths.wikiPath, `${reference.slug}.md`)).isFile()) throw new Error('The linked wiki article does not exist.')
    }
  } catch (error) { return { code: 'broken_reference', reason: error instanceof Error ? error.message : 'The reference could not be resolved.' } }
  return undefined
}

export function referenceKey(reference: KnowledgeReference): string {
  if (reference.kind === 'source') return `source:${reference.citation.sourceId}:${reference.citation.revisionId}:${reference.citation.passageId}`
  if (reference.kind === 'file') return `file:${reference.path}`
  if (reference.kind === 'wiki') return `wiki:${reference.slug}`
  return `${reference.kind}:${reference.id}`
}

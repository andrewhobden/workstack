import type Database from 'better-sqlite3'
import type { SourceCitation } from './source-catalog'

export type WikiPageCitations = Record<string, SourceCitation[]>

/** Resolve old publications without rewriting their immutable review evidence. New revisions store the complete map. */
export function readWikiPageCitations(database: Database.Database, revisionId: string): WikiPageCitations {
  const revision = database.prepare('SELECT evidence_json,base_revision_id FROM wiki_revisions WHERE id = ?').get(revisionId) as { evidence_json: string; base_revision_id: string | null }
  const evidence = JSON.parse(revision.evidence_json) as { pageSourceCitations?: WikiPageCitations; sourceCitations?: SourceCitation[]; restoredFrom?: string }
  const pages = database.prepare('SELECT slug,content_hash FROM wiki_revision_pages WHERE revision_id = ?').all(revisionId) as Array<{ slug: string; content_hash: string }>
  if (evidence.pageSourceCitations) return Object.fromEntries(pages.map(({ slug }) => [slug, evidence.pageSourceCitations![slug] ?? []]))
  const inheritedFrom = evidence.restoredFrom ?? revision.base_revision_id
  const inherited = inheritedFrom ? readWikiPageCitations(database, inheritedFrom) : {}
  const base = new Map((revision.base_revision_id ? database.prepare('SELECT slug,content_hash FROM wiki_revision_pages WHERE revision_id = ?').all(revision.base_revision_id) as Array<{ slug: string; content_hash: string }> : []).map((value) => [value.slug, value.content_hash]))
  return Object.fromEntries(pages.map(({ slug, content_hash }) => [slug,
    !evidence.restoredFrom && evidence.sourceCitations && base.get(slug) !== content_hash ? evidence.sourceCitations : inherited[slug] ?? []]))
}

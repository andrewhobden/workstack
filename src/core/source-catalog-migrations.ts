export const sourceCatalogMigrations = [{
  version: 11,
  sql: `
    CREATE TABLE source_catalog (
      id TEXT PRIMARY KEY REFERENCES knowledge_sources(id), kind TEXT NOT NULL, title TEXT NOT NULL,
      canonical_uri TEXT NOT NULL UNIQUE, repository_path TEXT, work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      policy TEXT NOT NULL DEFAULT 'import_once', state TEXT NOT NULL DEFAULT 'refresh_pending',
      current_revision_id TEXT, observed_upstream_revision TEXT, refresh_seconds INTEGER NOT NULL DEFAULT 3600,
      last_attempt_at TEXT, last_successful_check_at TEXT, last_content_change_at TEXT, next_refresh_at TEXT,
      stale_reason TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE source_revisions (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_catalog(id),
      content_hash TEXT NOT NULL, normalized_hash TEXT NOT NULL, original_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
      upstream_revision TEXT, acquired_by TEXT NOT NULL, acquired_at TEXT NOT NULL, converter TEXT NOT NULL,
      converter_version TEXT NOT NULL, outcome TEXT NOT NULL, manifest_json TEXT NOT NULL,
      UNIQUE(source_id, content_hash, normalized_hash, converter, converter_version, outcome)
    );
    CREATE INDEX source_revisions_source_idx ON source_revisions(source_id, acquired_at, id);
    CREATE TABLE source_passages (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_catalog(id), revision_id TEXT NOT NULL REFERENCES source_revisions(id),
      ordinal INTEGER NOT NULL, heading_json TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, text TEXT NOT NULL, passage_hash TEXT NOT NULL,
      structure_json TEXT NOT NULL, UNIQUE(revision_id, ordinal)
    );
    CREATE VIRTUAL TABLE source_passage_search USING fts5(
      passage_id UNINDEXED, title, heading, text, tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
    );
    CREATE TABLE source_intake_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES source_catalog(id),
      job_id TEXT REFERENCES knowledge_jobs(id), attempt INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL, outcome TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE source_dependents (
      source_id TEXT NOT NULL REFERENCES source_catalog(id), revision_id TEXT NOT NULL REFERENCES source_revisions(id),
      artifact_kind TEXT NOT NULL, artifact_id TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
      reason TEXT, queued_at TEXT, PRIMARY KEY(source_id, revision_id, artifact_kind, artifact_id)
    );
    CREATE INDEX source_catalog_due_idx ON source_catalog(policy, next_refresh_at);
  `
}, {
  version: 13,
  sql: `ALTER TABLE source_catalog ADD COLUMN verified_upstream_revision TEXT;
    UPDATE source_catalog SET verified_upstream_revision = CASE WHEN state = 'ready' THEN observed_upstream_revision
      ELSE (SELECT upstream_revision FROM source_revisions WHERE id = current_revision_id) END;`
}] as const

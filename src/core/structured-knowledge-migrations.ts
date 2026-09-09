export const structuredKnowledgeMigrations = [{
  version: 32,
  sql: `
    CREATE TABLE knowledge_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, markdown TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]', superseded_by TEXT REFERENCES knowledge_records(id),
      confidence REAL, review_due_at TEXT, last_reviewed_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_record_history (
      record_id TEXT NOT NULL REFERENCES knowledge_records(id), version INTEGER NOT NULL, actor TEXT NOT NULL,
      reason TEXT NOT NULL, changed_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(record_id,version)
    );
    CREATE TABLE knowledge_record_reviews (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES knowledge_records(id), actor TEXT NOT NULL, note TEXT NOT NULL,
      outcome TEXT NOT NULL, reviewed_at TEXT NOT NULL, record_version INTEGER NOT NULL
    );
    CREATE INDEX knowledge_records_status_idx ON knowledge_records(kind,status);
    CREATE VIRTUAL TABLE knowledge_record_search USING fts5(record_id UNINDEXED, title, markdown, rationale, tokenize = "unicode61 remove_diacritics 2 tokenchars '_'");
  `
}, {
  version: 33,
  sql: `
    CREATE TABLE project_entities (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
      definition TEXT NOT NULL, references_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
      merged_into TEXT REFERENCES project_entities(id), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE project_entity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL REFERENCES project_entities(id), action TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
    );
    CREATE TABLE project_mentions (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_catalog(id), revision_id TEXT NOT NULL REFERENCES source_revisions(id),
      entity_id TEXT REFERENCES project_entities(id), candidate_ids_json TEXT NOT NULL, surface TEXT NOT NULL, citation_json TEXT NOT NULL,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, resolution TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX project_mentions_entity_idx ON project_mentions(entity_id,active);
    CREATE INDEX project_mentions_source_idx ON project_mentions(source_id,revision_id);
    CREATE TABLE project_mention_scopes (source_id TEXT PRIMARY KEY REFERENCES source_catalog(id), revision_id TEXT, directory_version INTEGER NOT NULL, readiness TEXT NOT NULL);
    CREATE TABLE project_directory_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
    INSERT INTO project_directory_state (id,version) VALUES (1,0);
    CREATE TABLE project_mention_history (id INTEGER PRIMARY KEY AUTOINCREMENT, mention_id TEXT NOT NULL REFERENCES project_mentions(id), actor TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `
}] as const

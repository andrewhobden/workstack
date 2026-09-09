export const wikiRevisionMigrations = [{ version: 20, sql: `
  CREATE TABLE wiki_revisions (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    author TEXT NOT NULL, rationale TEXT NOT NULL,
    base_revision_id TEXT, status TEXT NOT NULL CHECK(status IN ('proposed','published','superseded','rejected')),
    evidence_json TEXT NOT NULL, actor TEXT, review_note TEXT, created_at TEXT NOT NULL, reviewed_at TEXT
  );
  CREATE TABLE wiki_revision_pages (
    revision_id TEXT NOT NULL REFERENCES wiki_revisions(id) ON DELETE CASCADE,
    slug TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
    PRIMARY KEY(revision_id,slug)
  );
  CREATE TABLE wiki_publication (id INTEGER PRIMARY KEY CHECK(id=1), revision_id TEXT NOT NULL REFERENCES wiki_revisions(id));
` }, { version: 21, sql: `
  ALTER TABLE wiki_automation_jobs ADD COLUMN owner TEXT;
  ALTER TABLE wiki_automation_jobs ADD COLUMN lease_expires_at TEXT;
  ALTER TABLE wiki_automation_jobs ADD COLUMN next_attempt_at TEXT;
` }] as const

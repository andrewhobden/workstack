export const contextFeedbackMigrations = [{ version: 51, sql: `
  CREATE TABLE context_feedback (
    id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, packet_id TEXT NOT NULL REFERENCES context_packets(id), category TEXT NOT NULL,
    note TEXT NOT NULL, source_references_json TEXT NOT NULL, actor TEXT NOT NULL, author_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed', action TEXT, target TEXT, triage_note TEXT, triaged_by TEXT,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX context_feedback_task_idx ON context_feedback(work_item_id,created_at);
  CREATE INDEX context_feedback_packet_idx ON context_feedback(packet_id,status);
  CREATE TABLE context_feedback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id TEXT NOT NULL REFERENCES context_feedback(id),
    actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
  );
` }] as const

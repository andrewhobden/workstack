export const contextPacketMigrations = [{ version: 50, sql: `
  CREATE TABLE context_policy (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, policy_json TEXT NOT NULL);
  CREATE TABLE context_task_preferences (work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE, version INTEGER NOT NULL, preferences_json TEXT NOT NULL);
  CREATE TABLE context_packets (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, packet_json TEXT NOT NULL, UNIQUE(work_item_id,version));
  CREATE INDEX context_packets_task ON context_packets(work_item_id,version DESC);
  CREATE TABLE context_packet_artifacts (packet_id TEXT NOT NULL REFERENCES context_packets(id), attachment_id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(packet_id,attachment_id));
  CREATE TABLE context_packet_usage (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL REFERENCES context_packets(id), kind TEXT NOT NULL, state TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT, claim_id TEXT, prompt_markdown TEXT);
  CREATE INDEX context_packet_usage_packet ON context_packet_usage(packet_id,created_at);
` }] as const

import type Database from 'better-sqlite3'

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        root_path TEXT NOT NULL UNIQUE,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        sequence_number INTEGER NOT NULL UNIQUE,
        display_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('feature', 'bug', 'chore')),
        title TEXT NOT NULL,
        description_markdown TEXT NOT NULL DEFAULT '',
        acceptance_criteria_markdown TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high', 'normal', 'low')),
        status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'in_progress', 'completed')),
        source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'ai_plan', 'mcp')),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE work_claims (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        agent_display_name TEXT,
        session_id TEXT,
        claim_token_hash TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'released', 'expired', 'completed'))
      );

      CREATE TABLE completion_records (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
        summary_markdown TEXT NOT NULL,
        implementation_notes_markdown TEXT NOT NULL DEFAULT '',
        validation_markdown TEXT NOT NULL DEFAULT '',
        known_limitations_markdown TEXT NOT NULL DEFAULT '',
        files_changed_json TEXT,
        components_changed_json TEXT,
        commit_sha TEXT,
        branch TEXT,
        pr_url TEXT,
        completed_by_agent_id TEXT,
        completed_by_session_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
        planning_session_id TEXT,
        original_filename TEXT NOT NULL,
        stored_relative_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        CHECK(work_item_id IS NOT NULL OR planning_session_id IS NOT NULL)
      );

      CREATE TABLE planning_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('open', 'converted', 'abandoned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        converted_work_item_id TEXT REFERENCES work_items(id)
      );

      CREATE TABLE planning_messages (
        id TEXT PRIMARY KEY,
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE work_item_proposals (
        planning_session_id TEXT PRIMARY KEY REFERENCES planning_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'feature' CHECK(type IN ('feature', 'bug', 'chore')),
        description_markdown TEXT NOT NULL DEFAULT '',
        requirements_markdown TEXT NOT NULL DEFAULT '',
        acceptance_criteria_markdown TEXT NOT NULL DEFAULT '',
        implementation_context_markdown TEXT NOT NULL DEFAULT '',
        related_references_json TEXT NOT NULL DEFAULT '[]',
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high', 'normal', 'low')),
        user_modified_fields_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('file', 'work_completion', 'manual', 'folder', 'other')),
        display_name TEXT NOT NULL,
        relative_or_external_location TEXT NOT NULL,
        source_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
        content_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'indexed', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_jobs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('human', 'agent', 'system')),
        actor_id TEXT,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE work_item_search USING fts5(
        work_item_id UNINDEXED,
        title,
        description_markdown,
        acceptance_criteria_markdown,
        completion_markdown
      );

      CREATE INDEX work_items_status_updated_idx ON work_items(status, updated_at DESC);
      CREATE INDEX activity_events_created_idx ON activity_events(created_at DESC);
      CREATE INDEX knowledge_sources_status_idx ON knowledge_sources(status, updated_at DESC);
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE work_claims_next (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        agent_display_name TEXT,
        session_id TEXT,
        claim_token_hash TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'released', 'expired', 'completed')),
        release_reason TEXT,
        blocked_reason TEXT,
        released_at TEXT,
        completed_at TEXT
      );

      INSERT INTO work_claims_next (
        id, work_item_id, agent_id, agent_display_name, session_id, claim_token_hash,
        claimed_at, last_heartbeat_at, lease_expires_at, state
      )
      SELECT
        work_item_id || '-legacy',
        work_item_id,
        agent_id,
        agent_display_name,
        session_id,
        claim_token_hash,
        claimed_at,
        last_heartbeat_at,
        lease_expires_at,
        state
      FROM work_claims;

      DROP TABLE work_claims;
      ALTER TABLE work_claims_next RENAME TO work_claims;
      CREATE UNIQUE INDEX work_claims_one_active_per_item_idx
        ON work_claims(work_item_id)
        WHERE state = 'active';
      CREATE INDEX work_claims_item_history_idx
        ON work_claims(work_item_id, claimed_at DESC);
    `
  },
  {
    version: 3,
    sql: `
      CREATE VIRTUAL TABLE knowledge_search USING fts5(
        source_id UNINDEXED,
        title,
        content
      );
      CREATE INDEX knowledge_jobs_source_idx ON knowledge_jobs(source_id, status);
    `
  }
] as const

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const currentVersion = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number }

  for (const migration of migrations) {
    if (migration.version <= currentVersion.version) {
      continue
    }

    database.transaction(() => {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString())
    })()
  }
}

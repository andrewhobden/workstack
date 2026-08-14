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
  },
  {
    version: 4,
    sql: `
      CREATE TABLE knowledge_chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES knowledge_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content_markdown TEXT NOT NULL,
        tool_call_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_chat_tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES knowledge_chat_sessions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE knowledge_chat_pending_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES knowledge_chat_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('create_work_item')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX knowledge_chat_sessions_project_idx ON knowledge_chat_sessions(project_id, updated_at DESC);
      CREATE INDEX knowledge_chat_messages_session_idx ON knowledge_chat_messages(session_id, created_at ASC);
      CREATE INDEX knowledge_chat_pending_actions_session_idx ON knowledge_chat_pending_actions(session_id, status);
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE wiki_automation_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt_markdown TEXT NOT NULL,
        source_paths_json TEXT NOT NULL DEFAULT '[]',
        requested_by TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE wiki_automation_artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES wiki_automation_jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('dependency_graph', 'wiki_draft', 'wiki_article')),
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        relative_path TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE wiki_automation_handoffs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES wiki_automation_jobs(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        summary_markdown TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX wiki_automation_jobs_status_idx ON wiki_automation_jobs(status, created_at ASC);
      CREATE INDEX wiki_automation_artifacts_job_idx ON wiki_automation_artifacts(job_id, created_at ASC);
      CREATE INDEX wiki_automation_handoffs_job_idx ON wiki_automation_handoffs(job_id, status, created_at ASC);
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE completion_records
        ADD COLUMN session_summary_markdown TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 7,
    sql: `
      ALTER TABLE wiki_automation_jobs
        ADD COLUMN merge_key TEXT;
      ALTER TABLE wiki_automation_jobs
        ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

      CREATE UNIQUE INDEX wiki_automation_jobs_merge_key_idx
        ON wiki_automation_jobs(merge_key)
        WHERE merge_key IS NOT NULL;

      CREATE TABLE wiki_automation_merge_evidence (
        job_id TEXT PRIMARY KEY REFERENCES wiki_automation_jobs(id) ON DELETE CASCADE,
        pull_request_url TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        pull_request_title TEXT NOT NULL,
        head_ref_name TEXT NOT NULL,
        merged_at TEXT,
        merge_commit_sha TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        session_summary_markdown TEXT NOT NULL DEFAULT '',
        diff_markdown TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX wiki_automation_merge_evidence_commit_idx
        ON wiki_automation_merge_evidence(merge_commit_sha);
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

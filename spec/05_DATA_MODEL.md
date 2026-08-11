# Data Model

## 1. Core entities

### Project
- `id: UUID`
- `name: string`
- `description: string?`
- `root_path: string`
- `created_at`
- `updated_at`
- `settings_json`

### WorkItem
- `id: UUID` — stable internal identity
- `sequence_number: integer` — project-local monotonically increasing number
- `display_id: string` — e.g. `WS-104`, derived/persisted prefix + number
- `type: feature | bug | chore`
- `title: string`
- `description_markdown: string`
- `acceptance_criteria_markdown: string?`
- `priority: high | normal | low`
- `status: backlog | in_progress | completed`
- `source: manual | ai_plan | mcp`
- `created_by: string?`
- `created_at`
- `updated_at`
- `completed_at?`

### WorkClaim
At most one active claim per work item.
- `work_item_id`
- `agent_id`
- `agent_display_name?`
- `session_id?`
- `claim_token_hash` (prefer storing a hash, not plaintext token)
- `claimed_at`
- `last_heartbeat_at`
- `lease_expires_at`
- `state: active | released | expired | completed`

### Attachment
- `id: UUID`
- `work_item_id?`
- `planning_session_id?`
- `original_filename`
- `stored_relative_path`
- `mime_type?`
- `size_bytes`
- `sha256?`
- `created_at`

### CompletionRecord
- `work_item_id`
- `summary_markdown`
- `implementation_notes_markdown?`
- `validation_markdown?`
- `known_limitations_markdown?`
- `files_changed_json?`
- `components_changed_json?`
- `commit_sha?`
- `branch?`
- `pr_url?`
- `completed_by_agent_id?`
- `completed_by_session_id?`
- `created_at`

### PlanningSession
- `id: UUID`
- `project_id`
- `status: open | converted | abandoned`
- `created_at`
- `updated_at`
- `converted_work_item_id?`

### PlanningMessage
- `id: UUID`
- `planning_session_id`
- `role: user | assistant | system/tool`
- `content_markdown`
- `created_at`

### WorkItemProposal
- `planning_session_id`
- same primary authorable work-item fields;
- `revision`
- `user_modified_fields_json` to protect manual edits from silent AI overwrite.

### KnowledgeSource
- `id: UUID`
- `kind: file | work_completion | manual | folder | other`
- `display_name`
- `relative_or_external_location`
- `source_work_item_id?`
- `content_hash?`
- `status: pending | indexed | failed`
- `created_at`
- `updated_at`

### ActivityEvent
- `id: UUID`
- `event_type`
- `actor_type: human | agent | system`
- `actor_id?`
- `work_item_id?`
- `payload_json`
- `created_at`

## 2. Suggested SQLite schema

This is illustrative; migration tooling may adapt syntax.

```sql
CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    sequence_number INTEGER NOT NULL UNIQUE,
    display_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('feature','bug','chore')),
    title TEXT NOT NULL,
    description_markdown TEXT NOT NULL DEFAULT '',
    acceptance_criteria_markdown TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high','normal','low')),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','in_progress','completed')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai_plan','mcp')),
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
    state TEXT NOT NULL CHECK(state IN ('active','released','expired','completed'))
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
    created_at TEXT NOT NULL
);

CREATE TABLE activity_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('human','agent','system')),
    actor_id TEXT,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
```

## 3. Display ID allocation

A project should have a configurable short prefix, default derived from project name, e.g. `WS`.

Sequence allocation must be transaction-safe. Do not calculate `MAX(sequence_number)+1` outside a transaction.

## 4. Work item exported Markdown

Example `work-item.md`:

```markdown
---
id: 96bb…
display_id: WS-109
type: feature
status: backlog
priority: normal
created_at: 2026-08-11T10:42:00+08:00
---

# Support pasted images in work items

## Description
Users should be able to paste screenshots directly into the description.

## Acceptance criteria
- [ ] Image can be pasted.
- [ ] Image is persisted as an artifact.
- [ ] Markdown reference renders correctly after restart.
```

## 5. Completion Markdown

Example `completion.md`:

```markdown
---
work_item: WS-109
completed_at: 2026-08-11T14:21:00+08:00
agent: claude-code
session: claude-7f94b
commit: 81baf02
---

# Completion

Implemented direct clipboard image support in the Markdown editor.

## Changes
- Added clipboard image handler.
- Added artifact storage support.
- Inserted relative Markdown references.

## Validation
- Unit tests passed.
- Clipboard paste verified.
- Restart persistence verified.

## Known limitations
None known.
```

## 6. History/auditing

Do not attempt full event sourcing in V1, but create ActivityEvent records for important mutations so the UI can display a coherent history.

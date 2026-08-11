# Workstack MCP Server Specification

## 1. Objective

Expose project knowledge and the work queue to coding agents without requiring agents to manipulate Workstack files or SQLite directly.

The MCP server is the supported agent contract. Domain validation belongs behind the contract.

## 2. Project resolution

Every tool that operates on a project must support a stable project identifier. When the MCP server is configured per-project, `project_id` may be optional, but the protocol implementation should still retain an internal explicit project identity.

## 3. Read tools

### `workstack_search_knowledge`
Purpose: retrieve relevant wiki/project knowledge.

Input:
```json
{
  "project_id": "uuid",
  "query": "How are work items stored?",
  "limit": 10
}
```

Output items:
```json
{
  "results": [
    {
      "source_type": "knowledge",
      "source_id": "knowledge/wiki/data-model.md",
      "title": "Data Model",
      "excerpt": "Work items are persisted in SQLite...",
      "score": 0.91
    }
  ]
}
```

### `workstack_list_backlog`
Filters:
- type
- priority
- text query
- limit

Return compact summaries, not full artifact payloads.

### `workstack_search_completed`
Search previously implemented work by title, description and completion record.

### `workstack_get_work_item`
Return:
- canonical fields;
- description;
- acceptance criteria;
- attachments with safe local resource references/paths;
- current claim state;
- completion record if completed;
- relevant history.

## 4. Mutation tools

### `workstack_claim_work_item`
Input:
```json
{
  "project_id": "uuid",
  "work_item_id": "WS-109",
  "agent_id": "claude-code",
  "agent_display_name": "Claude Code",
  "session_id": "claude-7f94b",
  "requested_lease_seconds": 1800
}
```

Success:
```json
{
  "claimed": true,
  "work_item_id": "WS-109",
  "claim_token": "opaque-high-entropy-token",
  "lease_expires_at": "2026-08-11T14:07:00+08:00",
  "recommended_heartbeat_seconds": 300
}
```

Conflict:
```json
{
  "claimed": false,
  "error": {
    "code": "WORK_ITEM_NOT_CLAIMABLE",
    "message": "WS-109 is already claimed by another active agent."
  },
  "current_claim": {
    "agent_display_name": "Codex",
    "lease_expires_at": "..."
  }
}
```

The server must never return an existing claim token to a different caller.

### `workstack_heartbeat_work_item`
Input:
```json
{
  "project_id": "uuid",
  "work_item_id": "WS-109",
  "claim_token": "..."
}
```

Behavior:
- validate token against current active claim;
- extend lease using project policy;
- update `last_heartbeat_at`;
- return new expiry.

### `workstack_release_work_item`
Requires claim token.

Optional input:
- reason.

Behavior:
- mark claim released;
- transition item back to Backlog;
- record activity event.

### `workstack_block_work_item`
Requires claim token.

Input:
- reason (required);
- retain_claim: boolean, default false.

If retain_claim=false:
- record blocked reason/event;
- release to Backlog.

If retain_claim=true:
- keep In Progress and active lease;
- expose attention state to UI.

### `workstack_complete_work_item`
Requires valid active claim token.

Input:
```json
{
  "project_id": "uuid",
  "work_item_id": "WS-109",
  "claim_token": "...",
  "completion": {
    "summary_markdown": "Implemented ...",
    "implementation_notes_markdown": "...",
    "validation_markdown": "...",
    "known_limitations_markdown": "...",
    "files_changed": ["Sources/WorkItemEditor.swift"],
    "components_changed": ["editor", "artifact-store"],
    "commit_sha": "81baf02",
    "branch": "workstack/ws-109",
    "pr_url": null
  }
}
```

Behavior must be transactional:
1. verify item is In Progress;
2. verify active token and unexpired ownership;
3. create completion record;
4. mark claim completed;
5. mark item Completed;
6. write activity event;
7. export/update Markdown mirrors;
8. enqueue knowledge-ingestion source.

Return completion success even if the later knowledge-maintenance job fails; report knowledge job state separately.

## 5. Optional MCP resources

Useful resource URIs may include:
- `workstack://project/{id}/overview`
- `workstack://project/{id}/knowledge/index`
- `workstack://work-item/{id}`

Do not rely on resources alone for mutable operations.

## 6. Error model

Use stable machine-readable codes such as:
- `PROJECT_NOT_FOUND`
- `WORK_ITEM_NOT_FOUND`
- `WORK_ITEM_NOT_CLAIMABLE`
- `CLAIM_TOKEN_INVALID`
- `CLAIM_EXPIRED`
- `INVALID_STATE_TRANSITION`
- `ATTACHMENT_NOT_FOUND`
- `VALIDATION_ERROR`
- `STORE_BUSY`
- `INTERNAL_ERROR`

Errors should include a concise agent-actionable message.

## 7. Guidance exposed to agents

The MCP server description/instructions should tell agents:

1. Query relevant knowledge before implementation.
2. Review related completed work when useful.
3. Do not begin code changes until `workstack_claim_work_item` succeeds.
4. Heartbeat while actively working.
5. Release if abandoning the task.
6. Complete with a meaningful summary and validation details.
7. Never edit `.workstack/workstack.db` directly.

## 8. Idempotency

- Read operations are naturally idempotent.
- Heartbeat with the same valid claim is safe.
- Completion should return an explicit already-completed result if the same caller retries after a network/process interruption rather than corrupting state.
- Release of an already released/expired claim should return a stable non-success or idempotent result as chosen by implementation, documented consistently.

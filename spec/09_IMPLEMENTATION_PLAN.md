# Suggested Implementation Plan

The goal is to build an end-to-end vertical slice early, then add AI/knowledge sophistication.

## Phase 0 — Repository foundation

Deliverables:
- app project structure;
- core/domain package;
- database/migration layer;
- MCP executable target/skeleton;
- test targets;
- sample fixture project.

Exit criteria:
- application launches;
- project database can be created/opened;
- migrations run reliably.

## Phase 1 — Projects + work-item core

Build:
- global project registry;
- create/open/edit/delete project;
- `.workstack` directory initialization;
- WorkItem CRUD;
- Backlog/In Progress/Completed queries;
- activity events;
- Markdown export mirrors.

UI:
- Projects/Home;
- sidebar;
- Overview skeleton;
- Backlog;
- New Work Item;
- Work Item Detail;
- Completed.

Exit criteria:
A user can create a project and manually manage work through local UI.

## Phase 2 — Artifacts

Build:
- attachment metadata;
- file copy/store service;
- drag/drop;
- file picker;
- pasted image support;
- preview/Quick Look;
- Markdown relative image references.

Exit criteria:
Artifacts survive restart and are available through work-item detail APIs.

## Phase 3 — Claims and agent coordination

Build core first:
- atomic claim transaction;
- claim tokens;
- heartbeat;
- release;
- expiry;
- completion transaction;
- concurrency tests.

UI:
- In Progress page;
- active work-item status;
- agent detail;
- stale/lease warning;
- forced release.

Exit criteria:
20 concurrent attempts against one item result in exactly one owner.

## Phase 4 — MCP server

Implement tools from `06_MCP_SERVER_SPEC.md`.

Add:
- stdio startup;
- project resolution/config;
- structured error model;
- `Copy MCP Configuration` UI;
- diagnostic logs.

Exit criteria:
An external coding agent/client can discover, claim, heartbeat and complete a work item without touching internal DB/files directly.

## Phase 5 — Knowledge foundation

Build:
- knowledge directory initialization;
- article browser/editor;
- knowledge sources;
- full-text search;
- completion records registered as raw sources;
- semantic/vector provider abstraction if embeddings are included.

Exit criteria:
Knowledge can be added/browsed/searched and retrieved through MCP.

## Phase 6 — AI planning

Build:
- AI provider configuration/secure credentials;
- planning sessions/messages;
- context retrieval;
- streaming chat;
- work-item proposal;
- proposal edit protection;
- convert proposal to Backlog;
- planning attachments.

Exit criteria:
User can discuss a project-aware feature and create a backlog item from the proposal.

## Phase 7 — AI wiki maintenance

Build:
- completion ingestion queue;
- topic/page update flow;
- provenance/source state;
- `index.md`, `schema.md`, `log.md` maintenance;
- retry/error UI.

Exit criteria:
Completing a task can update durable project knowledge without blocking completion.

## Phase 8 — Polish

- command palette;
- shortcuts;
- accessibility;
- empty states;
- dark mode/system appearance;
- robust error recovery;
- backup/migration UX;
- performance pass;
- packaging/notarization as appropriate.

## Engineering priorities

When tradeoffs occur, prioritize in this order:
1. state/concurrency correctness;
2. data durability;
3. MCP contract stability;
4. UX clarity;
5. AI sophistication;
6. cosmetic polish.

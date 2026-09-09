# Project and agent setup

## Register a project

In the desktop, add a trusted existing project folder and give it a distinct visible name and work-item prefix. Choose the Git repository root if you intend to launch Copilot. Workstack will store project data under that root; attaching an existing Workstack project preserves its identity and history.

Keep project names distinct. MCP accepts the visible name in `project` and a UUID in the legacy `project_id` field. Work-item references accept the immutable UUID or exact display ID, including tasks older than the newest 100 items.

Register only directories whose contents and configuration you trust. Repository hooks, build scripts, custom agent instructions, and dependency installation can execute code when a broadly authorized external agent runs them. Workstack claims coordinate ownership; they are not a sandbox or authentication boundary between untrusted clients.

## Configure optional AI features

Open the desktop's **AI provider** settings and enter the provider base URL, API mode, model, and key. The supported protocol adapters are Chat Completions, Responses, and Messages. Choose the mode matching your endpoint; model IDs and availability come from your provider. Local loopback providers can operate without a key. Remote endpoints require credentials.

Workstack encrypts stored keys with Electron `safeStorage` and binds them to the normalized provider base URL and API mode. Changing that association clears the reusable credential; re-enter a key for the new provider. Credentials belong in provider settings, not task descriptions, wiki pages, screenshots, or committed project files. Provider availability does not prevent manual task creation or ordinary MCP coordination.

Automatic evidence preparation excludes common sensitive paths and redacts common credential forms before sending context. This is a defense for prepared reference material, not a guarantee that every possible secret can be recognized. Review what you attach or write in project knowledge.

## Connect a trusted MCP client

Workstack exposes a local **stdio** MCP server. It uses the same project registry and database as the desktop and does not expose a public HTTP service. Each trusted client can discover the projects registered in that application profile; there is currently no per-project client authentication grant.

For a packaged application installed in `/Applications`, use this MCP server entry:

```json
{
  "mcpServers": {
    "workstack": {
      "command": "/Applications/Workstack.app/Contents/MacOS/Workstack",
      "args": ["--mcp"]
    }
  }
}
```

For a source checkout, run `npm run rebuild:native` and `npm run build`, then use absolute paths:

```json
{
  "mcpServers": {
    "workstack": {
      "command": "/absolute/path/to/workstack/node_modules/.bin/electron",
      "args": ["/absolute/path/to/workstack", "--mcp"]
    }
  }
}
```

Replace the checkout path with your real location. The development command needs both the app path and `--mcp`; the packaged binary needs only `--mcp`. Start with `ELECTRON_RUN_AS_NODE` unset. If you set `WORKSTACK_USER_DATA_DIR` for the desktop, provide the exact same absolute value in this MCP entry's `env` object. Otherwise the default application profile is used. After building, `npm run mcp:serve` is the equivalent development entry point; it waits for protocol input and is not an interactive shell.

The application profile contains `projects.json`, encrypted `ai-provider.json`, and deletion backups. On macOS the default Electron user-data directory is under `~/Library/Application Support/`; the development and packaged app names may differ. An explicit private `WORKSTACK_USER_DATA_DIR` removes ambiguity for development and smoke tests.

## Complete create–claim–complete example

Create a desktop project named **Example project**, with prefix **EX**. The following are MCP tool names and JSON argument objects, not shell commands. Replace the returned task ID and claim token at each step. Do not invent completion evidence or commit IDs.

1. Discover the project and create a task. Reuse `request_id` only when retrying this same create request; a conflicting payload with that key is rejected.

   `workstack_list_projects`:

   ```json
   {}
   ```

   `workstack_create_feature`:

   ```json
   {
     "project": "Example project",
     "title": "Document the local developer setup",
     "description_markdown": "Add verified setup instructions for this project.",
     "acceptance_criteria_markdown": "Instructions reference commands that exist and explain required tools.",
     "created_by": "copilot",
     "request_id": "example-setup-docs-1"
   }
   ```

2. Read the returned task's handoff and related knowledge. The response includes the latest checkpoint, prior completion attempts, prerequisite outcomes and advisory overlaps when available.

   `workstack_get_work_item_handoff`:

   ```json
   { "project": "Example project", "work_item_id": "EX-1" }
   ```

   `workstack_search_knowledge`:

   ```json
   { "project": "Example project", "query": "developer setup validation", "limit": 10 }
   ```

3. Claim before changing code. Explicit unfinished prerequisites reject the claim atomically. Keep the returned `claim_token` private to this attempt. Schedule heartbeats using `recommended_heartbeat_seconds`; do not assume the default interval applies to a shorter requested lease.

   First call `workstack_preview_context_packet` with the project and work item. Inspect its gaps and all required sections through `workstack_read_context_section`, following `nextOffset` until null. Read referenced full source revisions and attachments. Pass the returned packet ID when claiming; a changed task, repository, source or policy requires a new preview. See the [context workflow](project-context.md) for the exact tools and readiness policy. Copilot launch supplies its already prepared packet ID.

   `workstack_claim_work_item`:

   ```json
   {
     "project": "Example project",
     "work_item_id": "EX-1",
     "agent_id": "copilot",
     "session_id": "example-session-1",
     "context_packet_id": "<returned packet ID>",
     "requested_lease_seconds": 1800
   }
   ```

   `workstack_heartbeat_work_item`:

   ```json
   { "project": "Example project", "work_item_id": "EX-1", "claim_token": "<returned claim token>" }
   ```

4. Save progress before an interruption. Checkpoints do not complete a task or become established project knowledge. They retain the author, session, claim, and timestamp and survive release/expiry. Save the actual evidence and next actions for your work.

   `workstack_save_checkpoint`:

   ```json
   {
     "project": "Example project",
     "work_item_id": "EX-1",
     "claim_token": "<returned claim token>",
     "progress_markdown": "Drafted installation instructions after checking package scripts.",
     "files_changed": ["README.md"],
     "validation_markdown": "Verified referenced npm scripts exist; desktop smoke test remains pending.",
     "questions_markdown": "Confirm supported operating-system versions.",
     "next_actions_markdown": "Verify the documented development launch on a supported host."
   }
   ```

   `workstack_list_checkpoints` accepts the project, work-item reference, and an optional `limit` from 1 to 100. If pausing, call `workstack_release_work_item` with the same token and a reason. Released or expired tokens cannot write further checkpoints. A new attempt must obtain a new claim.

5. Complete after the work and validation are actually finished. A minimal completion without a PR finalizes immediately. Use truthful limitations if a check could not be run.

   `workstack_complete_work_item`:

   ```json
   {
     "project": "Example project",
     "work_item_id": "EX-1",
     "claim_token": "<returned claim token>",
     "completion": {
       "summary_markdown": "Documented the supported developer setup.",
       "session_summary_markdown": "Setup instructions and validation evidence are recorded for the next worker.",
       "validation_markdown": "Replace this with the commands run and their observed outcomes.",
       "files_changed": ["README.md"],
       "pr_url": null
     }
   }
   ```

For PR-based work, set `pr_url` to the actual submitted URL. The response then has `submitted: true`, `completed: false`, `delivery_state: "awaiting_review"`, `submitted_at`, and a null `completed_at`. Workstack finalizes delivery after reconciling a merge. A closed unmerged PR returns the task to backlog; a replacement claim archives its previous submission. Reopening a superseded PR cannot overwrite the replacement attempt.

Completion retries with an ended claim are rejected with `CLAIM_TOKEN_INVALID`; retrieve the handoff to determine whether the original submission succeeded. Create-request replay and merge reconciliation have their own idempotence rules. An expired claim produces `CLAIM_EXPIRED`. With automatic release disabled, the task remains in an attention state until an explicit recovery action; expiry never extends the old token.

## Dependencies and overlapping work

Open a task's **Dependencies and overlapping work** section to inspect prerequisite outcomes and active overlaps. **Edit task dependencies** accepts exact task display IDs or UUIDs, repository-relative paths, and component names. Each field replaces its existing entries; deleting a line removes that relationship. Prerequisites can change only while a task is in backlog. Circular and self dependencies are rejected without discarding the previous links.

MCP exposes `workstack_get_task_coordination` with `project` and `work_item_id`. `workstack_update_task_coordination` accepts the same references plus optional `depends_on`, `related_to`, `declared_paths`, and `declared_components` arrays. Omitted fields stay unchanged; an empty array clears that field. Backlog results include readiness, and handoffs include full coordination evidence.

A prerequisite is ready only after completion evidence is recorded and any associated PR is merged. Submitted, closed, reopened, active, and blocked prerequisites remain unresolved. Readiness is recalculated when read and inside the transaction granting a claim. Removing or completing a prerequisite therefore cannot race a claim into an invalid state.

Related tasks and overlaps are advisory. A path overlap means equal paths or a file/directory prefix at a slash boundary; components match normalized names. Evidence distinguishes declared scope from the latest checkpoint of a currently active, unexpired claim and identifies its task, agent, and session. Stale checkpoints and similarity alone never block claims. Prerequisite outcomes include completion hashes and available source revision hashes for subsequent context preparation.

## Project evidence graph

Use `workstack_query_evidence_graph` to inspect relationships around a known node, for example `{ "project": "Example project", "node_id": "file:src/api.ts", "direction": "both", "depth": 2, "max_nodes": 50, "max_edges": 100 }`. Node IDs also use `test:`, `component:`, `term:`, `decision:`, `requirement:`, `risk:`, `task:`, `source:`, and `wiki:` followed by the stored canonical reference. `edge_types` and `bases` filter relationship types and observed, declared, or inferred evidence. Record and entity references include their canonical `record:` or `entity:` prefix.

Each relationship includes a source citation, immutable graph revision, direction and explanation path. `provenanceState` indicates whether its cited revision remains current; it is not a factual confidence score. Node resolution describes the producer's recorded revision and can become outdated until that producer refreshes; typed knowledge checks and task context checks inspect current references separately. Inferred links and unresolved endpoints are explicit. Depth (maximum 5), node (200), edge (500), and revision limits report truncation. A partial repository scan replaces its import snapshot and is marked partial; it never blends imports from several graph revisions. Run a wiki codebase rescan to populate the relational import graph for older projects.

`workstack_list_knowledge_records`, `workstack_get_knowledge_record`, and `workstack_check_knowledge_records` inspect structured decisions, requirements, risks and actionable checks. `workstack_lookup_project_directory` resolves names and aliases; `workstack_get_project_entity` reads the canonical component or glossary entry, source mentions, and its history.

## Execution profiles

The project settings and launch preflight show the selected profile, intended capabilities, and workspace before execution:

| Profile | Intended access | Current launched-Copilot behavior |
| --- | --- | --- |
| Inspection, the default | Project reads; no writes, network tools, or external processes | Refused before starting an agent: this adapter has no verified enforcement for the full profile. Use knowledge chat inspection for supported purpose-built project reads. |
| Implementation | Workspace changes and validation processes with restricted network access | Refused until an adapter can enforce those boundaries. |
| Advanced, explicitly selected | The user account's filesystem, network, credentials, and external processes | Launches the existing Copilot workflow with unrestricted permissions. The displayed task worktree is the starting directory, not the full access boundary. |

Restart and merge launches apply the same selected profile. Restack is a human cleanup operation: it stops the managed worker and refuses dirty-worktree removal regardless of profile. No prompt text can select Advanced or override the persisted launch decision.

The implementation was checked against local **GitHub Copilot CLI 1.0.83** using `copilot --help`, `copilot help permissions`, `copilot help sandbox`, and configuration/environment help. Its permission flags control tool visibility and approval prompts. Interactive prompts do not establish filesystem/network isolation. Its experimental command sandbox documents best-effort enforcement for built-in file edits and additional configuration/bypass considerations; Workstack does not advertise that as a verified adapter boundary.

For an explicitly authorized Advanced launch, install and authenticate GitHub CLI and Copilot CLI using their official instructions, verify the project Git root, and choose Advanced in project settings. Workstack creates or resumes the task's recorded worktree and configures its MCP server. It preserves modified/untracked files, refuses ambiguous workspace mappings, and waits for a managed worker to exit before cleanup. No live external agent was run by the capability tests.

Context previews capture the actual Git root, HEAD and branch, plus the task worktree's own revision and changed-file hash. An existing task workspace must be a full worktree root with the expected branch and common Git repository. Untracked evidence hashes include file names, contents and modes; symbolic links contribute their target text without reading the target. Workstack's own data and lifecycle files are excluded at every repository depth. Each local Git command has a 5-second deadline and a 16 MiB output limit; tracked diff and eligible untracked content together have a 64 MiB limit. Special files, paths outside the repository, concurrent file growth beyond the budget, missing revisions and identity mismatches make the capture incomplete. Rebuild the context after resolving the reported limit or repository change. File capture is sequential; preview and launch revalidation compare the captured revisions and hashes without locking developer files.

## Data and recovery

`.workstack/workstack.db` is the authoritative project database. It stores task identities, claims, checkpoints, submission history, attachments, planning and knowledge records. `.workstack/work-items/` contains exported task/completion Markdown and attachments; `.workstack/knowledge/raw/` and `.workstack/knowledge/wiki/` contain project knowledge. `.workstack/workspaces/` records task branches, paths, and managed session PID references. `.workstack-lifecycle.sqlite` coordinates operations beside the data directory.

Register/reconnect moved projects through the desktop and keep the repository's lifecycle sidecar with its data. A project that is unavailable remains visible with recovery actions. Detach removes its registration; deletion is a separate operation with a verified backup. See [the recovery guide](recovery.md) for restoring a deletion backup, incomplete-deletion handling, and checks before reopening.

Do not treat a running SQLite file copied on its own as a consistent backup. Retain the complete verified backup and repository/worktree changes, stop active writers before manual recovery, and confirm tasks, attachments, knowledge, and workspace paths afterward.

### Shared retrieval and optional local semantic search (#40)

Desktop knowledge search, MCP `workstack_search_knowledge`, planning, knowledge chat, and asynchronous task-context previews use `KnowledgeRetrievalService`. Synchronous claim transactions use its lexical path; a previously approved, unchanged hybrid packet retains its frozen evidence when claimed. General project evidence remains eligible when a task ID is supplied; the ID biases related evidence instead of filtering everything else out.

Retrieval reads the current revisioned passage index, task index, typed records, and component/glossary index. Exact repository paths and task identifiers have an explicit boost. Catalog identity takes precedence over legacy FTS projections, including when a source is paused, metadata-only, overdue, unavailable, or superseded. Uncatalogued legacy evidence remains available with a synthetic snapshot hash and an explicit legacy locator. New manual sources and manual wiki saves publish catalog revisions; clearing a wiki article withdraws it from active retrieval.

The versioned `workstack-rrf-v1` policy combines lexical and semantic ranks with reciprocal-rank fusion: offset 60, lexical weight 0.7, semantic weight 0.3, and exact-identifier boost 0.1. Same-task matches receive an additional 0.005. Semantic cosine matches must exceed 0.05. There are at most 100 candidates from each retrieval path and one returned passage per source. Defaults are 40 results and 24,000 characters; callers may request at most 100 results and 100,000 characters. Scores express ranking, never factual confidence. Tune the policy constants alongside the offline evaluation corpus and bump the policy version when changing behavior.

Results expose `mode`, `fallbackReason`, `corpusRevision`, `configFingerprint`, `truncated`, full selected passage text, exact citations, canonical source IDs, immutable native/legacy provenance, and ranking components. `configFingerprint` covers the policy, selected model identity and a monotonic index revision; every vector insert, update, and delete changes it. Selection after asynchronous semantic work is checked against the original corpus and configuration. Changes or model failures trigger a fresh lexical selection with an explanation.

Semantic search is disabled by default. In Project Settings → Local semantic search, choose an existing local JSON word-vector pack. Workstack does not download models and never sends source content to a remote service. A pack has this format:

```json
{
  "formatVersion": 1,
  "modelId": "your-reviewed-vocabulary",
  "version": "1",
  "dimensions": 2,
  "vocabulary": {
    "example": [0.8, 0.2],
    "token": [0.1, 0.9]
  }
}
```

This example illustrates the format; it is not a useful trained model. Vocabulary keys must be lowercase word tokens. The implementation averages known token vectors and normalizes the result. Its quality depends on the selected vocabulary and cannot match every contextual embedding model. Typed decisions, requirements, risks, directory entries, uncatalogued legacy sources, and tasks retain lexical retrieval; semantic candidates cover eligible catalog passages, including passages that share no query words. Evaluate a reviewed pack with `node scripts/evaluate-context.mjs --model /absolute/path/to/pack.json` before using it as a project default. Fixture vectors in unit tests prove candidate selection and invalidation behavior, not real-world retrieval quality.

Model loading, validation, embedding, and cosine search run off the main thread. Bounds per Workstack process: one semantic worker; 8 MiB model file; 10,000 vocabulary entries; 128 dimensions; 128 MiB V8 old-generation heap plus bounded input buffers; 3-second worker deadline; batches of 32 passages; and 5,000 indexed eligible passages. The file hash is verified on each load. The worker evaluates only Workstack's constant program; model content is parsed as JSON data. Invalid or changed models, busy workers, cancelled work, and absent current vectors leave lexical search available. Projects larger than the semantic budget report truncation and retain their lexical index.

Indexing uses durable `semantic` jobs with per-source revision/model keys, leases, checkpoints after each batch, cancellation, backoff and retry. The desktop intake worker catches up on startup and every minute; selecting a model, rebuilding, or retrying also starts background processing. Source edits and model changes cannot reuse incompatible vectors. Settings show the model hash, indexed/eligible passage counts and job errors, and provide rebuild, cancel, retry and disable controls. Multiple processes share durable job leases; the memory and worker bounds apply to each process.

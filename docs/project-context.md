# Project context for each task

Workstack saves an immutable context packet for every successful Copilot launch, restart and MCP claim. A packet identifies the approved task revision, Git/workspace revision, policy, source revisions, decisions, attachments and prior checkpoint. The desktop preview and MCP read the same saved content. A later change creates a new packet; it does not rewrite earlier launch evidence.

Readiness checks the project's configured requirements. It cannot prove that no relevant knowledge exists elsewhere. The default policy requires the task and reports missing optional categories; required attachments and unfinished prerequisites always block execution. Copilot also requires a complete Git revision. An offline directory project can still use manual tasks and MCP claims unless its policy requires Git evidence.

## Build the project knowledge

Use the project's Knowledge view to import selected repository files or GitHub files, issues and pull requests. Intake records selection, progress, limits and failures. Original sources and normalized revisions remain available; passage citations identify the exact revision, heading, lines and character span.

Choose each source's refresh policy deliberately: import once, track content, metadata only, or paused. Tracked sources can become overdue, changed, unavailable or deleted. Metadata checks do not silently replace content with a different revision. Context that uses changed evidence is invalidated and must be rebuilt.

Keep governing decisions, requirements and risks as typed records, with lifecycle, rationale and supporting references. Review findings before using a proposed or superseded decision as guidance. Components and glossary entries provide stable names, approved aliases and exact source mentions; ambiguous aliases remain visible choices.

Generated wiki changes enter a review queue. Review the evidence and proposed revision before publishing. Publication updates the complete revision and retrieval projection together; history and restore retain the original evidence. Agent feedback likewise begins as a proposal and cannot automatically become accepted knowledge.

## Inspect readiness before execution

In project context settings, choose required categories, mandatory source pins, required records and a budget. On a task, pin additional sources or exclude unsuitable evidence, then rebuild the preview. Required categories include task, repository, purpose, architecture, conventions, decisions, affected code/tests, related work, attachments and checkpoint.

Each section shows included, missing or not-applicable evidence. An explicitly required category is not satisfied by an automatic not-applicable state. Needs attention and Building include source-specific repair actions. Resolve hard gaps before launch. A soft gap can be overridden only when the project permits it and the operator records a reason; the reason is saved in the worker's packet.

Preview approval applies to that exact snapshot. Task, repository, source, decision, scope or policy changes cause revalidation to fail before execution. Rebuild and inspect a new packet. Launch ownership is checked separately so an already claimed or completed task cannot be started as new work. Restart preserves the existing worktree and uses the latest checkpoint.

## Read the packet through MCP

These are tool names and argument objects, not shell commands. Use the real project, task and returned packet IDs.

```text
workstack_preview_context_packet
{"project":"Example project","work_item_id":"EX-1"}

workstack_get_context_packet
{"project":"Example project","packet_id":"<returned packet ID>"}

workstack_read_context_section
{"project":"Example project","packet_id":"<returned packet ID>","category":"task","offset":0,"limit":12000}

workstack_list_context_packets
{"project":"Example project","work_item_id":"EX-1"}
```

The packet response contains section metadata, the launch excerpt, policy, gaps, manifest and stable full-read locators. Read **every required section** until its `nextOffset` is null. Source revision reads use `workstack_read_source_revision` with `source_id`, `revision_id`, `representation: "normalized"`, `offset` and `limit`; continue until the returned total character count is reached. `workstack_read_source_citation` opens a precise passage and neighboring evidence. `workstack_read_context_artifact` accepts the packet ID and `artifact_id`, and returns saved bytes as bounded base64 chunks with `nextOffset`, byte count and SHA-256.

Use the inspected `context_packet_id` in `workstack_claim_work_item`. A successful claim returns that packet ID and records a usage receipt. If the agent was started by Workstack, use the packet ID supplied in the launch instructions. Save checkpoints and complete using the [agent workflow](agent-setup.md#complete-createclaimcomplete-example).

The inline prompt has a conservative UTF-8 byte budget. Long task text, specifications and attachments remain accessible through saved full reads; omissions are listed with their locators. Common sensitive values are redacted from prepared text and identified as gaps. Operator policy is separate from untrusted evidence, which cannot grant permissions or change the execution profile.

## Improve context over time

Use the task's feedback panel or `workstack_report_context_feedback` to report missing, stale, misleading or irrelevant evidence against a packet. Reports preserve the task, source revisions and author. Maintainers can triage a report toward an evaluation fixture, a reviewed knowledge correction or no change; every transition records its explanation.

Lexical retrieval works offline. Optional semantic retrieval requires an explicitly chosen local model pack and reports fallback, indexing progress and limits. No model is downloaded automatically. The [evaluation guide](quality/context-evaluation.md) describes the synthetic corpus, deterministic gates and optional model experiments. The initial expected evidence remains pending maintainer review; its passing scores do not certify real-world agent performance.

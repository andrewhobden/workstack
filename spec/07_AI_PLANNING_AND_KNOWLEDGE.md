# AI Planning and Knowledge System

## 1. LLM-wiki model

Workstack uses an LLM-wiki pattern with two conceptual layers:

### Raw/source layer
Immutable or source-of-truth evidence such as:
- project documents;
- user-added files;
- design notes;
- completed-work records;
- imported Markdown/text;
- selected project/repository documentation.

### Maintained wiki layer
AI-maintained Markdown pages that synthesize durable project knowledge.

Suggested files:
```text
knowledge/
├── schema.md
├── index.md
├── log.md
├── wiki/
│   ├── architecture.md
│   ├── data-model.md
│   ├── user-experience.md
│   ├── mcp-server.md
│   └── ...
└── raw/
```

`index.md` describes how to navigate the knowledge base.
`log.md` records meaningful knowledge changes/decisions, not low-level application telemetry.
`schema.md` instructs the wiki maintainer what kinds of durable knowledge to preserve.

## 2. Knowledge principles

- Keep raw evidence available; do not replace it with only AI summaries.
- Prefer incremental wiki updates over regenerating the entire wiki.
- Do not add transient implementation noise as permanent architecture knowledge.
- Preserve contradictions/uncertainty rather than fabricating a resolution.
- Attach provenance where practical.
- User-authored manual edits are authoritative unless intentionally revised.

## 3. Knowledge search

Search should span:
- maintained wiki;
- completed work;
- backlog/work item text when appropriate.

For AI retrieval, select a small relevant set rather than dumping the entire project into context.

Each retrieved context item should internally retain:
- type;
- source identity;
- title;
- excerpt/content;
- relevance;
- last modified timestamp where useful.

## 4. Planning assistant role

The planning assistant's job is to turn an idea/problem into an implementation-ready work item while using existing project knowledge.

It should:
- identify relevant architecture and precedent;
- notice backlog overlap/duplicates;
- ask questions when a missing decision materially affects implementation;
- propose a scoped task;
- create testable acceptance criteria;
- avoid inventing project facts not present in knowledge/evidence;
- distinguish requirements from suggested implementation approach.

It should not:
- claim work;
- modify source code;
- silently create backlog items;
- silently modify user-edited proposal fields.

## 5. Planning context assembly

For each user message:
1. include concise project identity/description;
2. semantically retrieve relevant wiki content;
3. search completed work for related precedents;
4. search backlog for overlap/dependencies;
5. include current Work Item Proposal;
6. include planning attachments relevant to the discussion.

The UI's context inspector should display enough information to explain why the assistant made project-specific statements.

## 6. Work Item Proposal structure

Suggested structure:

```markdown
# <Title>

## Objective
Why the change is needed and the user/system outcome.

## Existing context
Relevant architecture, precedent or constraints already present in Workstack.

## Requirements
- Requirement 1
- Requirement 2

## Acceptance criteria
- [ ] Observable/testable outcome 1
- [ ] Observable/testable outcome 2

## Likely affected areas
Optional, based on known project architecture. Do not fabricate exact filenames.

## Related work
Links/IDs to relevant completed/backlog items.

## Notes / out of scope
Useful boundaries.
```

Store proposal fields structurally even if rendered as Markdown.

## 7. Protecting user edits

If the user manually edits a proposal field:
- mark that field as user-modified;
- future AI updates should preserve it by default;
- if the assistant believes it should change, present a suggested change rather than overwrite.

## 8. Completion ingestion

When a work item is completed:
1. completion record becomes a raw knowledge source;
2. determine which wiki topics may be affected;
3. update only relevant pages;
4. update `index.md` if navigation/topics changed;
5. append a concise semantic entry to `log.md` when the completion changes durable behavior/architecture;
6. mark the source indexed or failed.

## 9. Failure behavior

AI failure must never corrupt project/work state.

- Planning chat failure: keep conversation and proposal intact; allow retry.
- Knowledge indexing failure: keep raw source and completion; show failed/pending state; allow retry.
- Model unavailable: manual work-item creation and MCP work coordination must continue to function.

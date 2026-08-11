# Workstack — Implementation Pack

Workstack is a local-first development coordination tool for humans and coding agents. It combines:

- a native desktop application for defining and reviewing work;
- a persistent project knowledge base using an LLM-wiki pattern;
- a backlog and immutable work history;
- an AI planning experience grounded in the project;
- an MCP server through which coding agents can query context, claim work and record completion;
- concurrency controls that prevent two agents from accidentally implementing the same work item.

This pack is intended to be handed directly to a coding agent.

## Read order

1. `01_PRODUCT_SPEC.md` — product goals, scope and requirements.
2. `02_UX_DESIGN.md` — visual language and every V1 screen.
3. `03_INFORMATION_ARCHITECTURE_AND_FLOWS.md` — navigation and end-to-end workflows.
4. `04_TECHNICAL_ARCHITECTURE.md` — components, storage and runtime architecture.
5. `05_DATA_MODEL.md` — entities, SQLite model and filesystem layout.
6. `06_MCP_SERVER_SPEC.md` — agent-facing MCP contract.
7. `07_AI_PLANNING_AND_KNOWLEDGE.md` — planning chat and LLM-wiki behavior.
8. `08_AGENT_COORDINATION.md` — claims, leases, heartbeats and concurrency semantics.
9. `09_IMPLEMENTATION_PLAN.md` — suggested implementation sequence.
10. `10_ACCEPTANCE_TESTS.md` — product-level acceptance criteria.
11. `11_DECISIONS_NON_GOALS_AND_FUTURE.md` — explicit boundaries and deferred work.
12. `AGENT_BUILD_BRIEF.md` — concise execution brief for the implementing coding agent.

Machine-readable schemas are in `schemas/` and the UX reference board is in `assets/`.

## V1 implementation principles

- **Local first.** No cloud account or hosted backend is required.
- **Native macOS UX.** Prefer SwiftUI and platform conventions for V1.
- **One authoritative state model.** The app and MCP interface must observe the same SQLite/project state.
- **Human-readable durable knowledge.** Knowledge and work-item artifacts live as Markdown/files; operational state lives in SQLite.
- **Agent-safe concurrency.** Claiming a work item must be atomic and lease-based.
- **Small workflow.** Do not recreate Jira. V1 has Backlog, In Progress and Completed.
- **Knowledge compounds.** Completion records feed back into project knowledge.

## Reference asset

`assets/workstack-ux-design-board.png` is the visual reference for the light, minimal, macOS-oriented design language.

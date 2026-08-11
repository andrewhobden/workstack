# Workstack — Coding Agent Build Brief

You are implementing **Workstack**, a local-first macOS development coordination application plus MCP server.

## Product in one sentence

Workstack is a persistent project brain plus an agent-safe backlog: humans decide and plan what should be built; coding agents query project context, atomically claim tasks, implement them, and record completion.

## What to optimize for

1. Correct work-item state and claim concurrency.
2. Durable local data.
3. A clean native macOS experience.
4. Stable MCP interfaces.
5. Searchable project knowledge.
6. Project-aware AI planning.

## Required end-to-end scenario

The implementation is not considered useful until this flow works:

1. User creates a project.
2. User creates or AI-plans a Feature.
3. Feature is added to Backlog.
4. MCP client lists and reads it.
5. MCP client atomically claims it and receives a claim token.
6. UI shows the active agent/lease.
7. MCP client heartbeats.
8. MCP client completes the item with implementation/validation details.
9. UI shows it in Completed.
10. Completion becomes searchable project context / a knowledge source.

## Hard invariants

- Never let two agents own one item at once.
- Never implement claiming with check-then-set outside a transaction.
- Never expose a claim token to non-owner listing/query responses.
- Old/expired/released claim tokens can never regain ownership.
- AI failure cannot break manual backlog/MCP functionality.
- Completing an item is independent from whether later knowledge maintenance succeeds.
- Attachments are copied into controlled project storage; do not rely on external absolute paths.
- The UI and MCP server share one authoritative project state.

## Recommended delivery strategy

Implement in the sequence from `09_IMPLEMENTATION_PLAN.md`. Build/test core state transitions before wiring rich UI and AI.

Before changing product scope, check `01_PRODUCT_SPEC.md` and `11_DECISIONS_NON_GOALS_AND_FUTURE.md`.

Use `assets/workstack-ux-design-board.png` and `02_UX_DESIGN.md` as the visual/interaction reference.

# Workstack requirements-to-test matrix

| Specification scope | Automated owner | Current status |
| --- | --- | --- |
| Technical architecture: native app shell, shared state boundary, migrations | `tests/core/project-store.test.ts`, `tests/e2e/app.spec.ts`, `npm run package:mac`, `npm run package:mac:notarize`, and `spctl` | Implemented — the Developer ID-signed, notarized macOS application is accepted by Gatekeeper. |
| Acceptance A: project management | `tests/core/project-store.test.ts`, `tests/core/project-registry.test.ts`, `tests/core/projects-service.test.ts`, `tests/e2e/projects-and-work-items.spec.ts` | Implemented |
| Acceptance B: work items | `tests/core/work-items.test.ts`, `tests/core/projects-service.test.ts`, `tests/e2e/projects-and-work-items.spec.ts` | Implemented |
| Acceptance C: attachments | `tests/core/artifact-store.test.ts`, `tests/core/projects-service.test.ts`, `tests/contracts/desktop-contracts.test.ts`, and `tests/e2e/artifacts.spec.ts` | Implemented |
| Acceptance D: agent coordination | `tests/core/claims.test.ts`, `tests/integration/claim-concurrency.test.ts`, `tests/core/projects-service.test.ts`, `tests/contracts/desktop-contracts.test.ts`, and `tests/e2e/claims.spec.ts` | Implemented — agent-owned MCP execution is tracked in Acceptance E. |
| Acceptance E: MCP | `tests/contracts/mcp-tools.test.ts`, `tests/core/claims.test.ts`, `tests/core/projects-service.test.ts`, `tests/e2e/completed-result.spec.ts`, and the notarized packaged Electron MCP handshake | Implemented — the signed, notarized Electron binary completed an actual stdio connection and listed all nine registered MCP tools. |
| Acceptance F: AI planning | `tests/core/planning.test.ts`, `tests/contracts/desktop-contracts.test.ts`, and `tests/e2e/planning.spec.ts` | In progress — durable proposal editing, manual-field protection, explicit `ai_plan` backlog conversion, reload persistence, and visual/a11y coverage are implemented; provider, Keychain, context inspection, and recovery remain pending. |
| Acceptance G: knowledge | `tests/core/knowledge.test.ts`, `tests/core/projects-service.test.ts`, `tests/contracts/mcp-tools.test.ts`, `tests/e2e/knowledge.spec.ts`, and `tests/e2e/wiki.spec.ts` | Implemented — raw sources, FTS retrieval, maintained wiki editing, and retry processing are covered. |
| Acceptance H: UX/accessibility | `tests/core/project-store.test.ts`, `tests/contracts/desktop-contracts.test.ts`, `tests/e2e/command-palette.spec.ts`, and `tests/e2e/release-polish.spec.ts` | Implemented — keyboard-led core actions, status semantics, clear empty states, durable operational settings, Escape recovery, and dark-mode contrast are covered. |

The full matrix is expanded as each behavior is implemented. New functionality cannot be marked complete without a row pointing to its unit/integration/contract evidence and, where it has a user surface, its Playwright interaction and visual test.

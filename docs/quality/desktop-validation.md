# Desktop and renderer validation

Browser tests use the deliberately enabled demo adapter from `vite.renderer.config.ts`. The production Electron renderer disables that adapter; a missing preload displays a startup diagnostic instead of creating browser-only state.

Playwright owns its preview server on `127.0.0.1:42817`. Set `WORKSTACK_TEST_PORT` for another isolated endpoint. The port is strict and existing servers are never reused. Global setup compares the served manifest and HTML marker with `dist/web/workstack-build.json`. An occupied-port or build-identity failure is an environment failure, not evidence of a feature defect. Tests never stop the process already using a port.

## Evidence layers

- `tests/main/desktop-bridge.test.ts` imports the actual preload and calls actual registered IPC handlers using only a mocked Electron transport. Project storage and SQLite are real and temporary. Seven tests cover strict patch mapping, reopen persistence, planning conversion, attachment and creation receipt replay, immutable planning context and cancellation, restart ownership failures, retained source citations, reviewed wiki publication, typed guidance and directory corrections, exact task context approvals, and feedback history. Cancellation also exercises the default real Bash runner after the provider has returned: the desktop stops the owned shell process group, retains partial evidence, audits skipped calls and releases the request without creating the later proposal. The context test verifies stale approval rejection, bounded section reads, original packet persistence after preferences change, and project isolation. The desktop forces feedback authorship to `human`.
- `tests/e2e/desktop-reliability.spec.ts` covers delayed/out-of-order project loads, live completion while editing, failed saves, repeated submission and partial attachment retry, dependency correction, completion delivery retry, cancellation of both planning and chat while retaining drafts and saved history, and full manual/generated Markdown readers with keyboard focus and return to search.
- `tests/e2e/knowledge-catalog.spec.ts` covers scoped source import previews, excluded files, source freshness and retry/cancel controls, retained originals and exact historical citations, and stale wiki proposals before successful publication.
- `tests/e2e/project-knowledge.spec.ts` covers structured knowledge findings, failed edits, explicit review and supersession, ambiguous component names, alias splitting and merging, and unified search opening the exact named record or directory identity. Search reports the actual retrieval mode and fallback reason.
- `tests/e2e/task-context.spec.ts` covers capability-check failures and hard requirements blocking launch, recorded soft overrides, stale launch recovery, full section pagination, historical packets that cannot approve execution, policy remediation, and feedback/triage recovery tied to packet and source revisions. A saved preferences update followed by a failed rebuild cannot reactivate the old packet. Reading an exact citation preserves unsaved source choices; discarding a later draft restores the last successfully saved preferences. These tests use explicit desktop API fixtures and never start a real agent.
- `tests/e2e/ai-provider-settings.spec.ts` verifies the browser demonstration reports that selecting a local semantic model requires the desktop app. The browser demonstration does not simulate a valid agent context packet; its launch UI stays disabled without one.
- `scripts/desktop-smoke.mjs` uses real Electron, its real preload and main process. It creates and edits through the UI, exercises planning and attachments through the bridge, builds and explicitly reviews context, reads exact source evidence, and records/triages feedback. After restarting the application it checks the exact packet text, both historical versions, full retained source revision, citation span and feedback audit. The same executable then serves MCP stdio initialization, tool discovery and the packet/section/history/source-revision/source-citation/artifact readers, which must agree with the desktop and retained attachment bytes. The smoke excludes inherited development-renderer URLs, requires a built `file:` renderer and captures MCP stderr.

Run the native smoke after building the current commit and rebuilding native dependencies for Electron:

```sh
npm run rebuild:native
WORKSTACK_SMOKE_OUTPUT=test-results/native-final-smoke npm run test:desktop
```

For a packaged artifact, set `WORKSTACK_SMOKE_EXECUTABLE` to the executable inside the built `.app` bundle. The script records the artifact hash and tests the same executable for the UI and MCP handshake. It uses a temporary `WORKSTACK_USER_DATA_DIR`, never the normal application registry. It does not launch an external agent or call a configured model provider. Operating-system security controls must remain enabled.

On Apple Silicon, the unsigned local package sequence is:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac -- --publish never
WORKSTACK_SMOKE_EXECUTABLE="$PWD/dist/mac-arm64/Workstack.app/Contents/MacOS/Workstack" WORKSTACK_SMOKE_OUTPUT=test-results/packaged-final-smoke node scripts/desktop-smoke.mjs
```

Native traces, logs, commit identity, dirty-worktree status, and artifact hash are saved under `test-results/desktop-smoke` (override with `WORKSTACK_SMOKE_OUTPUT`). A passing browser run is not a passing native or packaged run. Node unit tests and Electron require matching native module ABIs, so serialize native rebuilds with Node test execution.

## Final combined working-tree evidence

On September 9, the clean-install Node 22.23.2 gate passed 413 tests in 60 files, with 100% core coverage: 4,617 statements, 2,850 branches, 1,266 functions and 3,636 lines. The aggregate command also passed the separate 7 contract tests, 20 integration tests and 42 Chromium tests. The offline evaluator passed 54 case/stage results over 778 sources. These synthetic evaluation results retain their pending maintainer-review and semantic-quality limits described in `context-evaluation.md`.

After all Node checks stopped, SQLite was rebuilt for Electron 41.10.7. The current desktop and unsigned arm64 package built with electron-builder 26.15.3 and passed the expanded smoke on the same uncommitted source tree based on `5543694b951d7e7f5206b3c807abea32993d5ef0`:

| Artifact | Completed, Shanghai time | Result and evidence |
| --- | --- | --- |
| Built desktop, `out/main/index.js` | September 9, 12:11:16 | PASS; `test-results/native-final-smoke/result.json`, `initial.zip`, `restart.zip`, `desktop.log`, `runner.log` and `rebuild.log`. |
| Unsigned `dist/mac-arm64/Workstack.app`, `Contents/Resources/app.asar` | September 9, 12:12:02 | PASS; `test-results/packaged-final-smoke/result.json`, `initial.zip`, `restart.zip`, `desktop.log`, `runner.log` and `build.log`. |

SHA-256 values recorded by the runs and independently checked afterward:

```text
out/main/index.js
8bf0de19ad365a9d01c782b1ca47696101cdce02d40979ae5428503b6a52a52d
app.asar
6343eae46a9e18f2d172ce3d3e97aaae84992a03748a1f6c9fe7bd84a1fd565c
```

Both results record `passed: true`, `mcpContextVerified: true`, 35 MCP tools, two packet versions, one exact retained citation and two feedback audit events. The same executable preserves edited and converted tasks, attachment bytes, reviewed packet text, exact section text and the full source revision across a real application restart. Native and MCP citation readers agree with the cited offsets in that full revision. Initial/restarted native and packaged screenshot frames were inspected; the built UI loaded and the saved tasks appeared after restart. All owned Electron/MCP processes were confirmed stopped when native validation finished. The local SQLite module was then rebuilt for Node 22.23.2 (ABI 127), and a real database open verified SQLite 3.53.4; the workspace is left ready for Node checks.

The first two native attempts exposed a smoke assumption that a pinned source's full body must appear in its packet excerpt. The runtime correctly supplied a bounded passage and the immutable full-revision reader. The smoke was corrected to follow that reader and compare exact sections and citation spans; no runtime source change was needed. Those failed traces remain in `test-results/native-final-smoke-attempt1` and `-attempt2`, and an intermediate passing run is in `-attempt3`. Script syntax and ESLint passed before the final runs. Earlier native/package evidence from 10:29 describes a prior artifact and is separate from the hashes above.

This verifies the local macOS arm64 desktop and unsigned package. It does not establish signed/notarized distribution, live external agent/provider behavior or network source-import permissions. The recorded dirty-worktree identity is explicit; these are not results from a later clean source commit.

## Focused domain and provider evidence

On September 9 at 11:49, 70 tests passed across planning, artifacts, knowledge chat/history, Bash process lifecycle, actual desktop bridge and provider contracts. Planning, artifacts and chat reached 100% statements (605), branches (372), functions (141) and lines (491), with coverage thresholds unchanged. Cases exercise rollback/retry, attachment identity and hash checks, stale retrieval snapshots, bounded images/history/source searches, pending/failed audit records, transcript replay, renewable ownership and inspection defaults. Legacy orphan tool evidence remains labeled reference data without rewriting saved audit. A 150-message history fixture preserves complete native tool groups, unresolved outcomes and citation pointers within the request budget; oversized required context fails before provider calls and remains saved.

Harmless commands verify the real Bash working directory and cancellation of a shell waiting on its child. Controlled process fixtures cover timeout/error paths and TERM-to-KILL escalation. Cancellation between provider calls cannot execute later requested tools. All three provider formats receive the inspected draft, conversation and actual image bytes. Credential tests cover old saved-key association, URL/path/mode changes, explicit removal, redirect rejection and public-settings redaction; cancellation during rate-limit backoff prevents a later network attempt. Transport fixtures do not send live credentials. Persistence tests separately verify the exact old default prompt upgrades while a customized legacy-derived prompt stays byte-for-byte intact in authoritative SQLite reads and the JSON export.

At 11:35, the converted-plan integration passed through the actual service and reopened MCP handoff, including all rich fields and an attachment whose original planning association was removed. The latest full Chromium run passed 42 tests, including both cancellation journeys and the packet ownership fixture. The later combined gate and native/package evidence above supersede this focused snapshot without conflating their different boundaries.

## September 2026 visual baseline review

The full isolated Chromium suite passed 42 tests, including visual and accessibility checks, on September 9. Intended baseline changes were inspected individually: source catalog/wiki review and structured-knowledge controls, unified search near the top of Knowledge, collapsed task dependencies and context inspection, provider key removal, local semantic settings and context requirements, and visible dialog focus. The deletion screenshot changed only because the settings behind the dialog grew. Screenshot tolerances were unchanged.

Additional screenshots from the source intake/citation, record review/directory correction, context policy, reviewed context, and dark feedback journeys were inspected. Long dialogs scroll vertically, their form controls remain reachable, and source evidence wraps without horizontal overflow. The new dark-context accessibility journey exposed and fixed insufficient Backlog row/header contrast. Reader navigation retains the task prompt and source-choice draft, while policy/source remediation rebuilds context before execution.

Browser and mocked-transport bridge evidence does not establish packaged Electron behavior, live GitHub import permissions, production model quality, or external agent success. The separately recorded native/package runs establish the local artifact behavior described above. Rerun them after runtime or build changes, with native ABI rebuilds serialized against Node checks. No live provider, external agent, or network source import is invoked by these UI/bridge checks.

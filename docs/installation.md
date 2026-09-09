# Installation and contributor checks

## Supported environment

The desktop target is macOS 14 or later. Node 22.12.0 or later is required; the repository's CI baseline is Node 22. Local development has also been exercised with Node 24.6.0 and npm 11.5.2; that is additional evidence, not a replacement for the CI baseline. The lockfile is the dependency source of truth.

The checked-in `.npmrc` and lockfile use the public npm registry, with package integrity hashes retained. No organization account or private feed is required. Networks that require an approved npm mirror can pass `--registry=<approved-mirror>` locally. Keep credentials out of project configuration and retain public package URLs in committed lockfiles. Dependabot proposes updates for review; CI reports dependency advisories and fails on high or critical findings. Major toolchain upgrades require checking Electron, native SQLite, build, test, and package compatibility together.

Install Git, Node/npm, Python 3, and the Xcode command-line tools needed to compile native dependencies. Obtain tools from their official distributions. Workstack's build dependencies include Electron and `better-sqlite3`; installation scripts download/build native code, so review the checkout and dependency changes before running them.

Copilot launching is optional. It additionally needs `git`, `gh`, and `copilot` on the environment used by Terminal, GitHub access, and an authenticated Copilot account. Manual task management and MCP coordination do not require configuring an AI provider. Planning, knowledge chat, and generated knowledge require an appropriate provider configuration.

## Clean checkout and desktop development

```sh
git clone https://github.com/andrewhobden/workstack.git
cd workstack
npm ci
npm run dev
```

The `postinstall` script runs `electron-rebuild -f -w better-sqlite3`; this prepares SQLite for Electron's Node ABI. `npm run dev` builds and starts the Electron application through `electron-vite`. `npm run build` produces the desktop bundles in `out/`.

For disposable development, set `WORKSTACK_USER_DATA_DIR` to a private absolute directory when starting the app. Use the same value for its MCP client if they should share a registry. Do not point experiments at your production profile. Do not set `ELECTRON_RUN_AS_NODE` when starting the desktop or MCP entry point: Workstack needs Electron's application lifecycle.

`npm run web:dev` and `npm run web:build` use the explicitly labeled browser demo. Its state is browser-local and its backend behavior is simulated. A packaged desktop with a missing preload bridge stops with an error; the demo is not a fallback for broken desktop installation.

## Run the checks

Close the desktop and its MCP processes first. Node-based Vitest and the desktop use different native SQLite ABIs; switch the build for the process you are about to run:

```sh
npm rebuild better-sqlite3 --build-from-source
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm test
```

The aggregate script runs lint, TypeScript checking, unit coverage, MCP contracts, process integration tests, and the Chromium renderer suite. Core coverage thresholds remain 100%. Tests use temporary projects and mocked external providers/agents. Browser tests use an isolated server and verify the Workstack build identity.

Individual commands from `package.json` are useful while developing:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Static lint checks |
| `npm run typecheck` | TypeScript boundary checking |
| `npm run test:unit` | Vitest suite and required core coverage |
| `npm run test:contract` | MCP contract tests |
| `npm run test:integration` | SQLite/process integration tests |
| `npm run test:e2e` | Build and test the Chromium renderer harness |
| `npm run test:visual` | Visual subset of the renderer tests |
| `npm run test:accessibility` | Accessibility subset |
| `npm run test:desktop` | Build and smoke-test the real Electron UI, persistence, and MCP entry point; requires the Electron native rebuild |

Restore the Electron build before desktop development or packaging:

```sh
npm run rebuild:native
npm run build
npm run dev
```

Do not run Node and Electron tests concurrently while rebuilding their shared native dependency. A passing browser suite cannot establish native dialogs, preload/IPC behavior, packaged MCP startup, Terminal integration, or operating-system signing.

## Packaging and release validation

```sh
npm run rebuild:native
npm run package:mac
```

This builds a macOS application directory with `electron-builder`; it does not itself prove a distributable release. Current notarization scripting expects an arm64 application at `dist/mac-arm64/Workstack.app` and a preconfigured `workstack-notary` keychain profile. Signing credentials and Apple access must be configured by the release owner before `npm run package:mac:notarize` can succeed. Do not publish an unsigned or unverified application as a validated release.

Read the [validation environment](quality/test-environment.md), [dependency maintenance policy](quality/dependency-audit.md), and [acceptance ledger](quality/implementation-ledger.md) for current results. If macOS blocks or quarantines Electron, use an approved distribution and investigate its provenance; do not remove quarantine attributes or disable Gatekeeper to make tests pass. Mocked launch tests never start a real coding agent.

## Common failures

| Symptom | Action |
| --- | --- |
| `NODE_MODULE_VERSION`, `dlopen`, or native SQLite mismatch | Stop desktop/MCP/tests. Rebuild for the intended host: `npm rebuild better-sqlite3 --build-from-source` for Node tests; `npm run rebuild:native` for Electron. Keep Node and dependency versions consistent. |
| Native build cannot find Python/compiler | Install Python 3 and the platform build tools, then rerun the appropriate rebuild. |
| Electron missing or blocked by macOS | Verify installation and OS trust status; obtain an approved Electron build. See release limitations above. |
| Playwright executable missing | Install Chromium with `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`, matching the test scripts' browser location. |
| Browser test port occupied/build identity mismatch | Stop the unrelated service or configure the test endpoint as documented in `tests/support/test-server.ts`. Tests intentionally refuse to reuse an arbitrary server. |
| Desktop bridge unavailable | Rebuild/reinstall the current desktop bundle and preload. The browser demo is separate and does not repair desktop data access. |
| `gh` or `copilot` not found | Install the missing CLI, confirm it is on Terminal's PATH, and check `gh --version` / `copilot --version`. Authenticate using their official login flows. |
| Provider authentication, timeout, or rate-limit error | Check the selected endpoint, API mode, model, and credential association. Re-enter credentials when changing provider origin/base path/API mode. Inspect the surfaced error; retry transient errors after the indicated limit/reset. |
| Project missing, detached, or pending deletion | Retain its files, use Reconnect for a moved project, and follow [recovery](recovery.md). Do not clear the lifecycle sidecar while writers exist. |

The commands here were checked against the repository scripts. Focused repository, MCP, and launcher tests validate the documented lifecycle using temporary fixtures; they do not establish live provider access, Copilot execution, or signed-release readiness.

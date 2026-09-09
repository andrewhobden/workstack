# Workstack

Workstack is a local desktop application for coordinating development tasks with coding agents. It stores a project's backlog, claim leases, progress checkpoints, completion evidence, attachments, and knowledge in the project directory. Agents use its local MCP server to retrieve context and claim work; the desktop manages planning, review, and recovery.

The application uses Electron, React, TypeScript, and SQLite. The documents under [`spec/`](spec/README.md) describe the original design and future intentions; they are not a release certification. See the guides below for current behavior.

## Start here

- [Install, develop, test, and troubleshoot](docs/installation.md)
- [Configure a project, connect MCP, and run an agent workflow](docs/agent-setup.md)
- [Build, inspect, and maintain task context](docs/project-context.md)
- [Restore a deletion backup](docs/recovery.md)
- [Current validation environment and release limitations](docs/quality/test-environment.md)
- [Review implementation and acceptance ledger](docs/quality/implementation-ledger.md)

The desktop target is macOS 14 or later. Copilot terminal launching requires macOS, Git, GitHub CLI, and an authenticated GitHub Copilot CLI. Browser development is a labeled demo/test harness; it does not access the desktop's project database or prove desktop behavior.

## Development quick start

Use Node 22.12.0 or later (Node 22 is the CI baseline), with npm and the macOS command-line build tools installed:

```sh
git clone https://github.com/andrewhobden/workstack.git
cd workstack
npm ci
npm run dev
```

`npm ci` builds the native SQLite module for Electron. Node-based tests need a different native build. Stop the desktop before switching:

```sh
npm rebuild better-sqlite3 --build-from-source
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm test
npm run rebuild:native
```

See [installation](docs/installation.md) for packaging, isolated profiles, native module troubleshooting, and the checks still required before a desktop release.

## Execution and project data

A work item is claimed by one active owner at a time. Agents must heartbeat before the lease expires, save checkpoints during work, and submit completion evidence. A completion with a pull-request URL is **awaiting review** until merge. Closing that PR without merge makes the task recoverable; prior submissions remain available when a replacement attempt begins.

New Copilot task branches and worktrees use an immutable task identity. Renaming a task preserves its workspace. Relaunch resumes existing work, and restack refuses to discard tracked or untracked changes.

Each launch, restart, and claim records an immutable project-context packet. The packet combines the approved task, source revisions, decisions, related work, attachments and checkpoints. Project policies make missing mandatory evidence actionable before execution. The desktop and MCP expose the same saved packet, full evidence reads and history. See [project context](docs/project-context.md) for source intake, review and readiness.

Project inspection is the default execution profile. Workstack currently refuses restricted external Copilot profiles because its adapter cannot verify all requested filesystem, network, and process boundaries. The explicitly selected **Advanced** profile grants the external agent broad access through your user account. A worktree is an organizational boundary, not a security sandbox. Knowledge chat inspection provides enforced purpose-built project reads. See the [capability details](docs/agent-setup.md#execution-profiles) before enabling broader execution.

Project state lives in `.workstack/`, with lifecycle coordination in `.workstack-lifecycle.sqlite` beside it. Register only trusted project roots and connect only trusted local MCP clients. Back up the complete project data and follow the [recovery guide](docs/recovery.md); do not edit the database or delete coordination files while Workstack or its agents are running.

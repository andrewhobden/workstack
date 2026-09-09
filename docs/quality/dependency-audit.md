# Dependency maintenance

The 2026-09-09 baseline lockfile reported 27 npm advisories: 3 critical, 18 high, and 6 moderate. The refreshed lockfile reports **zero advisories** across 606 dependency entries. No advisory exceptions are currently required. Audit results describe the advisory database at the time of the check; CI repeats the check for proposed changes.

## Compatible stable toolchain

| Package | Previous locked version | Updated locked version |
| --- | --- | --- |
| Electron | 40.10.6 | 41.10.7 |
| electron-builder | 25.1.8 | 26.15.3 |
| @electron/rebuild | 3.7.2 | 4.2.0 |
| electron-vite | 2.3.0 | 3.1.0 |
| Vite | 5.4.21 | 6.4.3 |
| Vitest and coverage-v8 | 2.1.9 | 4.1.11 |

The update retains the Vite 6 peer compatibility supported by electron-vite 3 and the existing React Vite plugin. Electron and electron-rebuild require Node 22.12.0 or later. Semver-compatible runtime and transitive dependencies were refreshed, including MCP SDK 1.30.0 and better-sqlite3 13.0.3. No `npm audit fix --force`, direct prerelease upgrades, or artificial direct dependencies on transitive packages were used.

## Exposure assessment

Electron is declared as a development dependency but supplies the shipped desktop runtime, so its advisories are treated as application exposure. The MCP SDK's HTTP-related dependency chains are runtime dependencies even though Workstack's current MCP entry point uses local stdio. The builder, native rebuild, Vite, and Vitest chains affect development, build, and validation environments. All reported findings in these categories were removed by compatible upgrades; no finding was waived solely because its package was marked `dev`.

## Registry and update policy

The project `.npmrc` and every tarball URL in `package-lock.json` use `https://registry.npmjs.org/`. Integrity hashes remain part of the lockfile. Contributors do not need an organization-specific package feed or credentials. An approved network mirror can be supplied with `--registry` when required by the local environment; credentials belong in local tooling, never in the repository.

During this validation, direct public npm connections were unavailable. Package metadata, downloads, and audit requests used the existing user-configured npm mirror, while committed tarball URLs were normalized to public npm. The initial in-place resolution encountered an npm dependency-tree error; a clean temporary manifest resolution produced the final lockfile. The clean application install uses that final lockfile.

Dependabot proposes weekly npm and GitHub Actions updates. Related Electron and Vite/Vitest packages are grouped, and no automation merges upgrades. The separate CI dependency-audit job reports all findings and fails on high or critical advisories. Major upgrades require review of native, renderer, MCP, and packaging checks together.

## Validation boundaries

Final clean-install validation also passed on the CI baseline runtime, Node 22.23.2, on 2026-09-09. The complete `npm test` command passed lint/typecheck, 413 non-browser tests with 100% core coverage, separate contract and integration stages, and all 42 Chromium journeys. SQLite 3.53.4 opened under ABI 127 after the Node rebuild. The configured mirror reported zero advisories for the locked dependency graph; the direct public audit attempt failed with a network error. These current implementation results supersede the smaller focused Node test counts below. Current native/package evidence is recorded in [desktop validation](desktop-validation.md).

Local upgrade validation on macOS 26.6.2 arm64, Node 24.6.0, and npm 11.5.2 passed a clean install, full lint/typecheck, the Electron production build, and 51 focused workflow/MCP/launcher tests. Claims, work items, and execution profiles retained 100% statements, branches, functions, and lines coverage under Vitest 4.1.11. Matching Playwright 1.63.0 Chromium binaries installed successfully.

The real Electron smoke and unsigned packaged smoke both passed on 2026-09-09, including editing, restart persistence, attachments, planning conversion, and an MCP initialization listing 18 tools. The tested desktop `out/main/index.js` SHA-256 is `811ff58592471a85a0c056b8ae88bfa8d9959d9d7f8c54f50c84b10fa5404aa0`; the packaged `app.asar` SHA-256 is `97b7fdfbab90af09eaad0b5bc21cd0d030031c61b42535bf51761c07744fd9eb`. These are upgrade-compatibility checks of the artifact built at 10:29 local time during active implementation, not certification of subsequent source edits. Final acceptance must rebuild and retest the complete source state. SQLite was rebuilt for Node and verified afterward.

The CI workflow uses Node 22 on macOS 14. It installs the lockfile, rebuilds SQLite for Node checks, runs the repository suite, rebuilds SQLite for Electron, tests the real desktop, then builds and smoke-tests an unsigned local application directory. The packaged smoke checks both UI persistence and a real MCP stdio initialization. Logs, traces, commit identity, and artifact hashes are retained as CI artifacts.

Unsigned local package validation does not establish signing, notarization, distribution, or live Copilot/provider execution. See [desktop validation](desktop-validation.md) and the [implementation ledger](implementation-ledger.md) for observed local results and remaining release checks.

# Desktop validation environment

The production target is Electron on macOS 14 or later. Node 22 is the CI baseline; local validation also uses Node 24. Tests run against temporary projects and isolated application profiles. Browser tests use a separately identified local server and do not substitute for the native application.

An earlier implementation environment lost its Electron binary after a macOS quarantine action. That historical limitation does not describe the later Electron 41.10.7 upgrade: native UI, persistence and unsigned packaged MCP smoke tests subsequently passed. Workstack does not remove quarantine attributes or disable operating-system protections. See [desktop validation](desktop-validation.md), [dependency audit](dependency-audit.md) and the [acceptance ledger](implementation-ledger.md) for artifact-specific evidence and the latest combined checks.

Node and Electron require different native SQLite builds. Serialize their rebuild and test windows as documented in [installation](../installation.md). Signed/notarized distribution, live Copilot sessions and live provider behavior require separate release evidence; local fixture and unsigned package results do not certify them.

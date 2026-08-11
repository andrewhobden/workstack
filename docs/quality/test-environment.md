# Desktop validation environment

The production target remains Electron on macOS 14+. During local implementation, macOS quarantined the downloaded Electron binary as malware and removed `Electron.app`. Workstack does not remove quarantine attributes, disable Gatekeeper, or otherwise bypass operating-system security controls.

Until an approved/notarized Electron distribution is supplied, Playwright validates the same production React renderer through the Vite browser harness. Core, IPC, MCP, and packaging code remain Electron-oriented. Direct Electron launch, packaged-app smoke testing, and notarization are release-blocking checks that must be rerun on an approved macOS environment before a desktop release.

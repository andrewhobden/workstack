# Recovering and relocating projects

## Reconnect a moved project

Close Workstack, its MCP processes and managed agents before moving a project. Move the repository together with `.workstack` and `.workstack-lifecycle.sqlite`, then choose **Reconnect** for the unavailable project and select its new project folder. Reconnect verifies the original project identity. A copy whose original project folder still exists is not treated as a move.

Task workspaces can stay in their existing sibling folders, or move with the repository while preserving their relative layout. Reconnect validates each saved task branch against Git's worktree registrations, repairs the retained worktrees' Git administrative links, and updates the task workspace mappings before committing the new project root. Tracked edits, untracked files and branch identities are preserved. Context preview, new launch and restart use the reconnected paths; older context packets retain the exact paths and evidence captured for their original launches.

An interrupted mapping write can be retried with **Reconnect**. If a retained workspace is missing, belongs to another repository or has conflicting Git registrations, the error identifies the location that needs repair. Restore that workspace or correct its saved mapping and Git registration before reconnecting again. Reconnect does not infer ownership from a matching task title.

## Recover a deletion backup

Project deletion puts a durable barrier in `.workstack-lifecycle.sqlite` at the repository root. It drains admitted operations across desktop and MCP processes, refuses deletion while agents hold active claims, snapshots SQLite with its backup API, copies project artifacts, checks database integrity and foreign keys, and verifies attachment checksums. A deletion manifest records the size and SHA-256 of every backed-up file. Symlinked artifacts are rejected because a deletion backup must contain its own data.

The lifecycle sidecar is intentionally outside `.workstack`; keep it with the repository when moving the project. A crash during preparation can be recovered automatically once its owner is gone. A crash during removal keeps the project blocked and reports the recovery backup path. Locks are never stolen based on age. PID reuse may conservatively keep a stale owner blocked; stop the identified process or recover after a restart rather than deleting the coordination file while writers may still exist.

Run the following from a Workstack checkout with dependencies installed and a Node-compatible `better-sqlite3` build. Use the absolute backup path returned by deletion. These commands have integration tests using temporary projects.

```sh
node scripts/restore-project.mjs --verify-backup '/absolute/backup/.workstack'
```

Verification is read-only with respect to project data. It checks the complete file manifest, SQLite integrity and foreign keys, project identity and root agreement, and every referenced attachment. It rejects backups without the new manifest; retain older backups and recover them through a separately validated manual process.

Before restoring, close Workstack and stop its MCP processes and managed agents. Keep the original repository root; create that directory if it was removed. The command requires the root recorded in the backup. To relocate the project, first restore here and then move the repository and use **Reconnect** in Workstack.

If `.workstack` still exists after a partial removal, preserve it before restoring. Choose a quarantine name that does not already exist:

```sh
mv '/absolute/project/.workstack' '/absolute/project/.workstack-recovery-quarantine-20260909'
node scripts/restore-project.mjs --restore '/absolute/project' '/absolute/backup/.workstack'
```

The restore command rejects live operation or lifecycle owners and never overwrites existing project data. It copies into a temporary directory, verifies the copy, publishes it by rename, and clears the durable deletion barrier only after validation. A failed restore leaves the backup untouched and the barrier active. The quarantine may contain additional forensic evidence; retain it until the restored project has been checked.

Reopen Workstack. A failed deletion generally retains its registration; a completed deletion removes it, so add the existing project folder again to restore its registration. Confirm the project identity, tasks, attachments and knowledge. The deletion backup remains available after a successful restore.

If restoration is interrupted after publishing `.workstack` but before the barrier clears, verify the backup again, move that published directory to a new quarantine location, and rerun restoration. Do not clear the sidecar manually while any process may still have the project open.

# Decisions, Non-Goals and Future Extensions

## 1. Explicit V1 decisions

### Local-first
V1 does not require a Workstack cloud service.

### Native macOS first
Deliver the macOS experience first. Keep domain/data contracts portable so other clients can be added later.

### SQLite + files
SQLite owns mutable workflow/coordination state; Markdown/files preserve human-readable knowledge and artifacts.

### One WorkItem entity
Backlog and completed work are filtered views of one lifecycle, not separate databases.

### Lease-based claims
A crashed coding agent cannot permanently lock a task.

### Completed work is context
Completion records are searchable and feed the knowledge system.

### List-first backlog
Default is a dense list/table rather than Kanban.

## 2. V1 non-goals

Do not add unless implementation exposes a critical need:
- Jira-style epics;
- sprints;
- story points;
- roadmaps;
- milestones/releases;
- complex dependency graphs;
- team/organization permissions;
- cloud sync;
- multi-user collaboration;
- notifications service;
- full Git hosting integration;
- CI/CD orchestration;
- agent terminal/session mirroring;
- automated task decomposition into many child issues;
- component/path locking between different work items;
- autonomous selection/execution without external coding-agent control.

## 3. Future opportunities

### Cross-platform clients
Windows/Linux desktop clients can use the same project format and MCP contract.

### Remote/shared Workstack Core
Introduce a hosted/team project store when multi-user coordination becomes necessary.

### Repository-aware knowledge ingestion
Index selected code/documentation areas, symbol information or architecture maps.

### Dependency graph
Allow explicit `blocks`, `blocked_by` and `related_to` relationships.

### Conflict prediction
Use likely affected paths/components to warn when different active work items overlap.

### Worktrees
Create/track one Git worktree per claimed task.

### Agent scheduling
A higher-level scheduler could assign tasks to agents using priority, dependencies and capability.

### Review state
If needed, introduce a post-implementation Review state. Do not preemptively add it to V1.

### Remote planning providers and local models
Provider abstraction should permit both hosted and local AI models.

# Information Architecture and Core Flows

## 1. Navigation hierarchy

```text
Workstack
├── Projects/Home
└── Project
    ├── Overview
    ├── Backlog
    ├── In Progress
    ├── Completed
    ├── Knowledge
    │   ├── Articles
    │   └── Sources
    ├── Activity
    └── Project Settings
```

Transient surfaces:
- Create Project sheet
- New Work Item sheet
- Work Item detail window/page
- Plan with AI workspace
- Agent Detail sheet
- Attachment preview
- Global command palette
- Application Settings

## 2. Manual work-item creation flow

```mermaid
flowchart LR
    A[Backlog] --> B[New Work Item]
    B --> C[Enter title/type/description]
    C --> D[Add acceptance criteria]
    D --> E[Paste or attach artifacts]
    E --> F[Add to Backlog]
    F --> G[Backlog item created]
```

Validation:
- title required;
- project required;
- description may be short but should not be silently generated unless requested;
- attachments are persisted before transaction finalization or cleaned up if creation is cancelled.

## 3. AI planning flow

```mermaid
flowchart TD
    A[Plan with AI] --> B[Initial user idea]
    B --> C[Retrieve relevant project context]
    C --> D[AI discussion]
    D --> E[Update Work Item Proposal]
    E --> F{User satisfied?}
    F -- No --> D
    F -- Edit directly --> E
    F -- Yes --> G[Add to Backlog]
```

The planner may use:
- knowledge search results;
- completed work;
- current backlog;
- project metadata;
- attachments supplied during planning.

The planner must not create or mutate code.

## 4. Agent execution flow

```mermaid
sequenceDiagram
    participant A as Coding Agent
    participant M as Workstack MCP
    participant DB as Workstack State

    A->>M: list_backlog(project)
    M-->>A: candidate items
    A->>M: get_work_item(item)
    M-->>A: task + artifacts
    A->>M: claim_work_item(item, agent/session)
    M->>DB: atomic claim
    alt claim successful
        DB-->>M: claim token + lease
        M-->>A: success
        loop while working
            A->>M: heartbeat_work_item(item, token)
            M-->>A: renewed lease
        end
        A->>M: complete_work_item(item, token, completion)
        M->>DB: transition to Completed
        M-->>A: completion accepted
    else already claimed
        DB-->>M: no row updated
        M-->>A: conflict / claim failed
    end
```

## 5. Lease expiry flow

```mermaid
flowchart LR
    A[In Progress] --> B{Lease valid?}
    B -- Yes --> A
    B -- No --> C[Mark claim expired]
    C --> D[Return item to Backlog]
    D --> E[Write activity event]
```

Expiry processing may occur lazily during API queries plus a periodic local cleanup task. Correctness must not depend exclusively on the timer running.

## 6. Completion-to-knowledge flow

```mermaid
flowchart LR
    A[Agent completes item] --> B[Structured completion record]
    B --> C[Completed history]
    B --> D[Raw knowledge source]
    D --> E[Knowledge maintenance job]
    E --> F[Update relevant wiki pages]
    E --> G[Update index/log]
```

Knowledge maintenance can be asynchronous inside the local app process, but UI must visibly distinguish:
- completion recorded;
- knowledge update pending;
- knowledge updated;
- knowledge update failed.

## 7. Global search flow

A single project search command may query:
- wiki articles;
- completed work;
- backlog/in-progress items.

Results should be grouped by source type and deep-link into the corresponding Workstack surface.

# Product Acceptance Tests

## A. Project management

### A1 Create project
Given no project exists, when the user creates one with a name and project folder, then:
- it appears in Projects;
- `.workstack/` is initialized;
- project can be reopened after application restart.

### A2 Existing project
Opening a project with an existing compatible `.workstack` directory must preserve all state and not recreate IDs.

## B. Work items

### B1 Manual feature
User can create a Feature with title, Markdown description, acceptance criteria and priority; it appears immediately in Backlog.

### B2 Stable identity
Work item gets a stable UUID and human display ID. Editing it does not change either.

### B3 State views
Backlog, In Progress and Completed views are consistent with authoritative state after restart.

## C. Attachments

### C1 File attachment
Dragging a file onto a new item copies it into project Workstack storage and keeps it accessible after original external file is moved/deleted.

### C2 Paste image
Pasting a screenshot into a work-item Markdown editor:
- persists an image artifact;
- inserts relative Markdown;
- renders after restart;
- is exposed in `get_work_item`.

### C3 Unsafe filename
An attachment named with traversal characters cannot escape the Workstack artifact directory.

## D. Agent coordination

### D1 Atomic claim
Given one backlog item and multiple simultaneous claim attempts, exactly one succeeds.

### D2 Claim visibility
After a successful claim, UI moves item to In Progress and displays correct agent/session.

### D3 Heartbeat
Valid token renews lease and updates last heartbeat.

### D4 Wrong token
A different/invalid token cannot heartbeat, release or complete the item.

### D5 Lease expiry
After expiry, item is claimable again and previous token is invalid.

### D6 Forced release
Human forced release returns item to Backlog and invalidates previous agent ownership.

### D7 Completion
Valid owner can complete an item. It moves to Completed, active claim ends, completion record is persisted and a knowledge source is queued/created.

## E. MCP

### E1 List backlog
MCP can list backlog without exposing claim tokens.

### E2 Get item
MCP returns full work item, acceptance criteria and artifact references.

### E3 Search knowledge
MCP returns relevant project knowledge with source identity/excerpt.

### E4 Search completed
MCP can find previous implementation work based on title/description/completion content.

### E5 Stable errors
Claim conflict, invalid token and missing item produce stable machine-readable errors.

## F. AI planning

### F1 Project awareness
When relevant knowledge exists, planning AI can use it to produce a project-specific proposal.

### F2 Backlog overlap
When similar backlog work exists, planner surfaces it instead of confidently proposing a duplicate without mention.

### F3 Explicit conversion
AI planning never creates a backlog item until user selects Add to Backlog.

### F4 Protect edits
After user manually edits a proposal field, subsequent AI messages do not silently overwrite the field.

### F5 AI unavailable
User can still create/edit work manually and MCP coordination continues when AI provider is unavailable.

## G. Knowledge

### G1 Browse
User can browse Markdown wiki articles.

### G2 Sources
User can identify raw knowledge sources independently of AI-generated wiki text.

### G3 Completion ingestion
Completed work remains successfully completed even if AI wiki maintenance fails.

### G4 Retry
Failed/pending knowledge source processing can be retried without duplicating work-item completion records.

## H. UX/accessibility

### H1 Keyboard navigation
Core screens/actions are accessible with keyboard and specified shortcuts where implemented.

### H2 Status accessibility
Backlog/In Progress/Completed/Attention states are understandable without relying only on color.

### H3 Empty states
Projects with no work/knowledge show clear next actions rather than blank screens.

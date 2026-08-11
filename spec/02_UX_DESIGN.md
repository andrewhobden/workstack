# Workstack UX Design Specification

## 1. Design direction

Workstack should feel closer to Xcode, Finder, Things, Linear and Raycast than to Jira.

Use a light, simple, macOS-native design with:
- system typography;
- a native translucent sidebar;
- subtle dividers;
- restrained use of cards;
- SF Symbols where appropriate;
- compact metadata;
- one blue accent for primary actions;
- status communicated with icon + label, never color alone.

Reference image: `assets/workstack-ux-design-board.png`.

## 2. Global shell

Use a native split-view layout.

```text
┌──────────────────┬────────────────────────────────────────────────────┐
│ PROJECTS         │ Toolbar / current page                            │
│                  ├────────────────────────────────────────────────────┤
│ Workstack        │                                                    │
│ Nanotables       │                   Main content                     │
│ Website          │                                                    │
│ + Add Project    │                                                    │
│                  │                                                    │
│ PROJECT          │                                                    │
│ Overview         │                                                    │
│ Backlog       12 │                                                    │
│ In Progress    3 │                                                    │
│ Completed     48 │                                                    │
│ Knowledge        │                                                    │
│ Activity         │                                                    │
│ Settings         │                                                    │
└──────────────────┴────────────────────────────────────────────────────┘
```

When no project is selected, the sidebar only shows project navigation and the main view shows the Projects screen.

## 3. Projects/Home

Purpose: choose or create a project.

Each project row/card contains:
- project name;
- one-line description;
- backlog count;
- active count;
- completed count;
- last updated time.

Primary action: `+ New Project`.

Context menu:
- Open
- Open Project Folder
- Edit Project
- Duplicate Project (post-V1 acceptable)
- Delete Project

## 4. Create Project sheet

Fields:
- Name — required
- Description — optional
- Repository / Folder — required
- Knowledge option:
  - Create new Workstack knowledge base
  - Use existing `.workstack` folder

Actions: Cancel / Create Project.

After creation, navigate to Overview.

## 5. Project Overview

Purpose: answer “what is happening right now?”

Sections, in order:

### In Progress
Show active claims with:
- Work item ID
- title
- agent name
- elapsed time
- health indicator

### Up Next
Show 3–5 backlog items. Link to Backlog.

### Recently Completed
Show recent completed work with timestamps. Link to Completed.

### Knowledge
Show article/source counts and last update time. Link to Knowledge.

Do not add analytics dashboards or charts to V1.

## 6. Backlog

Primary working view for unclaimed work.

Toolbar:
- Search
- Filter
- Sort
- `+ New Work Item`
- `Plan with AI`

Default presentation is a dense table/list, not a Kanban board.

Columns:
- ID
- Type
- Title
- Priority
- Created
- optional attachment indicator

Row actions:
- Open
- Start Work (for manual testing/human claiming if supported)
- contextual menu

Filtering:
- type;
- priority;
- created date;
- has attachments;
- manual vs AI-generated.

## 7. New Work Item sheet

Fields:
- Type
- Title
- Description (Markdown)
- Acceptance Criteria
- Attachments
- Priority

Attachment interaction:
- drag/drop;
- file picker;
- paste screenshot/image;
- show thumbnails for images;
- Quick Look on Space where practical.

If an image is pasted into the Markdown editor:
1. persist the image as a work-item artifact;
2. insert a relative Markdown image reference;
3. render an inline preview.

Actions: Cancel / Add to Backlog.

## 8. Work Item Detail

Use a main document area plus inspector.

Main area:
- ID + title
- type badge
- status
- Description tab
- Attachments tab
- History tab

Description supports rendered Markdown and Edit mode.

Inspector:
- Status
- Priority
- Type
- Created
- Updated
- Created By
- Related items (optional/manual in V1)
- claim state if active

For a Backlog item, show `Start Work` only if human/manual claiming is intentionally supported; coding agents normally claim via MCP.

## 9. Active/In Progress work item

Show a prominent status strip:

`Claude Code is currently working on this item — last active 18 sec ago.`

Inspector details:
- agent identity;
- session ID;
- claimed at;
- last heartbeat;
- lease expiry / time remaining;
- claim health.

Human actions:
- View Agent Details
- Release Work Item

Releasing should require confirmation if the last heartbeat is recent.

## 10. Completed Work Item

Retain original description and add a Result section:
- completion summary;
- design/implementation notes;
- files/components changed;
- validation/tests;
- known limitations;
- commit/branch/PR references when supplied;
- completed by;
- completed at.

Completed items are read-mostly historical records. Editing should be explicit and audited.

## 11. In Progress page

Purpose: monitor all active coding agents.

Each active item shows:
- Work item ID + title;
- agent + session;
- working duration;
- last heartbeat;
- lease time remaining;
- warning if lease is near expiry.

Sort unhealthy/stale claims to the top when appropriate.

## 12. Completed page

Searchable reverse-chronological history grouped by date.

Search corpus includes:
- title;
- original description;
- completion summary;
- filenames/components changed;
- commit/PR metadata;
- agent identity.

## 13. Plan with AI

This is a primary product surface, not a generic chatbot.

Layout:
- left/main: planning conversation;
- right: evolving Work Item Proposal.

Top context chip:
`Using project context — 37 knowledge articles · 48 completed · 12 backlog`

Clicking it opens a context inspector showing retrieved sources/items used for the current answer.

Conversation supports attachments and pasted images.

### Proposal panel
Editable fields:
- Type
- Title
- Objective / description
- Requirements
- Acceptance criteria
- Relevant implementation context
- Related completed work/backlog references
- Priority

Primary action: `Add to Backlog`.

AI may update the proposal as conversation evolves. User edits must not be silently overwritten; merge or ask before replacing user-modified fields.

## 14. Knowledge browser

Two-column layout:
- article/navigation tree on left;
- Markdown article on right.

Features:
- semantic search;
- article browsing;
- manual edit;
- recently updated section;
- sources view;
- `+ Add Source`.

## 15. Knowledge Search

Global or project-local semantic search should return grouped results:
- Knowledge
- Completed Work
- Backlog

Each result should identify its source type and provide a short matched excerpt.

## 16. Knowledge Sources

Table columns:
- Type
- Name
- Added
- Last processed
- Status

Potential source types:
- Markdown/Text
- PDF/file
- Work item completion
- Folder/document collection

Selecting a source opens a preview and shows which knowledge pages it influenced when that information is available.

## 17. Activity

Reverse-chronological event stream.

Events include:
- item created/edited;
- item claimed/released/completed;
- lease expired;
- knowledge source added;
- knowledge updated;
- manual administrative action.

Filters:
- All
- Human
- Agents
- Work Items
- Knowledge

## 18. Agent Detail sheet

Fields:
- agent display name;
- agent ID/session ID;
- current work item;
- start time;
- last heartbeat;
- lease expiration;
- recent Workstack API/MCP actions.

Do not attempt to recreate the coding agent terminal in V1.

## 19. Project Settings

Tabs/sections:

### General
- Name
- Description
- Project folder

### Knowledge
- Workstack data directory
- auto-update knowledge after completion toggle

### Agents
- default lease duration
- expected heartbeat interval
- auto-release expired claims

### Danger Zone
- delete/detach project

## 20. Application Settings

Sections:
- General
- AI
- MCP
- Advanced

### AI
- provider
- model
- credentials reference
- include knowledge/completed/backlog toggles

Do not store provider secrets in plaintext project files. Use macOS Keychain or equivalent secure credential storage.

### MCP
Show:
- server status;
- command/path;
- `Copy MCP Configuration`;
- diagnostics/log location.

## 21. Command palette / global search

Shortcut: `⌘K`.

Search:
- projects;
- backlog;
- active work;
- completed work;
- knowledge.

Commands:
- Create Work Item
- Plan New Work
- Add Knowledge Source
- Open Project Folder
- Copy MCP Configuration

## 22. Keyboard shortcuts

Suggested:
- `⌘N` — New Work Item
- `⌘⇧N` — Plan New Work
- `⌘K` — Search / Command Palette
- `⌘1` — Overview
- `⌘2` — Backlog
- `⌘3` — In Progress
- `⌘4` — Completed
- `⌘5` — Knowledge
- `⌘↩` — Commit current create/save action
- `Space` — Quick Look selected attachment

## 23. Empty states

### Empty backlog
“Your backlog is empty. Add something yourself or discuss the next feature with Workstack.”
Actions: New Work Item / Plan with AI.

### Empty completed work
“Nothing has been completed yet. Completed work becomes part of Workstack’s long-term project memory.”

### Empty knowledge
“Build your project knowledge. Add existing documentation or let Workstack accumulate knowledge as work is completed.”

## 24. Visual tokens

Use semantic system colors where possible rather than hard-coded RGB values.

Typography (approximate):
- Project title: 24–28pt semibold
- Page title: 20–22pt semibold
- Section label: 12–13pt semibold
- Body: 13–14pt regular
- Metadata: 11–12pt regular/secondary

Spacing:
- 4px micro
- 8px compact
- 12px standard control gap
- 16px section interior
- 24px major section

Corner radius:
- controls: native platform defaults
- cards/sheets: 8–12px equivalent

Status semantics:
- Backlog: neutral circle
- In Progress: active dot + text
- Completed: checkmark + text
- Attention: warning triangle + text

## 25. Accessibility

- keyboard navigation for all core actions;
- VoiceOver labels for status and controls;
- sufficient contrast in light/dark appearance;
- never encode state using color only;
- scalable text where platform conventions support it;
- clear focus rings.

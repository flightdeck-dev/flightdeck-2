# Scratchpad — Visual Collaboration Surface for Lead

> Design doc. Created 2026-06-21.

## Problem

Lead communicates with users entirely through text messages. For architecture discussions, task breakdowns, and design decisions, text is often insufficient — a diagram or visual annotation conveys intent faster and more precisely.

## Proposal

**Scratchpad**: a multi-page HTML canvas that Lead can write/draw on during conversations. Users can annotate on top. Think "shared whiteboard with turn-based collaboration."

## Core Concepts

### Pages

- A scratchpad is a **collection of pages**, each stored as an HTML file.
- Lead creates a new page when the current one is "full" or the topic shifts.
- Pages are **append-forward** — you don't go back and rewrite, you start a new page.
- Lead can retrieve and reference previous pages by index or search.
- Pages belong to a **project** (1 scratchpad per project).

### Storage

```
<project-dir>/scratchpad/
  page-001.html
  page-002.html
  page-003.html
  ...
```

Plain HTML files on disk. No database, no version history, no diffing. Simple and inspectable.

Each page file is self-contained — inline styles, inline SVG, whatever Lead needs. No external dependencies.

### Naming & Metadata

Page files use sequential numbering. An optional frontmatter comment at the top:

```html
<!-- scratchpad:page
  title: Task Dependency Graph
  created: 2026-06-21T13:45:00Z
  related_task: task-abc123
-->
<html>...</html>
```

Lead can search pages by title or content to find previous work.

## Collaboration Model

**Turn-based**, not real-time:

1. **Lead draws** — outputs HTML (diagrams, tables, annotated code, flowcharts)
2. **User annotates** — overlay canvas layer for freehand marks, arrows, text callouts, highlights
3. **Lead reads annotations** — interprets user feedback, updates or creates new page
4. Repeat

This is deliberately simpler than Figma-style real-time collab. The turn-based model matches the existing Lead ↔ User conversation flow and avoids the complexity of conflict resolution / OT / CRDT.

### User Annotation Layer

- Rendered as a transparent `<canvas>` overlay on top of the HTML page
- Tools: freehand draw, arrow, rectangle highlight, text callout
- Annotations are serialized and stored alongside the page (e.g., `page-001.annotations.json`)
- Lead receives annotations as structured data (coordinates + type + text) to interpret intent

```json
{
  "annotations": [
    { "type": "circle", "x": 340, "y": 120, "radius": 40, "color": "red" },
    { "type": "text", "x": 350, "y": 170, "content": "这里不对" },
    { "type": "arrow", "from": [100, 200], "to": [300, 200], "color": "blue" }
  ]
}
```

## What Lead Can Draw

Lead outputs HTML, so anything expressible in HTML/CSS/SVG:

- **Architecture diagrams** — SVG boxes + arrows
- **Task dependency graphs** — DAG visualization
- **Annotated code diffs** — highlighted code blocks with callouts
- **Tables & matrices** — comparison charts, status boards
- **Flowcharts** — decision trees, state machines
- **Progress dashboards** — visual task status

No special drawing library required — Lead generates the HTML directly.

## MCP Tools

New tools for Lead to interact with the scratchpad:

```
scratchpad_create   — create a new page (returns page number)
scratchpad_write    — write/overwrite HTML content to a page
scratchpad_append   — append content to current page
scratchpad_list     — list all pages (titles, dates)
scratchpad_read     — read a page's HTML content
scratchpad_annotations — get user annotations for a page
```

Minimal surface area. Lead writes HTML; the frontend renders it.

## Frontend Integration

### Web UI

- Scratchpad panel alongside (or instead of) the chat panel
- Page navigation (prev/next/jump)
- Annotation toolbar when viewing a page
- Toggle between chat view and scratchpad view

### Electron App

Same as web, rendered in a secondary panel or split view.

## What This Is NOT

- **Not a whiteboard app** — Lead is the primary author, not the user
- **Not real-time collaborative** — turn-based, async-friendly
- **Not versioned** — no undo history, no git-style diffing. New page > edit old page
- **Not a document editor** — scratchpad is ephemeral working space, not final output

## Use Cases

1. **Task decomposition** — Lead draws a dependency graph, user circles tasks to deprioritize
2. **Architecture discussion** — Lead diagrams the system, user annotates "add cache here"
3. **Code review summary** — Lead highlights key changes with visual annotations
4. **Progress report** — visual dashboard instead of text wall
5. **Design exploration** — Lead sketches multiple options side by side, user marks preferred

## Differentiation

No existing coding agent platform has this:
- **Cursor/Copilot** — pure text chat
- **Devin** — has browser but not a collaboration surface
- **AutoGen/CrewAI** — text-only agent communication

Scratchpad is a genuinely novel interaction modality for human-agent collaboration.

## Open Questions

- [ ] Max page size / when to auto-paginate?
- [ ] Should annotations survive across sessions or reset?
- [ ] Keyboard shortcuts for annotation tools?
- [ ] Mobile/tablet touch support for annotations?
- [ ] Should Lead be able to "present" a page (push to user's view)?

## Implementation Phases

### Phase 1 — Core
- File-based page storage
- MCP tools for Lead (create/write/read/list)
- Basic frontend rendering of HTML pages
- Page navigation

### Phase 2 — Annotation
- Canvas overlay for user annotations
- Annotation serialization & storage
- MCP tool for Lead to read annotations

### Phase 3 — Polish
- Better annotation tools (shapes, colors, text)
- Page search
- Thumbnail previews in page list
- Electron split-view integration

---
name: memory-management
description: How to manage project memory and knowledge base
---

# Memory Management

## Project Memory Structure

```
memory/
├── PROJECT.md          — Project overview, architecture, key decisions
├── decisions.md        — Recent decision summaries
├── learnings.md        — Patterns, gotchas, lessons learned
└── retrospectives/     — Per-spec retrospectives
```

## Reading Memory

- `flightdeck_memory_search(query)` — Full-text search across all memory files
- Read files directly: `memory/PROJECT.md`, `memory/learnings.md`, etc.
- Use `flightdeck_status()` for current project state

## Writing Memory

Use `flightdeck_memory_write(path, content)` to update memory files.

### When to Write
- After completing a significant task: update `memory/learnings.md`
- After a spec completes: write `memory/retrospectives/<spec-name>.md`
- When architecture changes: update `memory/PROJECT.md`
- When a new pattern/gotcha is discovered: append to `memory/learnings.md`

### What to Write
- Decisions and their reasoning
- Gotchas and workarounds discovered
- Architecture patterns that emerged
- Things the next agent should know

## Retrospective Process

After a spec completes:
1. Review all tasks and decisions from the spec
2. Write a retrospective: what went well, what didn't, lessons
3. Update `memory/PROJECT.md` if the project overview changed
4. Compress `memory/decisions.md` — remove stale entries

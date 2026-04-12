# Flightdeck 2.0 — E2E Test Scenarios

**Purpose:** Regression test checklist. Run after major changes.
**Runtime:** Copilot CLI via ACP (primary), Claude Code via ACP (secondary)
**Test dir:** `/tmp/flightdeck-e2e-test/` (disposable, never in project)

---

## Prerequisites

- [ ] Copilot CLI installed and authenticated
- [ ] Flightdeck MCP server builds without errors
- [ ] Fresh SQLite database with seed tasks

---

## 1. ACP Connection

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 1.1 | ACP initialize | protocolVersion=1, agent capabilities returned | |
| 1.2 | session/new with MCP servers | Session created, MCP server spawned | |
| 1.3 | First prompt sends and receives response | Agent responds with text | |
| 1.4 | session/load (reconnect after restart) | Session restored with history | |

## 2. MCP Tool Discovery

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 2.1 | Agent sees flightdeck tools | Tools listed in agent's available tools | |
| 2.2 | Permission auto-approve | allow_always works, no manual approval needed | |

## 3. Task Management

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 3.1 | `flightdeck_task_list` | Returns all tasks with status | |
| 3.2 | `flightdeck_task_list` with status filter | Returns only matching tasks | |
| 3.3 | `flightdeck_task_get(id)` | Returns full task detail | |
| 3.4 | `flightdeck_task_claim(id)` | Task: ready → running | |
| 3.5 | `flightdeck_task_submit(id, claim)` | Task: running → in_review | |
| 3.6 | `flightdeck_task_add(title, desc)` | New task created | |
| 3.7 | Task pause + resume | running → paused → running | |
| 3.8 | Task cancel | running → cancelled | |
| 3.9 | Task with dependencies | Blocked task shows dependency info | |
| 3.10 | Declare sub-tasks | Sub-tasks created under parent | |
| 3.11 | Full lifecycle: ready → running → paused → running → in_review | All transitions succeed | |

## 4. Messaging

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 4.1 | `flightdeck_msg_send(to, content)` | Message stored in SQLite | |
| 4.2 | `flightdeck_msg_list` | Returns messages | |
| 4.3 | Thread create + reply | Thread created, reply linked | |
| 4.4 | Task comment | Comment linked to task_id | |

## 5. Project Status

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 5.1 | `flightdeck_status` | Returns project summary | |
| 5.2 | Status reflects task changes | After claim/submit, status updates | |

## 6. Memory

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 6.1 | `flightdeck_memory_search(query)` | Returns matching snippets (or empty) | |
| 6.2 | Memory files readable by agent | Agent can read .flightdeck/memory/*.md | |

## 7. Skills

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 7.1 | `flightdeck_skill_list` | Returns installed skills with role assignments | |
| 7.2 | `flightdeck_skill_install(source)` | Skill installed to .flightdeck/skills/ | |
| 7.3 | AGENTS.md contains skill descriptions | Agent sees available skills on spawn | |

## 8. Multi-Turn Conversation

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 8.1 | Agent remembers previous turn | References earlier task claim | |
| 8.2 | Prompt queuing | Second prompt handled after first completes | |
| 8.3 | Interrupt/redirect | Agent stops current work, handles new prompt | |

## 9. Lead Integration (Claw as Lead)

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 9.1 | Claw spawns worker via ACP | Worker session created | |
| 9.2 | Claw steers worker | Worker receives and acts on steer | |
| 9.3 | Worker reports back via MCP | Task status updated in SQLite | |
| 9.4 | Claw reads status via MCP | Claw sees worker's progress | |
| 9.5 | Claw sends message to worker | Message delivered | |
| 9.6 | Worker escalates to Claw | Escalation received | |

## 10. Error Handling

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 10.1 | Claim already-claimed task | Error with clear message | |
| 10.2 | Submit unclaimed task | Error with clear message | |
| 10.3 | Get non-existent task | Error with clear message | |
| 10.4 | MCP server crash recovery | Agent gets error, can retry | |

## 11. Runtime-Specific

| # | Scenario | Runtime | Expected | Status |
|---|----------|---------|----------|--------|
| 11.1 | System prompt via _meta | Claude Code | Role instructions injected | |
| 11.2 | System prompt via AGENTS.md | Copilot CLI | Agent reads AGENTS.md | |
| 11.3 | .mcp.json generation | All | MCP config written to cwd | |

---

## How to Run

```bash
# Setup
mkdir -p /tmp/flightdeck-e2e-test && cd /tmp/flightdeck-e2e-test

# Seed database + run tests
npx tsx ~/clawspace/flightdeck-2/test-e2e-full.ts

# Or manual: spawn copilot and interact
copilot --acp --stdio --allow-all
```

## Bug Template

When a test fails, document:
```markdown
### Bug: [short description]
- **Test:** #X.Y
- **Error:** [exact error message]
- **Root cause:** [what went wrong]
- **Fix:** [what was changed]
- **Commit:** [hash]
```

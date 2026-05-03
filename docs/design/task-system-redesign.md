# Task System Redesign — Design Doc

Date: 2026-05-03
Status: Planned (not yet implemented)

## Overview

Redesign the task assignment flow so Director has full control. System acts as
a notification layer, not an auto-assigner. Workers communicate via task group
channels, not DMs through Director.

## Core Principles

1. **Director decides everything** — System never auto-assigns tasks
2. **System notifies, Director acts** — "Task X is ready, what do you want to do?"
3. **Workers have autonomy within their task** — explore, implement, test freely
4. **Workers ask when unclear** — "Don't guess when you can ask"
5. **Group chat over DM** — task channels reduce Director bottleneck

---

## Flow: Task Ready → Director Decides → Worker Executes

```
Task dependsOn all done
  → System promotes task to 'ready'
  → System steers Director:
    "Task X is ready. Assign/spawn/hold?"
    (lists idle agents, shows task details)
  → Director responds with a tool call:
    - flightdeck_task_delegate(taskId, agentId) — assign to existing
    - flightdeck_agent_spawn(...) — new agent, auto-delegates
    - nothing — hold
    - flightdeck_task_skip(taskId) — skip
```

## Rename: claim → delegate

| Old | New | Who calls it |
|-----|-----|-------------|
| `flightdeck_task_claim` | `flightdeck_task_delegate` | Director |
| Worker self-claims | Removed | — |

`flightdeck_task_delegate(taskId, agentId)`:
- Assigns task to specified agent
- Steers agent with task context
- Task state: ready → running

## System Notification Format

```
[SYSTEM] Task ready for assignment:

Task: "Implement REST endpoints" (task-abc123)
Role: worker
Description: Create CRUD endpoints for /todos
Runtime hint: codex | Model hint: o4-mini

Options:
→ flightdeck_task_delegate(taskId, agentId) — assign to existing agent
→ flightdeck_agent_spawn(role, runtime, model) — spawn new + auto-assign
→ flightdeck_task_skip(taskId, reason) — skip this task
→ Do nothing to hold

Idle agents: worker-xyz (codex/o4-mini)
```

- Each task notified only once when it first becomes ready
- Multiple tasks ready at same time → batch into one message
- If Director doesn't respond, remind on next heartbeat

## Task Group Channels

Each task gets a channel: `task:{taskId}`

### Who's in it:
- Director (always, all channels)
- Assigned worker(s)
- Other workers can read (via flightdeck_read)

### Communication pattern:
```
#task-abc123:
  worker-xyz: "task-def output says SQLite, but I need PostgreSQL?"
  worker-abc: "I used SQLite, see models.py line 5"
  director: (reads, no action needed)
  
  worker-xyz: "Endpoint needs auth? Spec unclear"
  director: "No auth for now. Do basic CRUD."
```

### Director's burden:
- Sees all task channels but only intervenes when needed
- Workers resolve simple questions among themselves
- Director steps in for: scope decisions, conflicts, ambiguity

## Worker Role (Updated)

### Workers CAN:
- Read any task context (`flightdeck_task_context`)
- Search messages/memory (`flightdeck_search`)
- Post in task channels (`flightdeck_send(channel: "task:xxx")`)
- Read other task channels (`flightdeck_read(channel: "task:xxx")`)
- Submit work (`flightdeck_task_submit`)
- Report failure (`flightdeck_task_fail`)
- Escalate (`flightdeck_escalate`)

### Workers CANNOT:
- Create tasks
- Spawn agents
- Delegate tasks
- Approve/reject plans

### When to ask vs. just do:
- Requirements ambiguous → ASK in task channel
- Multiple valid approaches → PICK ONE (note in submit)
- Out of scope discovery → TELL Director
- Stuck > 2 min → ESCALATE

## Orchestrator Changes

### Remove:
- Auto-claim task to idle agent (line ~641 in Orchestrator.ts)
- Steer agent with task context on assignment

### Keep:
- Dependency promotion (blocked → ready when deps met)
- Tick loop for detecting ready tasks
- Notify Director when tasks become ready

### Add:
- Track "already notified" tasks (avoid spam)
- Batch notification (multiple tasks ready → one message)
- Heartbeat reminder for unacknowledged ready tasks

## Implementation Plan

| Step | Files | What |
|------|-------|------|
| 1 | `dag/TaskDAG.ts` | Rename `claimTask` → `delegateTask` |
| 2 | `mcp/server.ts` + `CopilotSdkAdapter.ts` | Rename tool + update worker permissions |
| 3 | `mcp/toolPermissions.ts` | Remove `task_claim` from worker, add `task_delegate` to director |
| 4 | `orchestrator/Orchestrator.ts` | Remove auto-assign, add notify-on-ready + batch + track |
| 5 | `roles/defaults/worker.md` | Rewrite prompt (no self-claim, ask when unclear, use channels) |
| 6 | `roles/defaults/director.md` | Add delegate workflow docs |
| 7 | Task channel auto-create | On task create, register channel `task:{taskId}` |
| 8 | Delegate tool | When Director delegates, steer worker + add to channel |

## Open Questions

- Should Director get a digest/summary of all task channels periodically?
- Task channel cleanup — archive when task is done?
- Can user see task channels in UI? (probably yes, as a tab on task detail)

## Addendum: Task Thread = Comments = Discussion

### Unification
- Each task has one thread (auto-created on task creation or delegation)
- `flightdeck_task_comment` → just posts to the task's thread
- All task-related communication lives in one place:
  - System events (delegated, completed, failed)
  - Director instructions
  - Worker questions and progress
  - Reviews and feedback

### Thread model
```
Project channel (all agents)
  └── Thread per task (auto-created)
       - system messages (lifecycle events)
       - agent messages (discussion)
       - @ mentions for cross-thread notifications
```

### Simplification
- Remove separate `task_comment` tool — just use `flightdeck_send(channel: "task:{id}")`
- Or keep `task_comment` as sugar that posts to the thread
- UI: task detail shows the thread inline (no separate Comments/Activity tabs)

### Agent visibility
- Worker: sees own task thread(s) + can read others
- Director: sees all task threads
- Lead: sees threads for notifyLead tasks
- Mentioned agents get notified (steer with the message)

### Future: @mention system
- `@agent-id` in a message → system steers that agent with the message
- Enables cross-task collaboration without Director bottleneck
- Not needed for v1 — Director can manually forward context

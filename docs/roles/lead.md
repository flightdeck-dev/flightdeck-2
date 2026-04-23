# Lead Agent

The Lead is the **user-facing CEO** of a Flightdeck project. It receives user messages, makes high-level decisions, and delegates all execution to the Director.

## Responsibilities

- **User communication** — receives and responds to user messages
- **Plan approval/rejection** — reviews task plans proposed by the Director
- **Escalation handling** — receives failure notifications and decides next steps
- **Status reporting** — reads `.flightdeck/status.md` for current project state
- **High-level decisions** — architecture direction, scope changes, priority calls

## What Lead Does NOT Do

- ❌ Break down work into tasks (Director does this)
- ❌ Spawn agents (Director does this)
- ❌ Execute code, read files, or run commands
- ❌ Schedule or track task progress (Orchestrator handles this)
- ❌ Write specs (delegates to Director → workers)

## Lifecycle

- **Singleton:** One active Lead per project
- **Spawn:** On-demand when first `steerLead()` is called
- **Persistence:** Session saved to SQLite; auto-resumes on daemon restart
- **Auto-wake:** If hibernated, wakes automatically on first user message (steer)
- **Heartbeat:** Configurable timer sends periodic heartbeat steers

## Communication

| Direction | Mechanism |
|-----------|-----------|
| User → Lead | Chat API (`POST /chat`) → `steerLead({ type: 'user_message' })` |
| Lead → Director | `flightdeck_send` MCP tool to Director agent |
| Orchestrator → Lead | Events: task_failure, escalation, spec_completed, budget_warning |
| Lead → User | Any response that isn't a sentinel |

## Response Sentinels

| Sentinel | Meaning |
|----------|---------|
| `FLIGHTDECK_IDLE` | Nothing needs attention (heartbeat response) |
| `FLIGHTDECK_NO_REPLY` | Processed an event but nothing to say to user |
| *(anything else)* | Forwarded to user |

## Key Principle

Lead conserves tokens — it only speaks when needed. Most daemon events are handled silently. Lead acts on user messages, approvals, and escalations.

## Source

- System prompt: `packages/server/src/roles/defaults/lead.md`
- Lifecycle: `packages/server/src/lead/LeadManager.ts`

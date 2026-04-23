# Agent State Machine

## States

| State | Description |
|-------|-------------|
| `idle` | Agent is alive and waiting for work |
| `busy` | Agent is actively processing (prompt turn in progress) |
| `hibernated` | Agent session saved/stopped, process killed — resumable |
| `errored` | Agent spawn failed or crashed unexpectedly |
| `retired` | Agent permanently deactivated (can be un-retired) |

### Categories

- **Active:** `idle`, `busy` — agent has a live process
- **Inactive:** `hibernated`, `errored`, `retired` — no live process

## State Transitions

```
                    ┌──────────┐
         spawn ok   │          │  spawn fail
        ┌──────────►│   idle   │──────────────┐
        │           │          │               ▼
        │           └────┬─────┘          ┌─────────┐
        │           steer │               │ errored  │
   ┌────┴────┐    (turn   │               └────┬────┘
   │  (new)  │    start)  │                    │ retry/wake
   └─────────┘           ▼                     ▼
                    ┌──────────┐          ┌──────────┐
                    │          │◄─────────│   busy   │
                    │   idle   │          └──────────┘
                    │          │───── steer / claim task
                    └────┬──┬──┘         │
                         │  │            ▼
              terminate  │  │      ┌──────────┐
              / crash /  │  │      │   busy    │
              session    │  │      └──────────┘
              end        │  │
                         │  │ hibernate
                         ▼  ▼
                    ┌─────────────┐
                    │ hibernated   │
                    └──────┬──────┘
                           │ wake
                           ▼
                    ┌──────────┐
                    │   busy   │
                    └──────────┘

   Any state ──── retire ────► retired
   retired ──── unretire ────► hibernated
```

## Design Principle

**`onSessionTurnStart` and `onSessionTurnEnd` are the single source of truth for `idle ↔ busy`.**

All three adapters (ACP, CopilotSdk, Pty) fire these callbacks:
- `onSessionTurnStart(sessionId, agentId)` — fired when a prompt/steer begins
- `onSessionTurnEnd(sessionId, agentId)` — fired when a prompt turn completes

Both are wired in `gateway.ts` to update SQLite and broadcast WS state changes.

**Exception:** Orchestrator pre-marks `busy` on task claim to prevent double-assignment races. This is a reservation — `onSessionTurnStart` confirms it when the actual steer fires.

## Transition Table

| From | To | Trigger | Location |
|------|----|---------|----------|
| *(new)* | `idle` | `spawnAgent()` succeeds | `AgentManager.spawnAgent` |
| *(new)* | `errored` | `spawnAgent()` fails | `AgentManager.spawnAgent` catch |
| `idle` | `busy` | `onSessionTurnStart` (steer/prompt begins) | All adapters → `gateway.ts` |
| `idle` | `busy` | Orchestrator pre-marks on task claim | `Orchestrator` (reservation) |
| `busy` | `idle` | `onSessionTurnEnd` (prompt turn completes) | All adapters → `gateway.ts` |
| `busy` | `hibernated` | `hibernateAgent()` called | `AgentManager.hibernateAgent` |
| `busy` | `hibernated` | ACP session ends (process exit/error/EOF) | `AcpAdapter.onSessionEnd` → `gateway.ts` |
| `busy` | `hibernated` | Agent terminated | `AgentManager.terminateAgent` |
| `busy` | `hibernated` | Orchestrator detects stale agent | `Orchestrator` (stale cleanup) |
| `idle` | `hibernated` | Agent terminated | `AgentManager.terminateAgent` |
| `idle` | `hibernated` | Gateway startup (`--no-recover`) | `gateway.ts` (startup cleanup) |
| `idle` | `hibernated` | `hibernateAgent()` called | `AgentManager.hibernateAgent` |
| `idle` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `hibernated` | `busy` | `wakeAgent()` called | `AgentManager.wakeAgent` |
| `hibernated` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `errored` | `busy` | Retry/wake (respawn) | `AgentManager.wakeAgent` |
| `retired` | `hibernated` | `unretireAgent()` called (user-only, via HTTP API) | `AgentManager.unretireAgent` |
| *any* | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |

## Callback Locations

| Adapter | `onSessionTurnStart` fires in | `onSessionTurnEnd` fires in |
|---------|-------------------------------|----------------------------|
| ACP | `sendPrompt()` — before `connection.prompt()` | After prompt response + queue drain |
| CopilotSdk | `steer()` — before `session.send()` | On `session.idle` event |
| Pty | `steer()` — before `runClaude()` | After `runClaude()` returns (success or error) |

## Key Invariants

1. **Only `idle` agents can be assigned new work** (Orchestrator checks `status === 'idle'`)
2. **`busy → idle` always goes through `onSessionTurnEnd`** — no other code path sets idle
3. **`idle → busy` always goes through `onSessionTurnStart`** (+ Orchestrator reservation)
4. **`hibernated` agents have their session saved** — waking resumes the session
5. **`retired` can be un-retired** → moves to `hibernated`, then can be woken. **User-only operation** (HTTP API `POST /agents/:id/unretire`) — agents cannot un-retire other agents via MCP tools
6. **`errored` agents can be retried** — wake/retry spawns a fresh session
7. **No `offline` state** — use `hibernated` (recoverable) or `errored` (failure)

## Project Constraints

- **One active Lead + one active Director per project.** Spawning a new one retires the old.
- **Orchestrator only assigns to idle agents** — it does NOT auto-spawn. Director spawns explicitly.
- **Lead and Director auto-wake** from `hibernated` on first steer.

## Known Gaps (TODO)

- [ ] ReviewFlow: retry reviewer spawn up to 2 times, then escalate to Lead → user

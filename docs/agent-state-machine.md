# Agent State Machine

## States

| State | Description |
|-------|-------------|
| `idle` | Agent is alive and waiting for work |
| `busy` | Agent is actively processing (prompt turn in progress) |
| `offline` | Agent process has exited or been terminated |
| `errored` | Agent spawn failed |
| `hibernated` | Agent session saved to disk, process killed to free resources |
| `retired` | Agent permanently deactivated (won't be reused) |

## State Transitions

```
                    ┌──────────┐
         spawn ok   │          │  spawn fail
        ┌──────────►│   busy   │──────────────┐
        │           │          │               ▼
        │           └────┬─────┘          ┌─────────┐
        │                │                │ errored  │
   ┌────┴────┐    turn   │                └─────────┘
   │  (new)  │    ends   │
   └─────────┘           ▼
                    ┌──────────┐
                    │          │◄──── steer / claim task / wake
                    │   idle   │
                    │          │───── steer / claim task
                    └────┬──┬──┘         │
                         │  │            ▼
              terminate  │  │      ┌──────────┐
              / crash /  │  │      │   busy    │
              session    │  │      └──────────┘
              end        │  │
                         │  │ hibernate
                         ▼  ▼
                    ┌──────────┐    ┌─────────────┐
                    │ offline  │    │ hibernated   │
                    └──────────┘    └──────┬──────┘
                                          │ wake
                                          ▼
                                    ┌──────────┐
                                    │   busy   │
                                    └──────────┘

   Any state ──── retire ────► retired
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
| *(new)* | `busy` | `spawnAgent()` succeeds | `AgentManager.spawnAgent` |
| *(new)* | `errored` | `spawnAgent()` fails | `AgentManager.spawnAgent` catch |
| `idle` | `busy` | `onSessionTurnStart` (steer/prompt begins) | All adapters → `gateway.ts` |
| `idle` | `busy` | Orchestrator pre-marks on task claim | `Orchestrator` (reservation) |
| `busy` | `idle` | `onSessionTurnEnd` (prompt turn completes) | All adapters → `gateway.ts` |
| `busy` | `hibernated` | `hibernateAgent()` called | `AgentManager.hibernateAgent` |
| `busy` | `offline` | ACP session ends (process exit/error/EOF) | `AcpAdapter.onSessionEnd` → `gateway.ts` |
| `busy` | `hibernated` | Agent terminated | `AgentManager.terminateAgent` |
| `busy` | `offline` | Orchestrator detects stale agent | `Orchestrator` (stale cleanup) |
| `idle` | `hibernated` | Agent terminated | `AgentManager.terminateAgent` |
| `idle` | `offline` | Gateway startup (`--no-recover`) | `gateway.ts` (startup cleanup) |
| `idle` | `hibernated` | `hibernateAgent()` called | `AgentManager.hibernateAgent` |
| `idle` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `hibernated` | `busy` | `wakeAgent()` called | `AgentManager.wakeAgent` |
| `hibernated` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `errored` | *(new agent)* | Respawn with new agent ID | `AgentManager.spawnAgent` |
| *any* | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| *any* | `offline` | Gateway shutdown cleanup | `gateway.ts` |

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
5. **`retired` is terminal** — no transitions out of `retired`
6. **`errored` is terminal for that agent ID** — a new agent must be spawned
7. **`offline` means the process is gone** — the agent ID persists in SQLite for history

## Known Gaps (TODO)

- [ ] ReviewFlow: retry reviewer spawn up to 2 times, then escalate to Lead → user

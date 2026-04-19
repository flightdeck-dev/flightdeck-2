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

## Transition Table

| From | To | Trigger | Location |
|------|----|---------|----------|
| *(new)* | `busy` | `spawnAgent()` succeeds | `AgentManager.spawnAgent` |
| *(new)* | `errored` | `spawnAgent()` fails | `AgentManager.spawnAgent` catch |
| `busy` | `idle` | Prompt turn completes (`onSessionTurnEnd`) | `gateway.ts` (ACP + CopilotSdk) |
| `busy` | `idle` | `steerLead()` returns | `LeadManager.steerLead` |
| `busy` | `offline` | ACP session ends (process exit/error/EOF) | `AcpAdapter.onSessionEnd` → `gateway.ts` |
| `busy` | `offline` | Agent terminated | `AgentManager.terminateAgent` |
| `busy` | `offline` | Orchestrator detects stale agent | `Orchestrator` (stale cleanup) |
| `idle` | `busy` | User sends message (Lead) | `gateway.ts wireWsToLead` |
| `idle` | `busy` | `steerLead()` called | `LeadManager.steerLead` |
| `idle` | `busy` | `steerAgent()` called | `AgentManager.steerAgent` |
| `idle` | `busy` | Orchestrator assigns task | `Orchestrator` (task claim) |
| `idle` | `busy` | ReviewFlow assigns review | `ReviewFlow` |
| `idle` | `busy` | `wakeAgent()` called | `AgentManager.wakeAgent` |
| `idle` | `offline` | Agent terminated | `AgentManager.terminateAgent` |
| `idle` | `offline` | Gateway startup (`--no-recover`) | `gateway.ts` (startup cleanup) |
| `idle` | `hibernated` | `hibernateAgent()` called | `AgentManager.hibernateAgent` |
| `idle` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `offline` | `busy` | Agent respawned | `AgentManager.spawnAgent` (new ID) |
| `hibernated` | `busy` | `wakeAgent()` called | `AgentManager.wakeAgent` |
| `hibernated` | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| `errored` | `busy` | Agent respawned (new ID) | `AgentManager.spawnAgent` |
| *any* | `retired` | `retireAgent()` called | `AgentManager.retireAgent` |
| *any* | `offline` | Gateway shutdown cleanup | `gateway.ts` |

## Key Invariants

1. **Only `idle` agents can be assigned new work** (Orchestrator checks `status === 'idle'`)
2. **`busy → idle` requires an explicit event** — either `onSessionTurnEnd` callback or `steerLead` return
3. **`hibernated` agents have their session saved** — waking resumes the session
4. **`retired` is terminal** — no transitions out of `retired`
5. **`errored` is terminal for that agent ID** — a new agent must be spawned
6. **`offline` means the process is gone** — the agent ID persists in SQLite for history

## Known Gaps (TODO)

- [ ] `busy → idle` for non-Lead agents steered via `steerAgent()` — currently relies on `onSessionTurnEnd` callback
- [ ] No `busy` timeout — if `onSessionTurnEnd` never fires, agent stays busy forever
- [ ] ReviewFlow marks reviewer `offline` on spawn failure but doesn't retry

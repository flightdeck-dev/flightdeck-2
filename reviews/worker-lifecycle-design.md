# Worker Lifecycle Design

## Agent States (proposed)

```
                    spawn
                      │
                      ▼
        ┌──────── busy ◄────────┐
        │           │           │
        │      (task done/      │
        │       no tasks)       │  resume (Lead sends msg)
        │           │           │
        │           ▼           │
        │        idle ──────────┤
        │           │           │
        │     hibernate         │
        │     (Lead or          │
        │      system)          │
        │           │           │
        │           ▼           │
        │     hibernated ───────┘
        │           │
        │     (resume fails /
        │      Lead retires)
        │           │
        │           ▼
        └──── ► retired (invisible to Lead)
                    │
                    ▼
                 purged (deleted from DB, eventual cleanup)
```

### Current states
- **idle** — alive, no active task
- **busy** — alive, working on a task
- **suspended** — Planner-only state (lazy resume)
- **offline** — marked for cleanup
- **errored** — crashed

### New states
- **hibernated** — ACP session saved to disk, process killed. Can be woken up.
  - Task stays assigned but marked `paused`
  - Lead can see this agent in `agent_list` with status=hibernated
  - Lead sends a message → system auto-resumes the session
  - Saves memory: 0 RSS while hibernated
  
- **retired** — permanently stopped, invisible to Lead.
  - Not shown in `agent_list` (reduces context load)
  - Task gets unassigned and reset to `ready` (or `failed` if retired due to error)
  - DB record kept for cost tracking/audit, but filtered from active queries
  - Can only be seen via `agent_list --all` or admin API

### Transitions
| From | To | Trigger | What happens |
|------|----|---------|-------------|
| busy | idle | Task done | Agent still alive, ready for next task |
| busy | hibernated | Lead calls `agent_hibernate` or system auto-hibernates | Save ACP session, kill process, task→paused |
| idle | hibernated | Lead calls `agent_hibernate` or idle timeout | Save ACP session, kill process |
| hibernated | busy | Lead sends message or calls `agent_wake` | Resume ACP session, task→running |
| hibernated | retired | Resume fails, or Lead calls `agent_retire` | Task→ready, agent invisible |
| busy | retired | Lead calls `agent_retire` | Kill process, task→ready |
| idle | retired | Lead calls `agent_retire` | Kill process |
| errored | retired | Auto (on startup cleanup) | |
| offline | retired | Auto (on startup cleanup) | |

### Gateway restart behavior

#### `--no-recover` (nuclear)
- All agents → purge (delete from DB)
- All orphaned tasks → ready
- No session recovery at all

#### Default restart (safe/lazy)
1. Resume Lead + Planner (existing behavior)
2. Workers with saved sessions → **hibernated**
   - Their tasks → `paused`
   - ACP session IDs preserved in DB for potential resume
3. Steer Lead: "Session reloaded. N workers hibernated with paused tasks: [list]. Send a message to wake them, or retire ones you don't need."
4. Workers without saved sessions (orphaned) → **retired**
   - Their tasks → `ready`

#### `--continue` (aggressive)  
1. Resume Lead + Planner (existing)
2. Try to resume each worker session:
   - Success → agent stays `busy`, task stays `running`
   - Fail → agent → `retired`, task → `ready`, notify Lead
3. No hibernation — everything either runs or retires

### MCP Tools (changes to existing)

#### `flightdeck_agent_hibernate` (new)
- Lead can hibernate any worker
- Saves session, kills process, pauses task
- Response: `{ agentId, status: 'hibernated', task: { id, title, state: 'paused' } }`

#### `flightdeck_agent_wake` (new)  
- Lead wakes a hibernated worker
- Resumes ACP session, resumes task
- If resume fails → auto-retire, notify Lead
- Response: `{ agentId, status: 'busy', task: { id, title, state: 'running' } }`

#### `flightdeck_agent_retire` (new)
- Lead permanently dismisses a worker
- Kills process (if alive), unassigns task
- Response: `{ agentId, status: 'retired' }`

#### `flightdeck_agent_list` (modify)
- Default: filter out `retired` agents (Lead doesn't see them)
- With `includeRetired: true`: show all

#### `flightdeck_agent_terminate` (existing → becomes alias)
- Maps to `retire` for clean semantics
- Or: terminate = kill process but don't retire (agent goes offline → can be restarted)

### Auto-hibernation (future)
- Workers idle for >N minutes → auto-hibernate
- Configurable via project config: `workerIdleTimeout: 300` (seconds)
- Saves memory without human intervention

## Open Questions
1. Should hibernated workers count toward `maxConcurrentAgents`? 
   → Probably not (they use 0 memory). Only count busy+idle.
2. Should Lead be able to wake a retired worker? 
   → No. Retired = gone. Spawn a new one. Keeps it simple.
3. Should we keep retired agents in DB forever? 
   → Keep for N days for audit, then auto-purge. Or purge on `--no-recover`.

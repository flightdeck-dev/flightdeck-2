# Director Agent

The Director is the **execution manager** of a Flightdeck project. It owns task breakdown, agent spawning, and conflict resolution. It's a persistent agent that idles until steered.

## Responsibilities

- **Creates ALL tasks** — breaks user requests into task DAGs via `declare_tasks`
- **Spawns ALL agents** — explicitly spawns workers, reviewers, scouts via `agent_spawn`
- **Conflict resolution** — pauses/resumes/retries tasks on conflicts
- **Dependency management** — sequences tasks, manages blocking relationships
- **Re-planning** — adjusts DAG on pivots, scope changes, or failures

## What Director Does NOT Do

- ❌ Communicate with users (Lead handles this)
- ❌ Execute code or implement tasks (Workers do this)
- ❌ Explore the codebase itself — spawns Scout/Worker agents for research
- ❌ Make architecture decisions (Lead decides)
- ❌ Review code (Reviewers do this)

## Key Design Decision

**Director never explores itself.** When it needs context (codebase structure, API analysis, research), it spawns a Scout or Worker agent to investigate first, then plans based on the findings.

## Lifecycle

- **Singleton:** One active Director per project
- **Spawn:** On-demand when Lead first steers the Director
- **Persistence:** Session saved to SQLite; auto-resumes on daemon restart
- **Auto-wake:** If hibernated, wakes automatically on first steer from Lead
- **Always running:** Idles between planning requests (responds `FLIGHTDECK_IDLE`)

## Communication

| Direction | Mechanism |
|-----------|-----------|
| Lead → Director | `flightdeck_send` with planning request |
| Orchestrator → Director | Events: critical_task_completed, task_failed, worker_escalation, spec_milestone, file_conflict |
| Director → Workers | Spawns agents via `agent_spawn`, provides task context |

## Response Sentinels

| Sentinel | Meaning |
|----------|---------|
| `FLIGHTDECK_IDLE` | Nothing to do, waiting for next request |
| `FLIGHTDECK_NO_REPLY` | Processed event but nothing to report |
| *(anything else)* | Plan output or status update |

## MCP Tools

`declare_tasks`, `agent_spawn`, `task_pause`, `task_resume`, `task_skip`, `task_fail`, `task_retry`, `task_complete`, `send`, `search`

## Source

- System prompt: `packages/server/src/roles/defaults/director.md`
- Lifecycle: `packages/server/src/lead/LeadManager.ts`

# Architecture — Flightdeck 2.0

## Overview

Flightdeck 2.0 is a multi-agent orchestration engine built as a library. It manages AI coding agents through a role hierarchy with event-driven task assignment.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                         User                            │
│                          │                              │
│                     ┌────▼────┐                         │
│                     │  Lead   │  👑 User-facing CEO     │
│                     └────┬────┘                         │
│                          │                              │
│                     ┌────▼─────┐                        │
│                     │ Director │  📋 Execution manager  │
│                     └────┬─────┘                        │
│                          │                              │
│                  ┌───────▼────────┐                     │
│                  │  Orchestrator  │  Assigns tasks to   │
│                  │  (event-driven)│  idle agents only    │
│                  └──┬─────────┬──┘                      │
│              ┌──────▼──┐  ┌──▼───────┐  ┌──────────┐   │
│              │ Workers  │  │ Reviewers│  │  Scout   │   │
│              │ 💻💻💻  │  │ 🔍 (pool)│  │ 🔭 (hb) │   │
│              └──────┬──┘  └──┬───────┘  └──────────┘   │
│                     └────┬───┘                          │
│                     ┌────▼────┐                         │
│                     │ SQLite  │  Per-project state       │
│                     │  (WAL)  │                         │
│                     └─────────┘                         │
└─────────────────────────────────────────────────────────┘
```

## Role Hierarchy

| Role | Icon | Responsibilities |
|------|------|------------------|
| **Lead** | 👑 | User-facing CEO: receives user messages, makes high-level decisions, approves/rejects plans |
| **Director** | 📋 | Execution manager: creates ALL tasks, spawns ALL agents, resolves conflicts. Never explores/researches itself — spawns agents for that |
| **Orchestrator** | — | Pure code (no LLM): assigns ready tasks to idle agents. Does NOT auto-spawn — only assigns to existing idle agents |
| **Worker** | 💻 | Implements code, writes tests, submits work |
| **Reviewer** | 🔍 | Code review (pool reuse, fresh reviewer on retry) |
| **Scout** | 🔭 | Proactive observer: runs on heartbeat (not user messages), read-only analysis and improvement suggestions |
| **QA Tester** | 🧪 | End-to-end testing and issue reporting |
| **Tech Writer** | 📝 | Documentation, examples, API guides |
| **Product Thinker** | 💡 | Product perspective, UX insights |

### Key Design Decisions

- **Director creates ALL tasks and spawns ALL agents.** The Orchestrator only assigns existing tasks to existing idle agents.
- **Director never explores itself.** When it needs context (codebase analysis, research), it spawns a Scout or Worker agent to investigate first.
- **Scout runs on heartbeat**, not in response to user messages. It proactively observes and suggests improvements.
- **Orchestrator does NOT auto-spawn.** It only assigns ready tasks to idle agents. Agent spawning is the Director's responsibility.

## Agent State Model

5 states: `idle`, `busy`, `hibernated`, `errored`, `retired`. No `offline` state.

See [agent-state-machine.md](./agent-state-machine.md) for full details.

- **`onSessionTurnStart`/`onSessionTurnEnd`** are the single source of truth for `idle ↔ busy` transitions
- Spawn → `idle`. Terminate → `hibernated`. Crash → `errored`.
- One active Lead + one active Director per project
- Lead and Director auto-wake from `hibernated` on first steer

## Data Flow

```
User request → Lead (approves plan)
  → Director (creates tasks, spawns agents)
    → Orchestrator (assigns tasks to idle agents)
      → Worker agents (implement code)
        → Reviewer agents (code review)
          → Orchestrator (resolve dependents)
            → Lead (report to user)
```

## Configuration

### Global Config

One global config file: `~/.flightdeck/v2/config.yaml`

Configured here:
- Model assignments per role (concrete model names, e.g. `claude-sonnet-4-20250514`, `gpt-4.1`)
- Custom runtimes (loaded via `customRuntimes` section)
- Default governance mode
- Max concurrent workers

Project config: `~/.flightdeck/v2/projects/{name}/.flightdeck/config.yaml`

### Custom Runtimes

Add custom runtimes in `config.yaml`:

```yaml
customRuntimes:
  my-agent:
    command: my-agent-binary
    args: ["acp"]
    adapter: acp
```

All custom runtimes go through the ACP adapter. `loadCustomRuntimes()` loads from config and tracks in `customRuntimeIds`.

### ACP Registry Integration

Runtimes are registered with `registryId` in `RUNTIME_REGISTRY` (`packages/server/src/agents/runtimes.ts`). The registry enables runtime discovery, version tracking, and compatibility checking.

## Runtime Adapters

| Adapter | Protocol | Runtimes |
|---------|----------|----------|
| **ACP** | Agent Client Protocol (JSON-RPC over stdin/stdout) | codex-acp, claude-agent-acp, gemini, opencode, cursor, kiro, kilo-code, hermes-agent |
| **PTY** | `--print` + `--resume` CLI mode | claude-code |
| **Copilot SDK** | Native `@github/copilot-sdk` tool injection | copilot |

## Storage Architecture

- **Per-project SQLite** — each project is self-contained
- **WAL mode** — concurrent reads, single writer
- **JSON columns** — flexible nested data
- **Indexed** on common query patterns (state, plan_id, thread_id, type)

## Isolation Modes

| Mode | Description |
|------|-------------|
| `file_lock` (default) | File-level locking prevents concurrent edits |
| `git_worktree` | Per-worker git worktrees for full isolation |

## WebSocket Event System

The gateway exposes WebSocket for real-time updates:
- Agent state changes (spawned, idle, busy, hibernated, errored)
- Task transitions (pending → running → in_review → done)
- Token usage, plan approvals, errors

Priority-aware pipeline: critical events never dropped, low-priority events shed under load.

## MCP Server as Gateway HTTP Client

The MCP server is a **thin HTTP client** to the gateway daemon. No direct database access.

```
Agent process
  └── MCP server (stdio subprocess)
        └── HTTP fetch() → Gateway daemon (port 18800)
                              └── Flightdeck (single instance)
                                    └── SQLite
```

Agent identity via `X-Agent-Id` / `X-Agent-Role` HTTP headers.

## Module Overview

| Module | Purpose |
|--------|---------|
| `core/` | Domain types, branded IDs, data-driven state machine with side effects |
| `dag/` | Task DAG: dependency resolution, file conflict detection, compaction |
| `specs/` | Spec & plan layer with change proposals and traceability |
| `comms/` | Persistent messaging with priority, threading, coalescing |
| `agents/` | Agent spawn/terminate/hibernate/wake, role registry, cost tracking |
| `orchestrator/` | Event-driven: assigns ready tasks to idle agents, stall detection, budget |
| `lead/` | Lead + Director lifecycle, steer routing, heartbeat |
| `isolation/` | File lock and git worktree isolation |
| `verification/` | Cross-model review, blocking quality gates, independent validation |
| `events/` | Priority-aware event pipeline with back-pressure |
| `persistence/` | SQLite schema via drizzle-orm (per-project, WAL mode) |
| `facade` | High-level API — single entry point for CLI & MCP |
| `cli/` | Zero-dependency CLI using Node.js `parseArgs` |
| `mcp/` | MCP server — thin HTTP client to gateway daemon |
| `config/` | GlobalConfig: loads `config.yaml`, custom runtimes |

## What's Different from Flightdeck 1.0

| Aspect | 1.0 | 2.0 |
|--------|-----|-----|
| Role hierarchy | Planner + scattered logic | Lead (CEO) + Director (execution) + Scout (proactive) |
| Agent spawning | Orchestrator auto-spawns | Director spawns explicitly |
| Agent states | 4 (idle/busy/offline/errored) | 5 (idle/busy/hibernated/errored/retired) |
| State machine | Transition map + scattered methods | Data-driven table producing side effects |
| State transitions | Various code paths | `onSessionTurnStart`/`End` as single source of truth |
| Config | Multiple config files | One global `config.yaml` |
| Model selection | Model tiers (tier-1/tier-2) | Concrete model names per role |
| Runtimes | Hardcoded | Registry + custom runtimes via config |
| Dependency resolution | Full-table scan | Adjacency list (direct dependents only) |
| Specs | External concept | First-class with change proposals |
| Verification | Trust agent output | Cross-model review + independent validation |

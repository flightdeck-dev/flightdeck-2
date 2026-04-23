# Flightdeck 2.0 — Architecture

## Overview

Flightdeck is a multi-agent orchestration engine that coordinates AI coding agents through a task DAG (directed acyclic graph) with dependency resolution, role-based access control, and governance profiles. Agents communicate with Flightdeck exclusively via MCP (Model Context Protocol) tools, while their lifecycle is managed through ACP (Agent Client Protocol). The system persists all state in a single SQLite file, making it self-contained and easy to deploy.

## Monorepo Structure

```
flightdeck-2/
├── packages/
│   ├── shared/       Branded types, IDs, state machine transitions (shared by all packages)
│   ├── server/       Core orchestration engine, MCP server, CLI, REST API, WebSocket server
│   ├── web/          React web UI (dashboard, task board, chat)
│   ├── vscode/       VS Code extension
│   └── tui/          Terminal UI
├── pnpm-workspace.yaml
└── package.json      (root scripts: test, build, cli, mcp)
```

**`packages/shared`** — Domain types (`Task`, `Agent`, `Message`, `Decision`), branded ID constructors (`taskId()`, `agentId()`), and the data-driven state machine (`transition()` function that returns `{ state, effects }`).

**`packages/server`** — The heart of Flightdeck. Contains the facade, DAG, orchestrator, MCP server, ACP adapter, governance engine, role system, storage, CLI, REST API, and WebSocket server.

**`packages/web`** — React-based dashboard for monitoring tasks, agents, costs, and chatting with the lead agent.

**`packages/vscode`** — VS Code extension for IDE integration.

**`packages/tui`** — Terminal UI for monitoring from the command line.

## Core Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interfaces                          │
│   CLI (/cli)    Web UI (/web)    VS Code (/vscode)   TUI (/tui)│
└──────────┬──────────┬──────────────────────────────────────────┘
           │          │
           ▼          ▼
┌──────────────────────────────┐
│   REST API + WebSocket       │  ← HTTP/WS for web, CLI for terminal
│   (api/ + ws.ts)             │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐     ┌─────────────────────────┐
│   Flightdeck Facade          │────▶│  LeadManager             │
│   (facade.ts)                │     │  - Spawns Lead via ACP   │
│   One instance per project   │     │  - Steers Lead on events │
│   Wires all subsystems       │     │  - Heartbeat timer       │
└──────┬───────────────────────┘     └────────┬────────────────┘
       │                                      │
       │                                      ▼
       │                            ┌─────────────────────┐
       │                            │  AcpAdapter          │
       │                            │  (ACP Client)        │
       │                            │  - spawn() → process │
       │                            │  - steer() → prompt  │
       │                            │  - kill() → cleanup   │
       │                            │  Provides fs+terminal │
       │                            │  to agents            │
       │                            └────────┬────────────┘
       │                                     │ stdin/stdout ndjson
       │                                     ▼
       │                            ┌─────────────────────┐
       │                            │  Agent Process       │
       │                            │  (e.g. Claude Code,  │
       │                            │   Codex CLI)         │
       │                            │                      │
       │                            │  MCP Client ────────────┐
       │                            └─────────────────────┘   │
       │                                                       │
       ▼                                                       ▼
┌──────────────────┐  ┌──────────────┐  ┌─────────────────────────┐
│  TaskDAG         │  │ Governance   │  │  MCP Server              │
│  - State machine │  │ Engine       │  │  (mcp/server.ts)         │
│  - Dependency    │  │ - Profiles:  │  │  40+ tools exposed to    │
│    resolution    │  │   autonomous │  │  agents: task_*, agent_*,│
│  - Side effects  │  │   collab.    │  │  msg_*, memory_*, etc.   │
│  - Compaction    │  │   supervised │  │  Role-filtered per agent │
│  - Sub-tasks     │  │ - Gates      │  └────────────┬────────────┘
└────────┬─────────┘  │ - Escalation │               │
         │            └──────────────┘               │
         │                                           │
         ▼                                           ▼
┌─────────────────────────────────────────────────────────┐
│  SqliteStore (storage/SqliteStore.ts)                    │
│  Single file: state.sqlite                               │
│  Tables: tasks, agents, cost_entries, messages, threads, │
│          file_locks, activity_log, message_queue          │
│  ORM: drizzle-orm + better-sqlite3                       │
└─────────────────────────────────────────────────────────┘

         ┌────────────────────────────┐
         │  Orchestrator (tick loop)  │
         │  Every 5 min (configurable)│
         │  1. Promote pending→ready  │
         │  2. Process completions    │
         │  3. Detect stalled agents  │
         │  4. Auto-assign ready tasks│
         │  5. Check budget limits    │
         │  6. Check spec completions │
         │  7. Compact old tasks      │
         │  8. Broadcast via WS       │
         └────────────────────────────┘
```

## Key Design Decisions

### MCP as the Agent-Orchestrator Protocol

Agents interact with Flightdeck exclusively through MCP tools (`flightdeck_task_claim`, `flightdeck_task_submit`, etc.). This means any agent runtime that supports MCP can plug into Flightdeck — no custom command protocol needed. The MCP server is injected into each agent's session at spawn time via ACP's `mcpServers` parameter.

### ACP for Agent Lifecycle Management

Flightdeck acts as an ACP **Client**, while agents (Claude Code, Codex CLI, etc.) are ACP **Agents**. The ACP protocol handles:
- **Spawning**: `connection.newSession()` with MCP server injection
- **Prompting**: `connection.prompt()` for steering agents with context
- **Session loading**: `connection.loadSession()` for resuming previous sessions
- **Capabilities**: Flightdeck provides `fs` (read/write files) and `terminal` (spawn/manage shells) capabilities to agents

The `AcpAdapter` includes a prompt queue system — if a prompt is in-flight, subsequent messages are queued and merged into a single follow-up prompt.

### SQLite for Persistence

All state lives in a single `state.sqlite` file per project. No external database server needed. The schema uses drizzle-orm with better-sqlite3 and includes auto-migration for schema evolution. Tables: `tasks`, `agents`, `cost_entries`, `messages`, `threads`, `file_locks`, `activity_log`, `message_queue`.

### Role-Based Tool Permissions

Each agent role sees only the MCP tools it needs (`toolPermissions.ts`). Seven roles are defined:

| Role | Key Permissions |
|------|----------------|
| **lead** | Full access — spawn/terminate agents, declare tasks, manage models, cost reports |
| **director** | Create tasks, declare task batches, discuss, search memory |
| **worker** | Claim tasks, submit work, write memory, report failures |
| **reviewer** | Complete or fail tasks (quality gate), search memory |
| **product-thinker** | Create tasks, discuss, write memory, log decisions |
| **qa-tester** | Claim tasks, submit test results, write memory |
| **tech-writer** | Claim tasks, submit docs, read specs, write memory |

Roles are defined as Markdown files with YAML frontmatter (`roles/defaults/*.md`), loaded by `RoleRegistry`. Projects can override roles with custom definitions.

### Task DAG with State Machine

Tasks follow a strict state machine defined in `packages/shared` via the `transition()` function. Valid states:

```
pending → ready → running → in_review → done
                     ↓          ↓
                   paused     failed → ready (retry)
                     ↓
                   running
ready → gated (governance hold)
any → cancelled / skipped
```

State transitions emit **side effects** (typed union `SideEffect`):
- `resolve_dependents` — promote dependent tasks to ready
- `block_dependents` — block downstream tasks on failure
- `spawn_reviewer` — auto-spawn reviewer agent for in_review tasks
- `escalate` — notify lead of issues
- `notify_agent` / `update_dag` / `log_decision`

The `TaskDAG` processes local effects (dependency resolution) and delegates external effects to the `Orchestrator` via an effect handler.

### Governance Profiles

Three profiles control how much autonomy agents have:

- **`autonomous`** — Agents auto-approve high-confidence reversible decisions; only low-confidence or irreversible decisions need review
- **`collaborative`** — Architecture and API design decisions require human approval; implementation decisions are logged
- **`supervised`** — All decisions require human approval; task starts are gated (except reviewers)

The `GovernanceEngine` evaluates decisions, gates task starts, checks cost thresholds, and manages approval workflows.

## Data Flow: Task Lifecycle

1. **Creation** — Lead or director calls `flightdeck_declare_tasks` via MCP. Tasks are inserted into SQLite with state `ready` (no deps) or `pending` (has deps).

2. **Dependency Resolution** — Orchestrator tick promotes `pending` → `ready` when all dependencies reach `done`/`skipped`/`cancelled`. The `TaskDAG.resolveReady()` method walks the adjacency graph.

3. **Assignment** — Orchestrator auto-assigns ready tasks to idle agents matching the required role. If governance gates the task (supervised mode), it moves to `gated` instead.

4. **Execution** — Worker agent calls `flightdeck_task_claim` → state becomes `running`. Agent does work using its own tools + Flightdeck-provided fs/terminal. Calls `flightdeck_task_submit` with a claim summary → state becomes `in_review`.

5. **Review** — If verification is enabled, the `spawn_reviewer` effect triggers a reviewer agent. Reviewer calls `flightdeck_task_complete` (pass) or `flightdeck_task_fail` (reject). If disabled, orchestrator auto-completes.

6. **Completion** — `done` state triggers `resolve_dependents` effect, which promotes downstream tasks. After a configurable TTL (default 24h), completed tasks are compacted to save context.

7. **Failure Handling** — Failed tasks can be retried up to `maxRetries` (default 3). After exhausting retries, the Lead is steered with a `task_failure` event.

## Module Responsibilities

| Directory | Responsibility |
|-----------|---------------|
| `facade.ts` | High-level API wrapping all subsystems; one instance per project |
| `dag/` | Task DAG with adjacency graph, dependency resolution, topological sort, compaction, sub-tasks |
| `orchestrator/` | Tick loop for task promotion, auto-assignment, stall detection, budget checks, compaction |
| `lead/` | Lead agent lifecycle, event-driven steering, heartbeat system, director management |
| `agents/` | ACP adapter (spawn/steer/kill), agent manager, session management, model tier registry |
| `mcp/` | MCP server with 40+ tools, role-based tool filtering, Zod schema validation |
| `governance/` | Governance profiles, approval gates, escalation rules, cost thresholds, decision evaluation |
| `roles/` | Role registry loading Markdown role definitions with YAML frontmatter permissions |
| `storage/` | SQLite store (drizzle-orm), project store (filesystem), spec store, decision log, memory store, message log, report store, learnings store |
| `comms/` | SQLite-backed message store for web UI chat (messages + threads) |
| `api/` | REST API endpoints and WebSocket server for real-time updates |
| `cli/` | Command-line interface commands |
| `core/` | Re-exports from shared package |
| `db/` | Drizzle schema definitions and database factory |
| `reporting/` | Daily report generation from task stats and decisions |
| `skills/` | Skill manager for installing/listing agent skills |
| `verification/` | Cross-model review and quality gate logic |
| `workflow/` | Configurable workflow engine for custom task step sequences |

## Agent Communication Pattern

Flightdeck uses **MCP-as-message-broker**: agents don't talk to each other directly. All coordination flows through the Flightdeck MCP server:

```
Agent A ──MCP──▶ Flightdeck ──MCP──▶ Agent B
   │                 │                  │
   │  task_submit()  │  spawn_reviewer  │  task_complete()
   │                 │  effect          │
   └─────────────────┴──────────────────┘
         All state in SQLite
```

- **DMs**: `flightdeck_msg_send` writes to message log; recipient reads via `flightdeck_channel_read`
- **Channels**: Group discussions via `flightdeck_discuss` / `flightdeck_channel_send`
- **Escalations**: `flightdeck_escalate` writes to the `escalations` channel; Lead is steered with the escalation event
- **Interrupts**: Lead can `flightdeck_agent_interrupt` to send urgent messages directly via ACP `steer()`

The Lead agent is special — it receives structured **steer messages** from the `LeadManager` for events like user messages, task failures, escalations, budget warnings, and heartbeats. The Lead processes these and can spawn/terminate agents, declare tasks, and coordinate the project.

## Testing Strategy

Tests live in `packages/server/tests/` organized by module:

| Test Suite | What It Tests |
|-----------|---------------|
| `dag/dag.test.ts` | Task CRUD, dependency resolution, topological sort |
| `dag/effects.test.ts` | Side effect emission from state transitions |
| `dag/subtasks.test.ts` | Hierarchical task decomposition (FR-017) |
| `dag/compaction.test.ts` | Task compaction after completion (FR-015) |
| `dag/dag-operations.test.ts` | Batch operations, edge cases |
| `orchestrator/orchestrator.test.ts` | Tick loop: promotion, assignment, stall detection |
| `orchestrator/timer.test.ts` | Timer management |
| `orchestrator/compaction-retro.test.ts` | Automatic compaction and retrospective triggers |
| `governance/governance.test.ts` | Profile-based decision evaluation |
| `governance/gate.test.ts` | Task gating per governance profile |
| `mcp/mcp-new-tools.test.ts` | MCP tool registration and invocation |
| `mcp/mcp-role-filter.test.ts` | Per-role tool filtering |
| `mcp/mcp-errors.test.ts` | Error messages and edge cases |
| `mcp/mcp-chat-tools.test.ts` | Chat message and thread tools |
| `lead/lead-manager.test.ts` | Lead steering, heartbeat conditions, event routing |
| `facade/facade.test.ts` | High-level API integration |
| `core/ids.test.ts` | Branded ID generation |
| `core/state-machine.test.ts` | State transition validity and effect emission |
| `workflow/workflow.test.ts` | Custom workflow step sequences |
| `display/websocket-display.test.ts` | WebSocket broadcast format |

Tests use real SQLite (in-memory or temp file) with no mocks for storage, ensuring the full stack from MCP tool → facade → DAG → SQLite is exercised. Agent spawning and ACP communication are typically mocked at the adapter boundary.

Run all tests: `pnpm test` (from root or `packages/server`).

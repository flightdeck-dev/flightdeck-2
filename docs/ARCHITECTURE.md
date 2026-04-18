# Architecture — Flightdeck 2.0

## Overview

Flightdeck 2.0 is a clean-slate multi-agent orchestration engine built as a library. It replaces Flightdeck 1.0 while incorporating lessons from beads, sudocode, OpenSpec, spec-kit, and BMAD-METHOD.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                         User                            │
│                          │                              │
│                     ┌────▼────┐                         │
│                     │  Lead   │  👑 Decisions & comms   │
│                     └────┬────┘                         │
│                          │                              │
│                     ┌────▼────┐                         │
│                     │ Planner │  📋 Task breakdown      │
│                     └────┬────┘                         │
│                          │                              │
│                  ┌───────▼────────┐                     │
│                  │  Orchestrator  │  Event-driven        │
│                  │  (500ms dbnce) │  auto-assign/spawn   │
│                  └──┬─────────┬──┘                      │
│              ┌──────▼──┐  ┌──▼───────┐                  │
│              │ Workers  │  │ Reviewers│                  │
│              │ 💻💻💻  │  │ 🔍 (pool)│                  │
│              └──────┬──┘  └──┬───────┘                  │
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
| **Lead** | 👑 | High-level decisions, user communication, plan approval |
| **Planner** | 📋 | Task breakdown, conflict resolution, agent lifecycle |
| **Orchestrator** | — | Auto-assign tasks, auto-spawn workers, event-driven reactivity |
| **Worker** | 💻 | Write and modify code, implement features and fixes |
| **Reviewer** | 🔍 | Code review (pool reuse, fresh reviewer on retry) |
| **Scout** | 🔭 | Read-only analysis and improvement suggestions |
| **QA Tester** | 🧪 | End-to-end testing and issue reporting |
| **Tech Writer** | 📝 | Documentation, examples, API guides |
| **Product Thinker** | 💡 | Product perspective, UX insights, strategic thinking |

## Data Flow

```
User request → Lead (approves plan)
  → Planner (breaks into tasks, creates DAG)
    → Orchestrator (assigns tasks to agents)
      → Worker agents (implement code)
        → Reviewer agents (code review)
          → Orchestrator (merge or revise)
            → Lead (report to user)
```

## Three-Layer Model

```
Spec Layer (WHAT) → Plan Layer (HOW) → Task DAG (execution atoms)
```

Every layer maintains traceability to the one above. When a spec requirement changes, affected tasks are auto-marked stale.

## Storage Architecture

- **Per-project SQLite** — Each project has its own database file (no global state)
- **WAL mode** — Concurrent reads, single writer
- **JSON columns** — Flexible nested data (requirements, capabilities, file lists)
- **Indexed** on common query patterns (state, plan_id, thread_id, type)
- **Config:** `config.json` (project settings) + `config.yaml` (optional)

## Runtime Adapters

| Adapter | Protocol | Runtimes |
|---------|----------|----------|
| **ACP** | Agent Client Protocol (JSON-RPC over stdin/stdout) | codex, codex-acp, claude-agent, gemini, opencode, cursor, kiro, kilo-code, hermes-agent |
| **PTY** | `--print` + `--resume` CLI mode | claude-code |
| **Copilot SDK** | Native `@github/copilot-sdk` tool injection | copilot |

## Isolation Modes

| Mode | Description |
|------|-------------|
| `file_lock` (default) | File-level locking prevents concurrent edits to the same file |
| `git_worktree` | Each worker gets its own git worktree for full isolation |

## WebSocket Event System

The gateway daemon exposes a WebSocket endpoint for real-time updates:
- Agent state changes (spawned, idle, working, crashed)
- Task transitions (pending → running → in_review → done)
- Token usage updates
- Plan approval requests
- Error/crash notifications

Priority-aware event pipeline with back-pressure: critical events (crashes, failures) are never dropped; low-priority events shed under load.

## Session Persistence & Recovery

- **Copilot SDK** — Sessions managed internally by the SDK
- **Claude Code** — `--resume` flag restores conversation context across invocations
- **ACP runtimes** — `session/load` where supported (codex, cursor)
- **Crash recovery** — Heartbeat-based crash detection; orchestrator re-assigns failed tasks

## Module Design Decisions

### 1. `core/` — Domain Types & State Machine

**The beating heart.** All state changes flow through a single `transition(taskId, currentState, action) → TransitionResult | TransitionError` function.

**Key decisions:**
- **Transition table as data** (not code). Flightdeck 1.0 had `VALID_TRANSITIONS` as a simple allowed-from-state map, but the actual transitions were scattered across methods. 2.0 makes the table produce both the new state AND side effects.
- **Branded types** (`TaskId`, `SpecId`, etc.) prevent accidentally passing a `MessageId` where a `TaskId` is expected. TypeScript structural typing makes this easy to accidentally mix up.
- **Hash-based IDs** (from beads `bd-a1b2` pattern). Multiple agents can create tasks simultaneously without coordination. `createHash('sha256').update(seed).digest('hex').slice(0, 8)` gives us 8-char hex with negligible collision probability.
- **Side effects as discriminated unions.** When `running → done` happens, the transition returns `[{ type: 'resolve_dependents' }, { type: 'compact' }]`. The caller processes these — no hidden side-channel mutations.

**From beads:** Gate primitives (`awaitType`, `awaitId`, `timeout`) — async coordination for CI checks, PR reviews, timers, human approval.

### 2. `dag/` — Task DAG Engine

**Key decisions:**
- **Adjacency list** (not full-table scan). Flightdeck 1.0's `resolvePendingDependencies()` scanned all tasks on every completion. 2.0 maintains `dependents` and `dependencies` maps — when task A completes, only check A's direct dependents.
- **File conflict detection.** Tasks sharing files without explicit dependency create subtle merge conflicts. 2.0 tracks file ownership and rejects tasks that share files without a dependency chain.
- **Compaction** (from beads). Completed tasks auto-summarize after a TTL, replacing their full description with a compact summary. This saves context window when the DAG history grows.
- **Cycle detection via DFS** and **topo-sort via Kahn's algorithm** for execution planning.

**From sudocode:** Topo-sort with priority ordering for deterministic execution plans.

### 3. `specs/` — Spec & Plan Layer

**Key decisions:**
- **Spec/Change separation** (from OpenSpec). Specs represent current truth. To modify a spec, you create a `Change` → review → approve → merge. This gives audit trail and prevents drive-by modifications.
- **Spec template structure** (from spec-kit): requirements (functional + non-functional), acceptance criteria, user scenarios.
- **Spec → Task traceability.** Every task links to a `specRequirementId`. When a spec change modifies a requirement, all linked tasks are marked stale.
- **Plan as mapping layer.** A Plan maps requirements to tasks, making it clear which code implements which requirement.

**From sudocode:** The spec↔issue dual layer — specs are the "what", issues/tasks are the "how/do".

### 4. `comms/` — Unified Communication

**Key decisions:**
- **Everything persists.** Flightdeck 1.0 had some in-memory-only messaging paths. 2.0 stores every message with delivery tracking.
- **Priority-aware inbox.** Critical messages (never dropped) sort above normal and low.
- **Threading.** Messages form trees via `threadId` + `replyTo`.
- **Coalescing.** Low-priority messages in a thread can be coalesced into a single summary, reducing noise.

**From beads:** Messaging-as-issue-type pattern — messages are first-class persistent entities, not fire-and-forget.

### 5. `agents/` — Agent Management

**Key decisions:**
- **Role registry** with system prompts and capability declarations (from Flightdeck 1.0's 14 built-in roles).
- **Heartbeat-based crash detection.** If an agent doesn't heartbeat within timeout, it's marked crashed.
- **Cost tracking** per agent — essential for production multi-agent systems.
- **Capability matching** for task assignment.

**From BMAD-METHOD:** Scale-adaptive intelligence concept — different roles/models for different task complexity.

### 6. `verification/` — Trust & Quality

**The most important module.** From Ry Walker's research: agents self-certify success even when broken.

**Key decisions:**
- **Cross-model review.** Writer model ≠ reviewer model. This prevents systematic blind spots where the same model makes and reviews the same mistake.
- **Fresh reviewer rule.** On retry, a new reviewer agent is required. Previous reviewer may have anchoring bias.
- **Blocking quality gates.** `canCommit(taskId)` checks all required gates. No path from failure to commit without explicit gate clearance.
- **Independent validation.** `validatedBy: 'orchestrator'` — the orchestrator runs tests directly and records results. Never asks an agent "did tests pass?"

### 7. `events/` — Event Pipeline

**Key decisions:**
- **Priority-aware queue.** Agent crashes and task failures are priority 0 (critical, never dropped). Under back-pressure, low-priority events are shed first.
- **Typed event system** with discriminated unions — exhaustive pattern matching in handlers.
- **Async processing** with error isolation — one handler failure doesn't crash the pipeline.

### 8. `orchestrator/` — Event-Driven Orchestrator

The orchestrator reacts to events (task completions, agent crashes, new plans) and automatically:
- Assigns pending tasks to idle workers
- Spawns new workers when needed
- Routes completed tasks to reviewers (with pool reuse)
- Uses 500ms debounce to batch rapid state changes

### 9. `isolation/` — Isolation Manager

Prevents file conflicts between concurrent agents:
- **file_lock** (default): File-level locking, lightweight
- **git_worktree**: Full git worktree per worker, heavier but complete isolation

### 10. `facade` — High-Level API

The `Flightdeck` facade class wires all modules together with direct SQLite persistence. It's the single entry point for CLI and MCP server — a thin, stateless wrapper that opens the DB, executes operations, and returns results.

### 11. `cli/` — Command-Line Interface

A zero-dependency CLI using Node.js built-in `parseArgs`. All commands are thin wrappers over the facade. Supports human-readable and `--json` output.

### 12. `mcp/` — MCP Server (HTTP Gateway Client)

A stdio-based MCP server that acts as a **thin HTTP client** to the gateway daemon. No direct database access — all operations route through the gateway to ensure a single source of truth for state and side effects. Uses `@modelcontextprotocol/sdk`.

### 13. `persistence/` — Storage Layer

**Key decisions:**
- **SQLite via drizzle-orm** (same proven stack as Flightdeck 1.0).
- **WAL mode** for concurrent reads.
- **JSON columns** for flexible nested data (requirements, capabilities, file lists).
- **Indexed** on common query patterns (state, plan_id, thread_id, type).
- **Per-project** — each project is self-contained, no global state files.

## What's Different from Flightdeck 1.0

| Aspect | 1.0 | 2.0 |
|--------|-----|-----|
| State machine | Transition map + scattered methods | Data-driven table producing side effects |
| Dependency resolution | Full-table scan | Adjacency list (direct dependents only) |
| IDs | UUID-like | Hash-based (conflict-free multi-agent) |
| Specs | External concept | First-class with change proposals |
| Verification | Trust agent output | Cross-model review + independent validation |
| Messaging | Partial persistence | Full persistence with priority + threading |
| Compaction | None | Auto-summarize completed tasks |
| File conflicts | Manual | Automatic detection |

## MCP Server as Gateway HTTP Client (2026-04-17)

### Problem
The MCP server (`flightdeck-mcp.mjs`) was creating its own `new Flightdeck()` instance,
directly accessing SQLite. This caused state divergence between the MCP subprocess and
the gateway daemon — side effects (like `spawn_reviewer`) only exist in the gateway's
DAG effectHandler but never fire from MCP calls.

### Decision
MCP server is a **thin HTTP client** to the gateway. It has no direct database access.

```
Agent process
  └── MCP server (stdio subprocess)
        └── HTTP fetch() → Gateway daemon (port 18800)
                              └── Flightdeck (single instance)
                                    └── SQLite
```

### Rationale
- **Single source of truth**: Gateway owns all state and side effects
- **No state divergence**: MCP doesn't maintain its own DAG or Flightdeck instance
- **Side effects work**: task_submit → in_review → spawn_reviewer all happen in-process
- **Simpler MCP code**: Just HTTP calls, no domain logic

### Agent Identity
- `X-Agent-Id` / `X-Agent-Role` HTTP headers (from env vars set by AcpAdapter)
- Gateway validates agent exists and has permission for the requested action
- MCP server doesn't need to resolve agents itself

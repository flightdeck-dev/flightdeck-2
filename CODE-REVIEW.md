# Code Review — Flightdeck 2.0

**Reviewer:** Claw (code review subagent)
**Date:** 2026-04-12
**Commit state:** All 43 tests pass, TypeScript compiles clean (`tsc --noEmit` zero errors)

---

## 1. Summary

Solid Phase 1 foundation. The core abstractions (branded types, state machine, DAG, SQLite store, governance engine, orchestrator) are well-structured and correctly layered. The hybrid storage pattern (SQLite for queries, JSONL for decisions/messages, Markdown for specs/memory/reports) matches the spec. The MCP server exposes 13 tools. The orchestrator correctly uses ACP session state for stall detection, not time-based timeouts.

The code is clean, well-typed, and testable. Main concerns are: (1) a state machine logic bug around `running→done` vs `running→in_review→done`, (2) several spec features stubbed but not wired, and (3) the MCP server has no caller auth (Layer 3 enforcement missing).

**Overall: Good for Phase 1/POC. Several issues need fixing before Phase 2.**

---

## 2. Issues

### Critical

**C1: `running→done` bypasses verification (state machine + facade)** ✅ FIXED
`types.ts` allows `running→done` directly AND `running→in_review→done`. The spec says workers submit → task goes to `in_review` → reviewer checks → `done`. But `Flightdeck.completeTask()` and `TaskDAG.completeTask()` allow jumping straight from any state to `done` (as long as the transition is valid). The `running→done` transition even emits `spawn_reviewer` as a side effect, but nothing consumes that effect — so verification is silently skipped.

**Fix:** Either remove `running→done` from valid transitions (force `running→in_review→done`), or wire up side effects so `spawn_reviewer` actually triggers verification. Currently side effects from `transition()` are computed but never consumed by any caller.

**C2: Side effects are computed but discarded** ✅ FIXED
Every `transition()` call returns `effects[]`, but `TaskDAG.claimTask()`, `submitTask()`, `completeTask()`, `failTask()` all ignore the returned effects. The `spawn_reviewer`, `escalate`, `update_dag` effects are dead code. This means:
- No reviewer is ever spawned on task completion
- No escalation happens on task failure
- The event-driven architecture described in the spec doesn't exist yet

### Major

**M1: MCP server has no caller identity / auth (Layer 3 missing)** ✅ FIXED
Spec describes 3-layer enforcement: AGENTS.md (soft) → `enabled_tools` (hard) → server-side auth (hardest). The MCP server accepts any call with no caller identity check. A worker could call `flightdeck_task_list` and modify the DAG indirectly. No `agentId` validation on any tool.

**M2: `flightdeck_task_submit` ignores the `claim` parameter** ✅ FIXED
The tool accepts `claim: z.string().optional()` but the facade's `submitTask()` just transitions state. The claim string is never stored anywhere — not in SQLite, not in JSONL, nowhere. This breaks the claim-vs-reality verification model (FR-007).

**M3: `flightdeck_discuss` is a no-op** ✅ FIXED
Creates a channel name string but doesn't actually create anything persistent. No messages stored, no invitees tracked, no safety nets (max_messages, duration, cost_cap) from FR-021a.

**M4: Orchestrator `ended` session handling resets to `ready` without state machine validation** ✅ FIXED
In `Orchestrator.tick()`, when a session has `ended`, it calls `store.updateTaskState(task.id, 'ready', null)` directly, bypassing the state machine. The valid transition would be `running→failed→ready`. This circumvents the state machine as single source of truth (NFR-004).

**M5: `MessageLog.channels()` uses `require()` inside an ESM module** ✅ FIXED
`MessageLog.ts` line: `const { readdirSync } = require('node:fs')` — this is already imported at the top of the file. The `require()` call will fail in pure ESM environments. Should use the already-imported `readdirSync`.

Wait — looking again, `readdirSync` is NOT in the top-level imports of `MessageLog.ts`. Only `appendFileSync, existsSync, readFileSync, mkdirSync` are imported. So the `require()` is needed, but should be a proper import instead.

**M6: Governance `shouldGateTaskStart` checks task state, not profile rules** ✅ FIXED
The method signature takes `taskState` but the spec says collaborative gates "before starting each task" and supervised gates "on everything except trivial tasks". The current implementation just checks the profile name and returns true/false — it doesn't consider task type, role, or whether it's trivial. Minor mismatch but will need rework for real governance.

### Minor

**m1: `autonomous` mode has a gap: confidence 0.5-0.8 + irreversible = auto-approved**
In `GovernanceEngine.evaluateDecision()`, the first check is `confidence >= 0.8 && reversible → approve`. The second is `confidence < 0.5 || !reversible → gate`. But a decision with `confidence: 0.6, reversible: false` hits the second check correctly (gates). However, `confidence: 0.6, reversible: true` falls through to `return { allowed: true, action: 'log' }` — logged but allowed, even at medium confidence. This seems intentional but worth documenting.

**m2: Task IDs include timestamp, making them non-deterministic**
`TaskDAG.addTask()` uses `taskId(opts.title, now)` — since `now` changes every call, the same logical task gets different IDs if created twice. This conflicts slightly with NFR-005 ("hash-based, conflict-free concurrent creation") since the intent is that the same inputs produce the same ID. Consider using specId + title + dependsOn hash instead of timestamp.

**m3: `SpecStore.write()` doesn't ensure directory exists** ✅ FIXED
Unlike `DecisionLog`, `MemoryStore`, `MessageLog`, and `ReportStore` which all call `mkdirSync(recursive)`, `SpecStore.write()` just calls `writeFileSync` directly. Will throw if the specs directory doesn't exist.

**m4: `topoSort()` doesn't detect cycles** ✅ FIXED
If the DAG has a cycle (shouldn't happen, but defensive programming), `topoSort()` will silently return a partial ordering. Should check `sorted.length === tasks.length` and throw if not equal.

**m5: CLI `start` command is a stub that doesn't actually start the orchestrator** ✅ FIXED
The facade creates an orchestrator but the CLI doesn't call `orch.start()`. The `start` command just prints a message.

---

## 3. Missing (in spec but not implemented)

| Spec Feature | Status |
|---|---|
| **Event bus** (NFR-003: modules communicate through events) | Not implemented. No event system exists. Modules call each other directly via facade. |
| **Spec change detection** (FR-008: detect changes, mark tasks stale) | Not implemented |
| **Task compaction** (FR-015) | Not implemented |
| **Hierarchical DAGs** (FR-017) | Not implemented |
| **Report generation** (FR-004) | `ReportStore` exists but nothing generates reports |
| **Agent role enforcement via MCP enabled_tools** (Layer 2) | Not implemented |
| **Isolation strategies** (FR-013: git_worktree, directory) | Config field exists, no implementation |
| **Cost tracking integration** | `CostEntry` table exists, `insertCostEntry` works, but nothing records costs from agent activity |
| **Verification flow** | `Verifier.verify()` is a stub returning hardcoded `passed: false` |
| **Lead agent persistent session** (FR-018) | Not implemented |
| **Planner agent on-demand spawn** (FR-019) | Not implemented |
| **`on_completion` behavior** (explore/stop/ask) | Config field exists, no implementation |
| **Group chat safety nets** (FR-021a: max_messages, duration, cost_cap) | Not implemented |
| **Agent communication: DM routing** | Messages stored but not routed to agents |
| **`flightdeck init` writing .mcp.json** | CLI `init` writes `.flightdeck.json` but not `.mcp.json` or `.codex/config.toml` |
| **Daily report format** | Not implemented (ReportStore is just file read/write) |

Most of these are Phase 2/3 items per the spec, so this is expected for a Phase 1 POC.

---

## 4. Suggestions

**S1: Wire up side effects or remove them**
The `transition()` function computes effects that nobody reads. Either add an effect handler (even a simple one that logs them) or remove the effect computation to avoid misleading future developers.

**S2: Add a `TaskStore` abstraction**
`TaskDAG` directly owns `SqliteStore` and does both graph operations and persistence. Consider separating the storage concern so the DAG is purely about graph logic, tested with in-memory stores.

**S3: Make `Flightdeck` facade disposable / use `Symbol.dispose`**
The facade creates SQLite connections that must be closed. A `using` pattern or `Symbol.dispose` would prevent leaks.

**S4: Store `claim` text on task submission**
Add a `claim` column to the tasks table (or a separate `submissions` table) so the verification flow has data to work with.

**S5: Add `flightdeck_task_add` MCP tool** ✅ FIXED
The spec lists this as a lead tool, but it's not in the MCP server. Agents can't create tasks.

**S6: Consider making `ProjectConfig` richer**
The current config is minimal (5 fields). The spec's governance YAML has approval_gates, escalation rules, reporting config, verification settings, compaction settings. Consider a schema that can grow.

**S7: MessageLog should use SQLite for queries**
Currently messages are in JSONL files filtered by string comparison on timestamps. For anything beyond trivial usage, this won't scale. The spec says "SQLite for daemon queries" — messages are queried by the daemon (orchestrator routes them).

---

## 5. Test Gaps

| What's Missing | Priority |
|---|---|
| **MCP server tests** — 13 tools, zero tests. Should test tool registration, parameter validation, project resolution from cwd. | High |
| **CLI tests** — no tests for any CLI command | Medium |
| **DecisionLog tests** — append, readAll, empty file handling | Medium |
| **MessageLog tests** — append, read with `since` filter, channel listing, the `require()` ESM issue | Medium |
| **MemoryStore tests** — search across multiple files, empty directory | Low |
| **SpecStore tests** — list, read, write, title extraction | Low |
| **ReportStore tests** — write, read, list, latest | Low |
| **ProjectStore tests** — init, resolve from cwd, config read/write | Medium |
| **State machine: edge cases** — `gated→running`, `paused→running`, `skipped→pending` transitions not tested | Low |
| **DAG cycle detection** — what happens if you create a cycle? | Low |
| **Orchestrator: governance gating** — test that collaborative/supervised profiles gate task starts | Medium |
| **Orchestrator: error handling** — test that adapter errors are caught and reported | Low |
| **Facade: close() behavior** — test that resources are properly cleaned up | Low |
| **Integration test: full spec→plan→execute→verify lifecycle** | High (Phase 2) |

---

## Verdict

This is a well-architected Phase 1. The type system is solid (branded IDs, const arrays for enums, proper interfaces). The layering is clean (core → storage → dag → governance → orchestrator → facade → mcp/cli). SQLite usage is correct (WAL mode, parameterized queries, proper migrations).

The two critical issues (C1: side effects discarded, C2: `running→done` bypass) should be fixed before building Phase 2 on top. The MCP server needs caller auth before any real agent interaction. Everything else is Phase 2 territory.

**Ship for Phase 1. Fix C1/C2 and M2/M4/M5 before Phase 2.**

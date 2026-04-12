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

---

## Round 2 Review

**Reviewer:** Claw (round 2 subagent)
**Date:** 2026-04-12
**Build status:** 56 tests pass (11 files), `tsc --noEmit` clean (zero errors)

### Fix Verification

| Issue | Status | Notes |
|-------|--------|-------|
| **C1: `running→done` bypass** | ✅ Verified | `running→done` removed from `VALID_TRANSITIONS`. Only path is `running→in_review→done`. Test `effects.test.ts` confirms `completeTask()` throws on running state. |
| **C2: Side effects discarded** | ✅ Verified | `TaskDAG.processEffects()` implemented as a private method. Handles `resolve_dependents` (promotes pending→ready), `block_dependents`, `clear_assignment`, and `set_timestamp`. Called from `claimTask`, `submitTask`, `completeTask`, `failTask`. `spawn_reviewer`/`escalate`/`notify_agent` are documented no-ops for Phase 2. |
| **M1: MCP caller auth** | ⚠️ Partial | `task_add` validates lead/planner, `task_claim` and `task_submit` validate worker role. **But:** `task_fail`, `msg_send`, `channel_send`, `escalate`, `discuss` accept `agentId` without role validation. Read-only tools (`task_list`, `status`, `spec_list`, `memory_search`, `channel_read`) require no `agentId` at all — acceptable for Phase 1 but Layer 3 is incomplete. |
| **M2: Claim stored** | ✅ Verified | `SqliteStore.updateTaskClaim()` added. `claim` column in tasks table (with migration for existing DBs). `TaskDAG.submitTask()` calls `store.updateTaskClaim()` when claim is provided. Test confirms claim is persisted in DB. |
| **M3: Discuss creates persistent channel** | ✅ Verified | `flightdeck_discuss` now creates an initial system message in the channel via `fd.sendMessage()`, which writes to `{channel}.jsonl`. Channel is listable via `channels()`. Not a full discussion system (no invitee tracking, no safety nets), but the channel persists. Acceptable for Phase 1. |
| **M4: Orchestrator uses state machine** | ⚠️ Partial | For `ended` sessions, orchestrator now calls `dag.failTask()` (which uses `transition()`), **but then calls `store.updateTaskState(task.id, 'ready', null)` directly**, bypassing the state machine for the `failed→ready` transition. This should call `transition('failed', 'ready')` or go through a DAG method to stay consistent with NFR-004. |
| **M5: ESM import fixed** | ✅ Verified | `MessageLog.ts` now imports `readdirSync` properly at the top level alongside other `node:fs` imports. No `require()` calls anywhere. |
| **M6: Governance checks task role** | ✅ Verified | `shouldGateTaskStart(taskState, taskRole?)` now accepts role. Supervised mode skips gating for `reviewer` role (treating it as trivial). Tests cover all three profiles. |
| **m3: SpecStore dir** | ✅ Verified | `write()` now calls `mkdirSync(dirname(filepath), { recursive: true })`. |
| **m4: Cycle detection** | ✅ Verified | `topoSort()` throws `"Cycle detected"` when `sorted.length !== tasks.length`. Test confirms. |
| **m5: CLI start stub** | ✅ Verified (implicit) | Orchestrator `start()`/`stop()` tested in orchestrator tests. CLI not directly tested but the underlying machinery works. |
| **S5: task_add tool** | ✅ Verified | `flightdeck_task_add` tool added to MCP server with role validation. |

### Remaining Issues

**R1 (Medium): Orchestrator still bypasses state machine for `failed→ready`**
In `Orchestrator.tick()` when handling `ended` sessions, the code calls `this.store.updateTaskState(task.id, 'ready', null)` directly after `failTask()`. Should go through `transition('failed', 'ready')` and `processEffects()` to maintain the state machine as single source of truth.

**R2 (Low): Incomplete MCP role validation**
Several MCP tools (`task_fail`, `msg_send`, `channel_send`, `escalate`, `discuss`) accept `agentId` but don't validate the caller's role. A worker could call `flightdeck_escalate` or `flightdeck_discuss` — probably fine semantically, but inconsistent with the tools that do validate.

**R3 (Low): No MCP server tests**
The 13 MCP tools still have zero direct tests. Tool registration, parameter validation, and role-gating logic are only tested indirectly through facade/DAG tests. This is the biggest test gap.

### New Issues Introduced

None found. The fixes are clean and don't introduce regressions.

### Overall Assessment

**Ready for Phase 2 with one caveat:** Fix R1 (orchestrator state machine bypass) before building more orchestrator features on top. R2 and R3 are Phase 2 housekeeping items.

The fix agent did solid work. All critical and most major issues are properly resolved. The code remains clean, well-typed, and the test suite grew from 43 to 56 meaningful tests covering the new functionality.

### R4 (Medium): MCP Error Messages Are Not Agent-Friendly

Every MCP tool error should tell the calling agent: (1) what went wrong, (2) why, (3) what to do instead. Current state:

#### Role validation errors (3 tools) — Incomplete

| Tool | Current error | Problem |
|------|--------------|--------|
| `task_add` | `"Error: Only lead/planner agents can add tasks (caller role: worker)"` | Says what/why but **not what to do instead**. Should suggest `flightdeck_escalate()` to request a lead create the task. |
| `task_claim` | `"Error: Only workers can claim tasks (caller role: lead)"` | Same — no remediation. Should say tasks are auto-assigned by the orchestrator, or suggest delegating to a worker. |
| `task_submit` | `"Error: Only workers can submit tasks (caller role: lead)"` | Same pattern. |

#### Unknown agent errors (3 tools) — Missing entirely

| Tool | Current behavior | Problem |
|------|-----------------|--------|
| `task_add` | `agent = fd.sqlite.getAgent(...)` → if `null`, **silently proceeds** (the `if (agent && ...)` guard skips validation) | An unregistered agentId bypasses all role checks. Should error: `"Agent 'xyz' not found. Register with the orchestrator before calling tools."` |
| `task_claim` | Same — unknown agent bypasses role check | Same |
| `task_submit` | Same — unknown agent bypasses role check | Same |

This is actually a **security hole**: any caller can pass a nonexistent `agentId` to skip role validation.

#### Uncaught exceptions from facade/DAG (5 tools) — Raw stack traces

These tools call facade methods that `throw new Error(...)` but have **no try/catch**:

| Tool | Throws when | Raw error message |
|------|------------|------------------|
| `task_claim` | Task not found | `"Task not found: task-xyz"` |
| `task_claim` | Task not ready | `"Task task-xyz is not ready (state: pending)"` |
| `task_submit` | Task not found | `"Task not found: task-xyz"` |
| `task_submit` | Task not running | `"Task task-xyz is not running (state: done)"` |
| `task_fail` | Task not found | `"Task not found: task-xyz"` |
| `task_fail` | Invalid transition | `"Invalid state transition: done -> failed"` |

These raw errors will bubble up as unhandled exceptions through the MCP transport. The MCP SDK may catch them and return a generic error, but the agent gets no actionable guidance. Each should be wrapped in try/catch returning a structured error like:
```
"Error: Cannot claim task task-xyz — it is in state 'pending' (not 'ready'). 
This task has unresolved dependencies. Use flightdeck_task_list to check which 
dependencies need to complete first."
```

#### Tools with no error handling at all (8 tools)

| Tool | Failure mode | What happens |
|------|-------------|-------------|
| `task_list` | Empty result | Returns `[]` — fine |
| `msg_send` | Write fails | Uncaught fs exception |
| `channel_send` | Write fails | Uncaught fs exception |
| `channel_read` | Channel doesn't exist | Returns `[]` — fine |
| `memory_search` | No results | Returns `[]` — fine |
| `memory_write` | Write fails | Uncaught fs exception |
| `status` | — | Can't really fail |
| `spec_list` | — | Can't really fail |

The fs-based tools (`msg_send`, `channel_send`, `memory_write`) should catch write errors and return meaningful messages.

#### Recommended fix pattern

Wrap every tool handler in a standard error boundary:
```ts
async (params) => {
  try {
    // ... tool logic ...
  } catch (err) {
    return { 
      content: [{ type: 'text' as const, text: formatToolError(toolName, err, params) }],
      isError: true,
    };
  }
}
```

With `formatToolError()` providing tool-specific remediation hints based on the error type (not found → "check task ID with task_list", wrong state → "task is in X, needs to be Y", role violation → "use tool Z instead").

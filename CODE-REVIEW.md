# Flightdeck 2.0 — Code Review

**Reviewer:** Claw (automated)  
**Date:** 2026-04-12  
**Codebase:** `packages/server` (~8,660 LOC), `packages/shared` (~460 LOC)  
**Test suite:** 45 test files (vitest)

---

## Executive Summary

**Health Score: 7.5 / 10**

Flightdeck 2.0 is a well-architected multi-agent orchestration engine with strong foundations: branded IDs, a proper state machine with side effects, clear module boundaries, and excellent test coverage (45 test files covering core, DAG, MCP, governance, storage, and more). The codebase is remarkably clean for its complexity — there's only one TODO in the entire project.

The main concerns are: (1) the CLI `start` command has grown into a 300-line god-function that wires the entire daemon, (2) path traversal risks in file operations, (3) the Orchestrator's `processCompletions()` is a no-op, and (4) duplicate `AcpAdapter` instances are created in the facade vs CLI startup path.

---

## Critical Issues (Must Fix)

### 1. Path Traversal in AcpAdapter File Operations
**File:** `packages/server/src/agents/AcpAdapter.ts:155-160`

The `readTextFile` and `writeTextFile` Client implementations use `path.resolve(session.cwd, params.path)` but never validate that the resolved path stays within the session's working directory. A malicious agent could read/write arbitrary files:

```ts
// Current (vulnerable):
const filePath = path.resolve(session.cwd, params.path);
await fs.writeFile(filePath, params.content, 'utf-8');

// An agent could request path = "../../../../etc/passwd"
```

**Fix:** Add a check that `path.resolve(session.cwd, params.path).startsWith(session.cwd)` before any file operation. Consider a `safePath()` utility.

### 2. Path Traversal in MemoryStore.write()
**File:** `packages/server/src/storage/MemoryStore.ts:54-57`

`MemoryStore.write(filename, content)` joins user-provided `filename` directly with `memoryDir`. An agent calling `flightdeck_memory_write` with `filename: "../../etc/cron.d/evil"` could write outside the memory directory.

**Fix:** Validate that `join(this.memoryDir, filename)` resolves inside `this.memoryDir`.

### 3. Auto-Approve All Permissions Is Dangerous
**File:** `packages/server/src/agents/AcpAdapter.ts:134-141`

```ts
async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  // Auto-approve all permissions (Flightdeck manages permissions at a higher level)
  const allowOption = params.options.find(o => o.kind === 'allow_always') ...
```

This blanket auto-approve means any agent can do anything the ACP protocol allows. The comment says "Flightdeck manages permissions at a higher level" but the MCP tool permission system only controls which *Flightdeck tools* an agent sees — it doesn't restrict what the agent does with its own terminal/filesystem capabilities.

**Fix:** Implement a permission policy that considers the agent's role. At minimum, log all permission grants. Consider denying `allow_always` and only granting `allow_once`.

---

## Important Issues (Should Fix)

### 4. Orchestrator.processCompletions() Is a No-Op
**File:** `packages/server/src/orchestrator/Orchestrator.ts:126-137`

The `processCompletions()` method has comments explaining what it should do, but the loop body is empty — it iterates `in_review` tasks but never does anything. The comment says "the Verifier calls dag.completeTask() directly" so this may be intentional dead code, but it's confusing and the method still runs every tick.

**Fix:** Either implement it or remove the method and document that verification handles completions.

### 5. Duplicate AcpAdapter Instantiation
**File:** `packages/server/src/facade.ts:63` and `packages/server/src/cli/index.ts:228`

The Facade constructor creates `new AcpAdapter()` to pass to the Orchestrator, then the CLI `start` command creates *another* `new AcpAdapter(undefined, 'copilot')`. The Facade's AcpAdapter is never used when running as a daemon.

```ts
// facade.ts:63
this.orchestrator = new Orchestrator(this.dag, this.sqlite, this.governance, new AcpAdapter(), config);

// cli/index.ts:228 — creates a completely separate adapter
const acpAdapter = new AcpAdapterClass(undefined, 'copilot');
```

**Fix:** Don't create an AcpAdapter in the Facade constructor. Let it be injected, or lazily created when `start` is called.

### 6. CLI `start` Command Is a 300-Line God Function
**File:** `packages/server/src/cli/index.ts:224-464`

The `case 'start'` block creates the HTTP server, WebSocket server, wires up event handlers, sets up CORS, implements 20+ REST endpoints, handles graceful shutdown, and more — all in one massive `case` block.

**Fix:** Extract into a `DaemonServer` class or at minimum a `startDaemon()` function with sub-functions for HTTP routing, WS setup, and shutdown handling.

### 7. MemoryStore.write() Triggers Full Reindex
**File:** `packages/server/src/storage/MemoryStore.ts:54-57`

Every call to `write()` calls `this.reindex()` which does `DELETE FROM memory_fts` then re-inserts every line from every `.md` file. This is O(total_lines_across_all_files) on every single write.

**Fix:** Implement incremental indexing — delete rows for the changed file, then re-insert only that file's lines.

### 8. Synchronous File I/O in MemoryStore
**File:** `packages/server/src/storage/MemoryStore.ts`

All file operations use `readFileSync`, `writeFileSync`, `readdirSync`, `statSync`, `existsSync`. Since MemoryStore is called from MCP tool handlers (which are async), this blocks the event loop during file operations.

**Fix:** Use async variants (`readFile`, `writeFile`, `readdir`, `stat`, `access`).

### 9. No Input Validation on `memory_write` Filename
**File:** `packages/server/src/mcp/server.ts:422-432`

The `flightdeck_memory_write` tool accepts a `filename` string with no validation beyond Zod's `z.string()`. No check for path separators, null bytes, or length limits.

**Fix:** Validate filename matches `/^[a-zA-Z0-9_-]+\.md$/` or similar safe pattern.

### 10. Event Listener Leak in AcpAdapter
**File:** `packages/server/src/agents/AcpAdapter.ts:277-280`

Each spawned session attaches `data` listeners to stdout/stderr and `close`/`error` listeners to the child process. When sessions end, these listeners are never explicitly removed. Node.js *should* clean them up on process GC, but if the `AcpSession` object is retained (it is — `this.sessions` is a Map that's never pruned), the child process handle stays alive.

**Fix:** Remove ended sessions from `this.sessions` after a delay, or at least remove listeners on the `'close'` event.

### 11. Missing `declare_subtasks` in Tool Permission Lists
**File:** `packages/server/src/mcp/toolPermissions.ts`

The `flightdeck_declare_subtasks` tool is registered in `server.ts` but doesn't appear in any role's tool list in `toolPermissions.ts`. It's only accessible when no role filtering is applied.

**Fix:** Add `flightdeck_declare_subtasks` to the `lead` and `planner` role tool lists.

### 12. `flightdeck_task_compact` Has No Permission Check
**File:** `packages/server/src/mcp/server.ts:302-314`

Unlike every other mutation tool, `flightdeck_task_compact` resolves the agent but never calls `checkPerm()`. Any registered agent can compact any task.

**Fix:** Add a `checkPerm(agent!, 'task_compact', ...)` call. Add the permission to `lead` role.

---

## Minor Issues (Nice to Fix)

### 13. Inconsistent Error Handling Style
Some tools have rich error messages with suggestions (e.g., `flightdeck_task_claim` at line 146), while others just pass through the raw error message (e.g., `flightdeck_task_cancel` at line 175). The rich error style is much better for agent UX.

### 14. `processCompletions()` and `processEffects()` Dead Code Path
**File:** `packages/server/src/dag/TaskDAG.ts:217-225`

Several `processEffects` cases are no-ops (`spawn_reviewer`, `escalate`, `notify_agent`, `update_dag`, `log_decision`). These should either be implemented or removed with a comment about planned implementation.

### 15. `(server as any)._registeredTools` Access
**File:** `packages/server/src/mcp/server.ts:944-950`

Per-role tool filtering accesses `_registeredTools` via `as any` — this is fragile and will break silently if the MCP SDK changes its internal structure.

**Fix:** Check if the MCP SDK exposes a public API for tool listing/removal. If not, pin the SDK version and add a test that catches breakage.

### 16. SessionManager Is Unused
**File:** `packages/server/src/agents/SessionManager.ts`

`SessionManager` appears to be an earlier/alternative implementation to `AcpAdapter`. It's imported in `Orchestrator.ts` as an optional parameter but never instantiated in the daemon startup. The `AcpAdapter` does everything it does plus ACP protocol support.

**Fix:** Consider removing `SessionManager` if it's fully superseded, or document it as the "simple/pty" backend.

### 17. Hardcoded Port 3000
**File:** `packages/server/src/cli/index.ts`

The CLI `chat`, `pause`, and `resume` commands default to port 3000 but parse port from `(values as any).port` — the `port` option isn't declared in `parseArgs({ options })`, so it silently never works.

**Fix:** Add `port: { type: 'string', short: 'P' }` to the parseArgs options.

### 18. `cost_report` Permission Check Is Ad-Hoc
**File:** `packages/server/src/mcp/server.ts:489-492`

Instead of using the standard `checkPerm()` pattern, the cost report tool checks `agent_spawn` permission as a proxy for "lead-level access". This is confusing and could allow a non-lead role with `agent_spawn` to access cost reports.

**Fix:** Add a dedicated `cost_report` permission to the role registry.

### 19. Stale `retrospectivesDone` Set
**File:** `packages/server/src/orchestrator/Orchestrator.ts:20`

The `retrospectivesDone` Set grows unboundedly. In a long-running daemon with many specs, this leaks memory (though slowly).

**Fix:** Clear entries after some time, or use spec ID + completion timestamp as a bounded structure.

### 20. `interpolateArgs` Duplicated
**Files:** `packages/server/src/agents/AcpAdapter.ts:56-62`, `packages/server/src/agents/SessionManager.ts:47-53`

The same function is defined in two places.

**Fix:** Extract to a shared utility.

---

## Positive Observations

### Excellent Type Safety
Branded ID types (`TaskId`, `AgentId`, `SpecId`, etc.) prevent mixing up string IDs. The state machine in `shared/core/types.ts` with explicit valid transitions and side effects is a textbook implementation — clean, testable, and correct.

### Comprehensive Test Suite
45 test files covering the core state machine, DAG operations, MCP tools, governance, storage, compaction, subtasks, role filtering, display, and more. This is impressive coverage for a project of this size.

### Clean Module Boundaries
The facade pattern works well. Each module has a clear responsibility:
- `dag/` — task graph + state transitions
- `storage/` — persistence (SQLite, specs, decisions, memory)
- `governance/` — policy engine
- `orchestrator/` — tick loop
- `lead/` — lead agent management
- `agents/` — agent lifecycle
- `mcp/` — MCP tool surface

### Well-Designed Permission System
The role-based tool filtering (`toolPermissions.ts`) is elegant — each role only sees relevant tools, reducing context waste and misuse. The dual-layer approach (tool visibility + runtime permission checks) provides defense in depth.

### Thoughtful State Machine
11 task states with 24 valid transitions, each emitting typed side effects. The `transition()` function is pure and testable. Side effects are declarative, not imperative.

### Good Error Messages for Agents
The MCP tool error messages include suggestions ("Use flightdeck_task_list() to see available tasks") and role-specific guidance. This significantly helps LLM agents self-correct.

### Single TODO in Entire Codebase
Only one TODO (`cli/index.ts:244` — ACP session/load for session recovery). Everything else is either implemented or consciously deferred with no-op comments.

### Smart Design Choices
- FTS5 for memory search with BM25 ranking
- WAL mode for SQLite
- Prompt queue system in AcpAdapter to prevent interleaving
- Heartbeat conditions (tasks_completed, idle_duration, time_window) are compositional

---

## Recommendations

1. **Security: Path validation** — Add a `safePath(base, userInput)` utility and use it in AcpAdapter file ops and MemoryStore. This is the highest-priority fix.

2. **Architecture: Extract DaemonServer** — The CLI `start` command should be a class. This is the single biggest maintainability win.

3. **Performance: Incremental memory indexing** — Replace the full reindex with file-scoped updates.

4. **Cleanup: Remove or document dead code** — `processCompletions()`, unused `SessionManager`, no-op side effects.

5. **Security: Add filename validation** — For `flightdeck_memory_write` and any other file-creation tools.

6. **Testing: Add AcpAdapter integration test** — The adapter is the most complex module (816 LOC) and handles process lifecycle, ACP protocol, and terminal management. A mock-based integration test would catch regressions.

7. **Observability: Add structured logging** — The codebase has minimal logging. A structured logger (pino, winston) would help debug production issues in the daemon.

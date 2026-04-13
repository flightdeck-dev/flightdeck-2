# Flightdeck 2.0 Code Review

## Critical (must fix)

- **[AcpAdapter.ts:~135] SIGINT/SIGTERM handler calls `process.exit()` synchronously, preventing graceful shutdown.** The `registerCleanup` method adds `process.once('SIGINT')` and `process.once('SIGTERM')` handlers that call `process.exit()` immediately after cleanup. But `gateway.ts` also registers its own SIGINT/SIGTERM handlers for state persistence. Since `AcpAdapter` uses `process.once`, its handler fires first and calls `process.exit()` before the gateway's handler can save session state. **Fix:** Remove `process.exit()` from AcpAdapter's signal handlers — let the gateway (or whoever owns the process lifecycle) handle exit.

- **[AcpAdapter.ts:~512] `sendPrompt` → `drainQueue` → `sendPrompt` recursive call can stack overflow.** If messages keep arriving while prompts are in-flight, `drainQueue` calls `sendPrompt` which calls `drainQueue` again. While the queue check prevents infinite loops in practice, a burst of steer messages during a long prompt could cause deep recursion. **Fix:** Use a loop instead of recursion in `drainQueue`.

- **[Orchestrator.ts:~330] `detectStalls` modifies task state without DAG adjacency updates.** When a session ends, the orchestrator calls `this.dag.failTask()` then `this.dag.retryTask()`. But between these two calls, the `failTask` emits `block_dependents` effects that may mark dependents as blocked. Then `retryTask` sets the task back to `ready` but the blocked dependents are not unblocked. **Fix:** Either use a single atomic `retryAfterStall` operation or ensure dependents are re-evaluated after retry.

- **[mcp/server.ts:~1075] `projectStore` variable used but never declared.** The `flightdeck_isolation_status` tool references `projectStore` which doesn't exist in scope — it should be `fd.project` or similar. This will throw a `ReferenceError` at runtime. **Fix:** Replace `projectStore.get()` with `fd.project.getConfig()` (or the appropriate accessor).

- **[gateway.ts:~248] SIGUSR1 hot-reload restarts `fd.orchestrator` (the Facade's original) instead of the newly created `orchestrator`.** The gateway creates a _new_ `Orchestrator` instance per project but the `SIGUSR1` handler restarts `fd.orchestrator` (the one from the Facade constructor). These are different objects, so hot-reload restarts a stale orchestrator that lacks `leadManager`, `wsServer`, etc. **Fix:** Store the active orchestrator instances and restart those instead.

## High (should fix)

- **[AcpAdapter.ts:~305] `resumeSession` doesn't inject `FLIGHTDECK_AGENT_*` env vars.** Unlike `spawn()`, `resumeSession()` passes raw `process.env` without `FLIGHTDECK_AGENT_ID`, `FLIGHTDECK_AGENT_ROLE`, or `FLIGHTDECK_PROJECT`. This means MCP tool filtering and agent identification won't work for resumed sessions.

- **[TaskDAG.ts:~350] `declareTasks` creates tasks as `ready` then downgrades to `pending` — triggers incorrect state-machine effects.** Tasks are initially created via `addTask` (which sets state to `ready` if no deps), then separately checked and set to `pending` via `store.updateTaskState`. This bypasses the state machine's `transition()` function and skips any effects that should fire.

- **[Orchestrator.ts:~177] `processReview` `catch` block silently swallows errors.** If the review spawn or processing fails, the `.catch(() => {})` means the task stays in `in_review` forever with no visibility into the failure. At minimum, log the error.

- **[SqliteStore.ts:~migrate] Migration ALTER TABLE failures silently caught.** The `try { ALTER TABLE ... } catch {}` pattern means any migration error (not just "column already exists") is silenced. A schema corruption or disk error would be invisible. **Fix:** Check the error message for "duplicate column" specifically.

- **[gateway.ts:~shutdown] `process.exit(0)` in shutdown prevents Node's cleanup.** Calling `process.exit()` in the shutdown handler prevents pending I/O (like SQLite WAL flushing) from completing. **Fix:** Let the process exit naturally after cleanup, or use `process.exitCode = 0` and close the event loop.

- **[LeadManager.ts:~heartbeat] Heartbeat timer uses `setInterval` with async `steerLead` but no guard against overlapping ticks.** If `steerLead` takes longer than the heartbeat interval, multiple heartbeats will fire concurrently, potentially overwhelming the agent with duplicate steers.

- **[mcp/server.ts] `flightdeck_task_get` referenced in `ROLE_TOOLS` but never registered.** The planner and reviewer roles list `flightdeck_task_get` as an available tool, but no such tool is defined in `createMcpServer`. Those roles will have a phantom tool in their allowed list.

- **[Orchestrator.ts:~autoAssignReadyTasks] Agent matching only finds first idle agent with matching role.** Once an agent is found and marked `busy` in SQLite, its in-memory `agents` array still shows `idle` for that tick (since `agents` was fetched once). Multiple tasks with the same role will try to claim the same agent. **Fix:** Remove matched agents from the pool after assignment.

## Medium (improve)

- **[AcpAdapter.ts] Sessions map grows unboundedly.** Ended sessions are never removed from `this.sessions`. Over a long-running daemon, this leaks memory proportional to total sessions ever created. **Fix:** Remove sessions from the map on `kill()` or after a TTL.

- **[SqliteStore.ts] No database connection pooling or WAL mode.** SQLite defaults to journal mode `delete` which is slower under concurrent reads. WAL mode would improve performance for the daemon's read-heavy workload. **Fix:** Add `PRAGMA journal_mode=WAL` in constructor.

- **[Orchestrator.ts:~retryCount] `retryCount` is in-memory only.** If the daemon restarts, retry counts are lost, allowing tasks to be retried more times than `maxRetries`. **Fix:** Persist retry count in SQLite (e.g., on the task row).

- **[gateway.ts:~uncaughtException] `unhandledRejection` handler calls `process.exit(1)`.** Since Node 15+, unhandled rejections already cause exit. The explicit handler is fine but should consider whether all rejections truly warrant immediate crash (some may be transient network errors).

- **[AcpAdapter.ts:~writeTextFile] Path traversal partially mitigated but not fully.** The lead/planner write restriction checks `path.relative()` but doesn't prevent symlink traversal. A symlink inside `.flightdeck/` could point outside the project. Worker role has no path restrictions at all. **Fix:** For workers, at minimum restrict writes to within the session `cwd` using `realpath`.

- **[HttpServer.ts] No rate limiting on API endpoints.** The `/messages POST` endpoint steers the Lead agent synchronously, which is expensive. An attacker (or buggy client) could flood it. **Fix:** Add basic rate limiting.

- **[mcp/server.ts:~skillManager] `SkillManager` is instantiated with `process.cwd()` at module level.** This is the gateway's cwd, not the project's cwd. Skills for different projects would all resolve against the same directory.

- **[TaskDAG.ts:~deriveEpicState] Missing import for `TaskState`.** `deriveEpicState` return type references `TaskState` but it's not in the import list. This likely works due to TypeScript's structural typing but is technically incorrect.

- **[Orchestrator.ts:~checkSpecChanges] `type: 'spec_changed' as any` cast.** The `spec_changed` event type isn't in the `LeadEvent` union. The `as any` hides a type error — this event should be added to the union properly.

- **[gateway.ts] `wireWsToLead` has fire-and-forget async calls with no backpressure.** Multiple rapid user messages will spawn concurrent `steerLead` calls that may arrive out of order. The Lead agent may get confused by interleaved conversations.

## Low (nice to have)

- **[mcp/server.ts:~1070] `flightdeck_tools_available` accesses private `_registeredTools`.** This is fragile — SDK internal changes could break it. Consider maintaining a separate tool name list.

- **[mcp/server.ts] Role filtering deletes from private `_registeredTools` object.** This mutates SDK internals and could cause issues if the server object is reused or inspected later.

- **[AcpAdapter.ts:~kill] 10-second SIGKILL fallback uses `setTimeout` without clearing.** If the process exits quickly after SIGTERM, the timeout still fires and tries to SIGKILL a dead process. Minor but noisy.

- **[SqliteStore.ts] `close()` uses `(this._db as any).$client.close()`.** Fragile cast — would break if Drizzle changes internals. Consider exposing the raw DB handle properly.

- **[facade.ts:~constructor] `Flightdeck` creates its own `AcpAdapter` if none provided.** The gateway also creates one. When `Flightdeck` is used standalone (e.g., MCP server), it creates an adapter that's never used for spawning. Minor resource waste.

- **[Orchestrator.ts] `specMilestonesSent` map never pruned.** Unlike `retrospectivesDone`, this map grows indefinitely. Low impact since spec count is typically small.

- **[mcp/server.ts] Repetitive error-handling pattern across 20+ tool handlers.** Consider a wrapper function that handles `resolveAgent` + `checkPerm` + try/catch boilerplate.

- **[LeadManager.ts:~buildSteer] No `spec_changed` case in switch.** The `buildSteer` method handles all `LeadEvent` types except `spec_changed`, which falls through to produce an empty steer message. This matches the `as any` cast in the Orchestrator.

- **[ReviewFlow.ts:~buildReviewPrompt] Contains an erroneous eslint-disable comment inside a template string.** Line `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type not available` appears inside the review prompt sent to the agent, which is confusing for the reviewer agent.

## Summary

- **5 critical**, **8 high**, **10 medium**, **9 low** issues found

### Key patterns/themes
1. **Signal handler conflicts** — AcpAdapter and gateway both register signal handlers with conflicting behavior (process.exit vs. graceful shutdown)
2. **Silent error swallowing** — Multiple `catch {}` blocks hide real failures, especially in migrations, review processing, and async operations
3. **In-memory state not persisted** — Retry counts, session maps, and milestone tracking are lost on restart
4. **Race conditions in async flows** — Heartbeat overlap, auto-assignment double-booking, and steer message ordering
5. **Missing variable/tool declarations** — `projectStore` undefined, `flightdeck_task_get` never registered
6. **`as any` casts hiding type mismatches** — Several legitimate type errors papered over with casts

### Recommended priority order for fixes
1. **`projectStore` ReferenceError** (instant crash on tool call)
2. **SIGUSR1 hot-reload targeting wrong orchestrator** (breaks hot-reload entirely)
3. **Signal handler conflict** (breaks session state persistence on shutdown)
4. **`detectStalls` blocked dependents not unblocked after retry** (tasks stuck permanently)
5. **`resumeSession` missing env vars** (session recovery broken for MCP tools)
6. **Auto-assign double-booking** (multiple tasks assigned to same agent)
7. **Review error swallowing** (tasks stuck in `in_review` with no diagnostics)
8. **Heartbeat overlap guard** (Lead agent overwhelmed)

## Iteration 1 — 2026-04-14

### Observed
- Lead claims it assigned worker `agent-cada41b10c50` to task `task-7f210b97ab93`
- But task state remains `ready` with `assignedAgent: null`
- Worker is `idle` with no ACP session (acpSessionId: null)
- Two workers were spawned but neither has an active ACP session
- The old task `task-3e429727525d` also went from `paused` back to `ready` with null assignee

### Expected
- Lead should have used `task_claim` MCP tool to actually claim/assign the task
- Worker should have been given an ACP session to execute work
- Task state should be `in_progress` with the worker assigned

### Root Cause
- Lead likely used `spawn_worker` but didn't follow up with `task_claim` to actually bind task→agent
- Workers are spawned as agent records but orchestrator doesn't auto-provision ACP for idle workers
- Lead may be hallucinating tool calls (saying it did something without actually calling the tool)

### Fix
- Investigate: Does Lead have access to `task_claim` and `task_assign` tools?
- Check if the orchestrator should auto-assign ready tasks to idle workers
- Consider: should spawn_worker automatically claim the specified task?

### Updated Root Cause Analysis
**The MCP subprocess (`flightdeck-mcp.mjs`) doesn't have an AgentManager.**

When Lead calls `flightdeck_agent_spawn` via MCP stdio:
1. MCP binary calls `createMcpServer(projectName)` — passes a string
2. `opts.agentManager` is undefined → `agentManager = null`
3. The tool hits the fallback path (server.ts:487) which only inserts a DB record
4. Worker gets `acpSessionId: null`, `status: 'idle'` — a ghost record
5. No actual ACP process is spawned

**Only the gateway HTTP server** has access to AgentManager (via Flightdeck facade).

### Possible Fixes
1. **HTTP relay**: MCP tool calls HTTP POST to gateway's `/api/projects/:name/agents/spawn`
   - Requires adding a spawn endpoint to HttpServer
   - MCP subprocess needs to know the gateway URL (env var or config)
2. **Shared AgentManager**: Pass agentManager to MCP server when spawned from gateway
   - Problem: MCP runs as separate stdio process, can't share objects
3. **Event/queue**: MCP writes a "spawn request" to SQLite, gateway polls and spawns
   - More complex but decoupled

## Iteration 2 — 2026-04-14

### Fix Applied
Moved `FLIGHTDECK_URL` env var setting from `httpServer.listen` callback to BEFORE the project loop where agents are spawned. The MCP subprocess inherits env from its parent ACP process (`...process.env` in AcpAdapter.spawn), so it now has `FLIGHTDECK_URL` available for the relay.

### Verification
- Workers now spawn with real ACP sessions:
  - `agent-b6dc086c3e05`: worker, busy, acp=acp-e2bc4034 ✅
  - `agent-d77ca8a5653c`: worker, busy, acp=acp-54f83ce6 ✅
- Task `task-36a39724164a` state: `running` with assigned agent ✅
- Task `task-8888e1f9a231` state: `in_review` ✅
- 702 tests all green ✅

### Root Cause of Iteration 1 failure
`FLIGHTDECK_URL` was set in the `httpServer.listen()` callback, AFTER Lead/Planner were already spawned. The MCP subprocess inherited the env at spawn time — before the URL was set. Fix: set env var before the spawn loop.

## Iteration 3 — 2026-04-14 (confirmation run)

### Test Setup
- Clean daemon start with --no-recover
- Created 2 tasks simultaneously (slugify utility + version endpoint)
- Asked Lead to spawn workers for both

### Results — Relay Confirmed ✅
All 4 agents had real ACP sessions:
- Lead: acp-112306e1
- Planner: acp-f70f732f
- Worker 1 (agent-e76de2ea9729): acp-b3f32ddc — assigned to slugify task
- Worker 2 (agent-45a025e87202): acp-2ce7b438 — assigned to version endpoint task

### Task Lifecycle
- task-735cf5bfdbc8 (slugify): ready → running → in_review → failed
- task-72af808f5102 (version): ready → running → failed
- task-8888e1f9a231 (README relay): done ✅

### Observations
1. **HTTP relay works** — workers spawn with real ACP sessions, no more ghosts
2. **Lead correctly spawns 2 workers in one response** — parallel dispatch works
3. **Task failures are worker-level** — not relay issues. Workers failed during code execution (likely cwd/compilation issues)
4. **Previous session's tasks persist in DB** — old tasks from iterations 1-2 still visible with old agent IDs (orphaned references since --no-recover purges agents)

### Follow-up Issues (not relay-related)
- Worker code execution failures need investigation (separate from relay fix)
- Old task records with orphaned agent references could be cleaned up
- Consider adding task cleanup to --no-recover flag

## Iteration 4 — 2026-04-14 (full skill cycle with DEBRIEF)

### Test Setup
- Clean daemon, --no-recover
- Single task: "Add task priority sorting to task_list" (task-fac0bd3c5d78)
- Full skill cycle: TEST → OBSERVE → DEBRIEF → DOCUMENT

### OBSERVE Results
- Relay works: all workers spawned with real ACP sessions ✅
- Target task went running → failed
- Lead spawned 6 workers total (!!) — picked up old stale tasks from previous sessions
- Old tasks (hello world, health-check) still have orphaned agent IDs from purged agents
- Memory usage: 9.3GB / 31GB — 8-10 Copilot processes running

### DEBRIEF — Lead's Perspective (key insights)
1. **flightdeck_agent_spawn worked correctly** — returned proper JSON with acpSessionId
2. **Lead auto-retried old failed tasks** — saw 2 failed + 3 orphaned tasks, spawned workers for all of them without being asked. "Overzealous."
3. **flightdeck_msg_inbox failed** — Lead guessed its ID as "lead" instead of its actual agent-cd513d8401fd. Minor friction.
4. **Spawning workers for already-assigned tasks succeeded silently** — no warning about duplicate assignment
5. **Lead's #1 request: task staleness detection** — auto-mark tasks as "orphaned" when assigned agent doesn't exist

### Issues Found
1. **[NEW] --no-recover doesn't clean stale tasks** — purges agents but leaves tasks with orphaned assignees. Lead sees them and wastes resources.
2. **[NEW] No duplicate assignment guard** — can spawn worker for a task that's already running under another agent
3. **[NEW] Agent ID discovery friction** — Lead has to call agent_list to find its own ID for msg_inbox
4. **[CONFIRMED] Worker task execution failures** — workers keep failing at actual code changes (separate investigation needed)

### Proposed Fixes (priority order)
1. Add orphan detection: on startup with --no-recover, reset tasks assigned to purged agents back to "ready" or mark them "orphaned"
2. Guard agent_spawn: warn if task already has an assigned active agent
3. Inject agent ID as env var so Lead knows its own ID without calling agent_list (already done via FLIGHTDECK_AGENT_ID!)

### Fix Applied
Added `SqliteStore.resetOrphanedTasks()` — after purging offline agents, reset running/in_review/claimed tasks whose assignedAgent no longer exists back to 'ready'.

### Verify
- 706 tests, all green
- E2E: startup now shows "Reset 4 orphaned task(s) to ready"
- Tasks correctly reset: running→ready with null agent
- Done/failed tasks preserved (not touched)

### DEBRIEF Impact
This fix came directly from Lead's debrief answer. Lead said:
> "I should have asked for clarification or checked before assuming [old tasks] needed work. That was overzealous."
> "When a task is running but its assigned agent no longer exists, the system should auto-mark it as stale or orphaned."

Without the debrief step, I would have focused on worker execution failures (the symptom) instead of the orphan detection issue (the root cause of resource waste).

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

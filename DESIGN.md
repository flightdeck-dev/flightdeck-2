
## MCP Server Architecture (2026-04-17)

### Problem
MCP server (`flightdeck-mcp.mjs`) runs as a subprocess spawned by each agent.
It creates its own `new Flightdeck()` instance, directly accessing SQLite.
This causes:
- Two processes read/write the same DB with independent in-memory state
- DAG effectHandler (spawn_reviewer, etc.) only exists in gateway process
- Side effects from MCP calls (task_submit → spawn_reviewer) never fire
- Required orchestrator tick polling as a hack workaround

### Solution
MCP server should be a thin HTTP client to the gateway:

```
Agent → MCP server (stdio) → HTTP → Gateway (single source of truth) → SQLite
```

Benefits:
- Single data path, no state divergence
- All side effects fire correctly (effectHandler in gateway)
- No need for polling hacks in orchestrator
- Gateway auth already exists (token-based)

### Implementation
1. MCP server reads `FLIGHTDECK_URL` env (default: http://localhost:18800)
2. Each MCP tool maps to a gateway HTTP endpoint
3. Agent identity passed via `FLIGHTDECK_AGENT_ID` header
4. Remove `new Flightdeck()` from MCP server entirely

### Endpoints needed (already exist or trivial to add)
- POST /api/projects/:name/tasks/:id/claim → task_claim
- POST /api/projects/:name/tasks/:id/submit → task_submit
- POST /api/projects/:name/tasks/:id/complete → task_complete
- POST /api/projects/:name/tasks/:id/review → review_submit
- POST /api/projects/:name/tasks/:id/comment → task_comment
- GET  /api/projects/:name/tasks → task_list
- POST /api/projects/:name/escalate → escalate
- POST /api/projects/:name/messages → msg_send
- GET  /api/projects/:name/messages → msg_read

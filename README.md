# Flightdeck 2.0

A next-generation multi-agent orchestration engine with CLI and MCP server.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Modules

| Module | Purpose |
|--------|---------|
| `core/` | Domain types, branded IDs, data-driven state machine |
| `dag/` | Task DAG with dependency resolution, file conflict detection, compaction |
| `specs/` | Spec & plan layer with change proposals and traceability |
| `comms/` | Persistent messaging with priority, threading, coalescing |
| `agents/` | Agent lifecycle, role registry, crash detection, cost tracking |
| `verification/` | Cross-model review, blocking quality gates, independent validation |
| `events/` | Priority-aware event pipeline with back-pressure |
| `persistence/` | SQLite schema via drizzle-orm |
| `facade` | High-level API with SQLite persistence (used by CLI & MCP) |
| `cli/` | Command-line interface |
| `mcp/` | MCP server for AI agent integration |

## CLI Usage

Initialize a project:
```bash
npx tsx src/cli/index.ts init
```

Manage tasks:
```bash
flightdeck task add "Build auth" --role backend
flightdeck task list
flightdeck task start tk-abc123 --agent coder-1
flightdeck task complete tk-abc123
flightdeck task fail tk-abc123 --reason "tests failed"
flightdeck task gate tk-abc123 --await-type ci_check --await-id run-456
flightdeck task status        # DAG summary
flightdeck task topo          # topological order
```

Manage specs:
```bash
flightdeck spec create "Auth System"
flightdeck spec list
flightdeck spec show sp-abc123
flightdeck spec change propose sp-abc123
flightdeck spec change approve ch-abc123
```

Manage agents:
```bash
flightdeck agent register coder-1 --role backend
flightdeck agent list
flightdeck agent heartbeat coder-1
```

Messaging:
```bash
flightdeck msg send agent-1 "Deploy ready" --priority critical
flightdeck msg inbox agent-1
flightdeck msg list --thread mg-abc123
```

Verification:
```bash
flightdeck verify request tk-abc123 --reviewer agent-2
flightdeck verify decide rev-abc123 --verdict approve
```

System status:
```bash
flightdeck status
```

All commands support `--json` for machine-readable output.

## MCP Server Setup

Add to your MCP client config (e.g. OpenClaw, Claude Desktop):

```json
{
  "mcpServers": {
    "flightdeck": {
      "command": "npx",
      "args": ["tsx", "/path/to/flightdeck-2/src/mcp/server.ts"],
      "env": {
        "FLIGHTDECK_DB": "/path/to/project/.flightdeck/flightdeck.db"
      }
    }
  }
}
```

Available MCP tools:
- `flightdeck_task_add`, `flightdeck_task_list`, `flightdeck_task_complete`, `flightdeck_task_fail`, `flightdeck_task_gate`, `flightdeck_task_status`
- `flightdeck_spec_create`, `flightdeck_spec_list`
- `flightdeck_msg_send`, `flightdeck_msg_inbox`
- `flightdeck_verify_request`, `flightdeck_verify_decide`

## Library API

```typescript
import { Flightdeck } from '@flightdeck/core';

const fd = new Flightdeck({ dbPath: '.flightdeck/flightdeck.db' });

const task = fd.addTask({ title: 'Build auth', role: 'backend' });
fd.registerAgent('coder-1', 'backend');
fd.startTask(task.id, 'coder-1');
fd.completeTask(task.id);

console.log(fd.status());
fd.close();
```

Or use the lower-level modules directly:

```typescript
import { TaskDAG, SpecStore, AgentRegistry, VerificationEngine, EventBus } from '@flightdeck/core';

const dag = new TaskDAG();
const task = dag.addTask({ title: 'Build auth', description: '...', role: 'role-dev' as any });
dag.applyAction(task.id, 'start');
dag.applyAction(task.id, 'complete');
```

## Design Principles

1. **Data-driven state machine** — transition table as data, not scattered if-else
2. **Hash-based IDs** — conflict-free multi-agent task creation (from beads)
3. **Spec → Plan → Task traceability** — every task traces to a requirement
4. **Trust nothing** — cross-model review, fresh reviewer on retry, orchestrator validates
5. **Compaction** — completed tasks decay to summaries, saving context window
6. **File conflict detection** — tasks sharing files must have explicit dependencies

# Flightdeck 2.0

A next-generation multi-agent orchestration engine for AI coding agents with CLI, HTTP API, and MCP server.

> 📐 **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Deep dive into the system design, data flow, and module responsibilities.

## Architecture

```
User → Lead → Director → Orchestrator → Workers → Reviewers
```

- **Lead** 👑 — High-level decisions, user communication, plan approval
- **Director** 📋 — Task breakdown, conflict resolution, agent lifecycle
- **Orchestrator** — Event-driven auto-assignment, auto-spawning (500ms debounce)
- **Workers** 💻 — Implement code changes
- **Reviewers** 🔍 — Code review (pool reuse, fresh reviewer on retry)
- **Scout** 🔭, **QA Tester** 🧪, **Tech Writer** 📝, **Product Thinker** 💡

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
| `orchestrator/` | Event-driven orchestrator with auto-assign, auto-spawn, debounce |
| `isolation/` | File lock and git worktree isolation modes |
| `verification/` | Cross-model review, blocking quality gates, independent validation |
| `events/` | Priority-aware event pipeline with back-pressure |
| `persistence/` | SQLite schema via drizzle-orm (per-project, WAL mode) |
| `facade` | High-level API with SQLite persistence (used by CLI & MCP) |
| `cli/` | Command-line interface |
| `mcp/` | MCP server — thin HTTP client to gateway daemon |

## CLI Usage

Initialize a project:
```bash
npx tsx src/cli/index.ts init
```

Start the daemon:
```bash
flightdeck start
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
flightdeck providers        # list available runtimes
flightdeck providers --json
```

All commands support `--json` for machine-readable output.

## Supported Agent Runtimes

### ACP-Compatible

| Provider | Binary | Adapter | Notes |
|----------|--------|---------|-------|
| OpenAI Codex CLI 🤖 | `codex-acp` | acp | ACP bridge via @zed-industries/codex-acp |
| Zed Codex ACP | `codex-acp` | acp | Rust binary, model override via `-c` |
| Claude Agent (ACP) 🟠 | `claude-agent-acp` | acp | ACP wrapper for Claude Code |
| Gemini CLI 💎 | `gemini` | acp | Google's reference ACP implementation |
| OpenCode 🔓 | `opencode acp` | acp | Multi-model, open-source |
| Cursor | `agent acp` | acp | Cursor CLI with session/load support |
| Kiro CLI | `kiro-cli acp` | acp | Amazon/AWS coding agent |
| Kilo Code CLI | `kilocode-cli acp` | acp | 500+ models via OpenRouter |
| Hermes Agent | `hermes acp` | acp | Nous Research general-purpose agent |

### Non-ACP

| Provider | Adapter | Notes |
|----------|---------|-------|
| GitHub Copilot 🐙 | copilot-sdk | Native `@github/copilot-sdk` with direct tool injection |
| Claude Code 🟣 | pty | `--print` + `--resume` mode with session persistence |

List installed providers:
```bash
flightdeck providers
flightdeck providers --json
```

## MCP Server Setup

The MCP server is a thin HTTP client to the gateway daemon (no direct DB access).

```
Agent → MCP server (stdio) → HTTP → Gateway daemon (port 18800) → Flightdeck → SQLite
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "flightdeck": {
      "command": "npx",
      "args": ["tsx", "/path/to/flightdeck-2/packages/server/src/mcp/server.ts"],
      "env": {
        "FLIGHTDECK_AGENT_ID": "worker-1"
      }
    }
  }
}
```

## Library API

```typescript
import { Flightdeck } from '@flightdeck/core';

const fd = new Flightdeck('my-project');
// Data stored per-project in SQLite (WAL mode)

const task = fd.addTask({ title: 'Build auth', role: 'backend' });
fd.registerAgent('coder-1', 'backend');
fd.startTask(task.id, 'coder-1');
fd.completeTask(task.id);

console.log(fd.status());
fd.close();
```

## Isolation Modes

| Mode | Description |
|------|-------------|
| `file_lock` (default) | File-level locking prevents concurrent edits |
| `git_worktree` | Per-worker git worktrees for full isolation |

## Design Principles

1. **Data-driven state machine** — transition table as data, not scattered if-else
2. **Hash-based IDs** — conflict-free multi-agent task creation
3. **Spec → Plan → Task traceability** — every task traces to a requirement
4. **Trust nothing** — cross-model review, fresh reviewer on retry, orchestrator validates
5. **Compaction** — completed tasks decay to summaries, saving context window
6. **File conflict detection** — tasks sharing files must have explicit dependencies
7. **Event-driven orchestrator** — reactive task assignment with debounce
8. **Per-project SQLite** — no global state files, self-contained projects

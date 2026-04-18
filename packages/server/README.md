# @flightdeck-ai/flightdeck

Multi-agent orchestration platform for AI coding agents. Flightdeck coordinates multiple AI coding agents working on the same codebase — assigning tasks, managing context, resolving conflicts, and delivering results through a unified API and real-time dashboard.

## Architecture

Flightdeck uses a role-based hierarchy to coordinate work:

```
User → Lead → Planner → Orchestrator → Workers → Reviewers
```

- **Lead** 👑 — High-level decisions, user communication, plan approval
- **Planner** 📋 — Task breakdown, conflict resolution, agent lifecycle management
- **Orchestrator** — Event-driven auto-assignment and auto-spawning of workers (500ms debounce)
- **Workers** 💻 — Implement code changes
- **Reviewers** 🔍 — Code review with pool reuse (fresh reviewer on retry)
- **Additional roles:** Scout 🔭, QA Tester 🧪, Tech Writer 📝, Product Thinker 💡

## Supported Runtimes

| Runtime | Adapter | Binary | Notes |
|---------|---------|--------|-------|
| **GitHub Copilot** 🐙 | copilot-sdk | `copilot` | Native SDK integration, tool injection |
| **OpenAI Codex CLI** 🤖 | acp | `codex-acp` | ACP bridge via @zed-industries/codex-acp |
| **Zed Codex ACP** | acp | `codex-acp` | Rust binary, model override via `-c` |
| **Claude Code** 🟣 | pty | `claude` | `--print` mode with `--resume` session persistence |
| **Claude Agent (ACP)** 🟠 | acp | `claude-agent-acp` | ACP wrapper, Anthropic API billing |
| **Gemini CLI** 💎 | acp | `gemini` | Google's reference ACP implementation |
| **OpenCode** 🔓 | acp | `opencode acp` | Multi-model, open-source |
| **Cursor** | acp | `agent acp` | Cursor CLI, supports session/load |
| **Kiro CLI** | acp | `kiro-cli acp` | Amazon/AWS coding agent |
| **Kilo Code CLI** | acp | `kilocode-cli acp` | 500+ models via OpenRouter |
| **Hermes Agent** | acp | `hermes acp` | Nous Research, general-purpose agent |

Three adapter types:
- **ACP** — Agent Client Protocol over stdin/stdout (JSON-RPC nd-JSON)
- **PTY** — `--print` + `--resume` CLI mode
- **Copilot SDK** — Native `@github/copilot-sdk` with direct tool injection

## Key Features

- **Event-driven orchestrator** — Auto-assigns tasks, auto-spawns workers with 500ms debounce
- **Token usage tracking** — Per-agent, per-model cost tracking
- **Reviewer pool reuse** — Reviewers are recycled across reviews; fresh reviewer on retry
- **Plan approval workflow** — Tasks flow from `planned → pending` via explicit approval
- **Session persistence** — Copilot SDK sessions + Claude Code `--resume`
- **Per-project SQLite state** — No global state files; each project is self-contained (WAL mode)
- **File lock isolation** — Default isolation mode prevents file conflicts between agents
- **Git worktree isolation** — Alternative isolation via per-agent git worktrees
- **Real-time WebSocket dashboard** — Live progress, agent status, task state
- **Cross-model code review** — Writer ≠ reviewer model to prevent systematic blind spots
- **MCP server** — Expose orchestration to any MCP-compatible client

## Quick Start

```bash
npm install -g @flightdeck-ai/flightdeck

# Initialize a new project
flightdeck init

# Start the daemon (gateway server on port 18800)
flightdeck start

# Check status
flightdeck status

# List available providers
flightdeck providers
```

Or run from source:

```bash
cd packages/server
npx tsx src/cli/index.ts start
```

## Isolation Modes

| Mode | Description |
|------|-------------|
| `file_lock` (default) | File-level locking prevents concurrent edits to the same file |
| `git_worktree` | Each worker gets its own git worktree for full isolation |

## Documentation

- [Architecture](../../docs/ARCHITECTURE.md) — System design, data flow, module responsibilities
- [Code Review](../../docs/CODE-REVIEW.md) — Review process and guidelines
- [GitHub repository](https://github.com/justinchuby/flightdeck)

## License

Apache-2.0

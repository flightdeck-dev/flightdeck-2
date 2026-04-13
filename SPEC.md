# SPEC.md — Flightdeck 2.0 Feature Specification

## Core Architecture
- [x] Multi-agent orchestration engine (MCP + ACP)
- [x] SQLite persistence per project
- [x] Task DAG with state machine
- [x] Role-based tool permissions (7 roles)
- [x] Governance profiles (autonomous/collaborative/supervised)

## Gateway (was: daemon)
- [x] `flightdeck gateway start/stop/restart/status/run`
- [x] Multi-project: one gateway serves all projects
- [x] Session recovery on restart (gateway-state.json + ACP session/load)
- [x] Orphan process cleanup (uncaughtException handler)
- [ ] `--force` — kill existing process on port before starting
- [ ] `SIGUSR1` — hot reload config without killing agents
- [ ] `--bind` mode (loopback/lan/custom)
- [ ] Token auth (`--auth token`)
- [ ] `gateway health` / `gateway probe` CLI commands
- [ ] `gateway install` — systemd/launchd service install
- [ ] `--json` output on all query commands
- [ ] `gateway usage-cost` — blocked on cost tracking data

## Providers
- [x] Copilot CLI (`copilot --acp --stdio`)
- [x] Claude Code (`claude-agent-acp`)
- [x] Codex (`codex --message`)
- [x] Gemini (`gemini`)
- [x] Cursor (`agent acp`)
- [x] OpenCode (`opencode acp`)
- [x] Hermes Agent (`hermes acp`)
- [x] Kiro (`kiro-cli acp`)
- [x] Kilo Code (`kilocode-cli acp`)
- [x] Runtime registry (`runtimes.ts`)
- [x] `flightdeck providers` CLI command

## MCP Server
- [x] `flightdeck-mcp` bin entry (global command)
- [x] 49 MCP tools
- [x] Role-based tool filtering
- [x] E2E verified: daemon → copilot → flightdeck-mcp → SQLite

## Web UI
- [x] React 19 + Vite + Tailwind v4 (Notion/Linear style)
- [x] Dashboard: Kanban pipeline, Lead message, agent summary
- [x] Tasks: cards, DAG dependency tree, create modal, filters
- [x] Agents: status cards with pulse animation, token usage
- [x] Chat: markdown rendering (react-markdown + remark-gfm), typing indicator
- [x] Decisions: timeline view, category filters
- [x] Settings: display presets, model config
- [x] ⌘K command palette
- [x] Multi-project sidebar (Linear-style collapsible)
- [ ] Drag-and-drop Kanban
- [ ] Inline editing (click to edit fields)
- [ ] Keyboard shortcuts (L/P/A for label/priority/assign)
- [ ] Board/List/Timeline view switching
- [ ] Streaming response (show Lead typing in real-time)
- [ ] Tool call visualization (show what MCP tools Lead is using)

## TUI
- [x] Ink (React for terminal), 8 components
- [x] Three-column layout: Tasks | Chat/Activity | Agents
- [x] Keyboard-driven (Tab/j/k/t/c/a/q)
- [x] `/` command mode
- [x] WebSocket real-time updates

## Desktop App (Electron)
- [x] Shell: BrowserWindow loading Web UI
- [x] Auto-start/stop gateway on app open/close
- [x] System tray with status menu
- [x] Health check polling
- [x] electron-builder config (macOS/Windows/Linux)
- [ ] Auto-update
- [ ] Notifications (native OS)

## VSCode Extension
- [x] Skeleton: tasks sidebar, agents sidebar, status bar
- [ ] Full implementation

## CLI
- [x] `flightdeck init/status/task/agent/chat/models/display/report/log`
- [x] `flightdeck providers` — detect installed providers
- [x] `flightdeck tui` — launch terminal UI
- [x] `flightdeck gateway *` — gateway lifecycle
- [ ] Interactive chat mode (REPL)
- [ ] `flightdeck doctor` — diagnose setup issues

## Server Internals
- [x] Orchestrator tick loop with processCompletions/processEffects
- [x] LeadManager with heartbeat
- [x] AgentManager (spawn/terminate/list)
- [x] MemoryStore (async IO, incremental reindex)
- [x] WorkflowEngine (configurable pipelines)
- [x] ReviewFlow (cross-model verification)
- [x] DecisionLog + GovernanceEngine
- [x] DailyReport generation
- [x] TimerManager (agent-created timers)
- [x] SkillManager
- [x] ProjectManager (multi-project)

## Code Quality
- [x] ESLint: 0 errors, 0 warnings
- [x] 471+ tests
- [x] ARCHITECTURE.md
- [x] TIMEOUTS.md
- [x] CODE-REVIEW.md
- [x] CI: GitHub Actions (Ubuntu + Windows matrix)

## Claw Integration (OpenClaw skill)
- [x] `skills/flightdeck/` — HTTP API wrapper
- [x] `fd-api.sh` helper script
- [ ] WebSocket listener for real-time events
- [ ] Heartbeat integration (check Flightdeck status in Claw's heartbeat)

## Not Planned (design decisions)
- Path traversal protection — giving agents full file access intentionally
- Permission auto-approve — agents get full tool access, governance at project level
- npm publish — waiting for stable API

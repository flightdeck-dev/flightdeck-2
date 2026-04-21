# Contributing to Flightdeck

## Architecture

Flightdeck is a multi-agent orchestration platform. One gateway serves all projects.

```
User ↔ Web UI / CLI ↔ Gateway (HTTP + WebSocket)
                         ├── Lead (CEO — decides, delegates)
                         ├── Planner (breaks work into tasks)
                         ├── Workers (execute tasks)
                         └── Reviewers (review completed work)
```

### Packages

| Package | Purpose |
|---------|---------|
| `packages/server` | Gateway, adapters, orchestrator, MCP tools, HTTP API |
| `packages/web` | React dashboard (Vite + Tailwind) |
| `packages/shared` | Types, IDs, constants shared across packages |
| `packages/vscode` | VSCode extension |
| `packages/tui` | Terminal UI (Ink) |

### Key files

| File | What it does |
|------|-------------|
| `server/src/cli/gateway.ts` | Gateway startup, WS wiring, adapter setup |
| `server/src/lead/LeadManager.ts` | Lead + Planner lifecycle, steer routing |
| `server/src/agents/AgentManager.ts` | Agent spawn/terminate/hibernate/wake |
| `server/src/agents/CopilotSdkAdapter.ts` | Copilot SDK integration (tools, streaming) |
| `server/src/agents/AcpAdapter.ts` | ACP protocol adapter |
| `server/src/orchestrator/Orchestrator.ts` | Task assignment, tick loop |
| `server/src/api/HttpServer.ts` | All HTTP endpoints |
| `server/src/comms/MessageStore.ts` | Chat + DM persistence |
| `server/src/config/GlobalConfig.ts` | Global config (~/.flightdeck/v2/config.yaml) |
| `server/src/agents/runtimes.ts` | Runtime registry + custom runtime loading |
| `server/src/agents/copilotSdkEventMapper.ts` | SDK event → WS broadcast mapping |
| `docs/agent-state-machine.md` | Agent state transitions |

## Rules

### Agent states

5 states: `idle`, `busy`, `hibernated`, `errored`, `retired`. No `offline`.

- `onSessionTurnStart` → busy. `onSessionTurnEnd` → idle. Single source of truth.
- Spawn marks `idle`, not `busy`. Actual steer triggers busy.
- Terminate → `hibernated` (session may be resumable).
- One active Lead + one active Planner per project. Spawn retires old ones.

### Config

One global config: `~/.flightdeck/v2/config.yaml`. No `global-config.json`.

Project config: `~/.flightdeck/v2/projects/{name}/.flightdeck/config.yaml`.

### API conventions

- Global endpoints: `/api/xxx` (runtimes, registry, config, custom-runtimes, logs)
- Project endpoints: `/api/projects/:name/xxx` (agents, tasks, messages, specs)
- Don't mix them. Custom runtimes are global, not per-project.

### Tool names

- Canonical source: `server/src/agents/toolNames.ts`
- MCP server and CopilotSdkAdapter must define the same tool set
- Test: `tests/agents/tool-name-sync.test.ts` verifies parity
- Role permissions: `server/src/mcp/toolPermissions.ts`

### Messaging

- Main chat: `channel: null` (user ↔ Lead)
- DMs: `channel: dm:{agentId}` (agent ↔ agent)
- `GET /messages` excludes DMs. `GET /messages?channel=dm:xxx` for DMs.
- `POST /messages/send` routes DMs and steers the target agent.
- `POST /messages` is for user → Lead only.

### Streaming (Copilot SDK)

- Set `streaming: true` in SessionConfig for delta events
- Event mapping: `copilotSdkEventMapper.ts`
- Key events: `assistant.message_delta` (text), `assistant.reasoning_delta` (thinking), `tool.execution_start/complete`
- Field: `data.deltaContent` (not `data.content`)
- All three adapters wire `onSessionTurnStart/End` in gateway.ts

### Lead behavior

- CEO mode: delegate immediately, never execute
- No shell commands, no file reads, no spec writing
- `flightdeck_send` to Planner for all work requests
- Doesn't see cost/token info (stripped from flightdeck_status)

### Testing

- All tests: `pnpm --filter @flightdeck-ai/flightdeck test`
- Single file: `npx vitest run tests/path/to/test.ts`
- tsc: `npx tsc --noEmitOnError false` (server), `npx tsc --noEmit` (web)
- Web build: `npx vite build` (in packages/web)
- **No "pre-existing" failures.** All issues are our responsibility. Fix them.

### Code style

- TypeScript strict mode
- ESM imports with `.js` extension
- `console.error` for server logs (tee'd to gateway.log)
- Structured logging: `log('Component', 'message')` from `utils/logger.ts`
- CSS variables for theming: `var(--color-*)`. No hardcoded colors.
- No markdown tables in Discord/WhatsApp UI — use bullet lists.

### Cross-platform

- `commandExists()` from `utils/platform.ts` instead of `which`
- `path.join()` / `homedir()` for paths, never hardcode `/`
- Windows service support: TODO (schtasks)

### When adding a new runtime

1. Add to `RUNTIME_REGISTRY` in `runtimes.ts` with `registryId`
2. Or let users add via `config.yaml` `customRuntimes` section
3. All custom runtimes go through ACP adapter
4. `loadCustomRuntimes()` loads from config, tracks in `customRuntimeIds` Set
5. Removing from config removes from registry on next reload

### When adding a new MCP/SDK tool

1. Add to `toolNames.ts` (canonical source)
2. Add to `mcp/server.ts` (MCP version)
3. Add to `CopilotSdkAdapter.ts` `buildTools()` (SDK version)
4. Add to `mcp/toolPermissions.ts` for appropriate roles
5. Run `tests/agents/tool-name-sync.test.ts` to verify parity

### When changing agent state logic

1. Update `docs/agent-state-machine.md`
2. Update `AgentManager.ts` or `LeadManager.ts`
3. Check all `insertAgent` / `updateAgentStatus` call sites (they're scattered)
4. Update `AGENT_STATUSES` in `shared/src/core/types.ts` if adding/removing states
5. Update VSCode extension types

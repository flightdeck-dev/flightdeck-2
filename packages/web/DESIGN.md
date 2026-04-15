# Flightdeck Web UI — Design Document

## Design Philosophy

Notion-inspired, minimal and clean. Content-first with subtle borders and muted colors. No heavy shadows, no gradients. Information density over decoration.

## Theme System

CSS custom properties with light/dark mode via `.dark` class.

### Colors
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--color-surface` | `#ffffff` | `#191919` | Page background |
| `--color-surface-secondary` | `#f7f7f5` | `#202020` | Cards, sidebar, code blocks |
| `--color-surface-hover` | `#f1f1ef` | `#2a2a2a` | Hover states, active nav |
| `--color-border` | `#e8e8e5` | `#2e2e2e` | All borders |
| `--color-text-primary` | `#37352f` | `#e3e3e0` | Body text |
| `--color-text-secondary` | `#787774` | `#9b9b97` | Labels, metadata |
| `--color-text-tertiary` | `#b4b4b0` | `#5a5a58` | Placeholders, disabled |

### Status Colors (shared across themes)
| Token | Color | Usage |
|-------|-------|-------|
| `--color-status-ready` | `#2f80ed` | Ready tasks, primary actions |
| `--color-status-running` | `#d97706` | Busy agents, running tasks |
| `--color-status-in-review` | `#9333ea` | In-review state |
| `--color-status-done` | `#16a34a` | Completed, idle agents |
| `--color-status-failed` | `#dc2626` | Errors, terminate buttons |
| `--color-status-cancelled` | `#9ca3af` | Offline, cancelled |

### Typography
- **Sans**: Inter → system-ui fallback
- **Mono**: JetBrains Mono → ui-monospace fallback

## Icons

[Lucide React](https://lucide.dev/) with `strokeWidth={1.5}` for refined look.

| Context | Icon | Size |
|---------|------|------|
| Sidebar nav | `LayoutDashboard`, `MessageSquare`, `ListTodo`, `Bot`, `Scale`, `Settings` | 16 |
| Agent roles | `Crown` (lead), `Code` (worker), `Search` (reviewer), `ClipboardList` (planner) | 20 |
| Tool calls | `Settings` (flightdeck_*), `Terminal` (shell), `FileText` (file), `Search` (search), `Wrench` (default) | 14 |
| Actions | `Plus`, `Send`, `ChevronDown`/`Up`/`Left`/`Right` | 14–18 |

## Layout

```
┌──────────┬──────────────────────────────────┐
│ Sidebar  │           Main Content           │
│ (w-56)   │         (max-w-5xl)              │
│          │                                  │
│ Projects │  ┌────────────────────────────┐  │
│  ▸ proj  │  │     Page Component         │  │
│    Dashboard│  │                          │  │
│    Chat   │  │                            │  │
│    Tasks  │  │                            │  │
│    Agents │  └────────────────────────────┘  │
│    Decisions                                 │
│          │                                  │
│ Settings │                                  │
│ Agent ●  │                                  │
└──────────┴──────────────────────────────────┘
```

- **Sidebar** (`w-56`, collapsible to `w-12`): project tree nav + settings + agent status summary
- **Main**: scrollable content area, `max-w-5xl` for readability
- Sidebar highlights active page with `bg-[var(--color-surface-hover)]` + `font-medium`

## Pages

### Dashboard
- **Summary cards**: task stats (pending/ready/running/done/failed), agent count, total cost
- **Active Agents**: compact list of busy/idle agents with role icon + status dot + current task
- **Recent Activity**: task state transitions

Agent status filtering: hides `offline`, `suspended`, `hibernated`, `retired`, `terminated`, `ended`.

### Chat
- **Message list**: user messages right-aligned (blue bubble), Lead messages left-aligned (no bubble, clean text)
- **Streaming**: real-time token streaming via WebSocket `chat:stream` events
- **Display modes** (configurable in Settings):
  - **Minimal**: text only
  - **Summary**: thinking collapsed, tool calls one-line
  - **Detailed**: thinking + tool calls expanded
  - **Debug**: same as detailed (flightdeck tools shown)
- **Thinking blocks**: `🧠` icon, gray italic, truncated with expand
- **Tool call cards**: merged `tool_call` + `tool_call_update` by `toolCallId`. Smart icons by tool type. Summary = one-line expandable, Detailed = open `<details>`
- **Threads**: sidebar panel for thread navigation
- **IME safe**: `isComposing` check prevents Chinese/Japanese input from triggering send on Enter

### Tasks
- **Filter bar**: All / pending / ready / running / in_review / done / failed / cancelled
- **TaskCard**: expandable card with title, ID, state badge, assigned agent, priority indicator
  - Expanded: description, claim, dependencies tree, **comments list**, comment input
  - Comments filtered from global messages by `taskId`
  - Comment sends via WebSocket `task:comment`, Lead auto-responds
- **Create Task modal**: title, description, role selector, priority

### Agents
- **Grid layout**: 1–3 columns responsive
- **AgentCard**: role icon, agent ID (mono), status badge (animated pulse for busy), current task, model/runtime/cost stats
- **Actions**: Interrupt + Terminate buttons
- **Output Panel** (WIP): click card to expand, shows real-time agent output via WebSocket `agent:stream`
- **Terminated section**: collapsed `<details>`, 60% opacity

### Decisions
- Decision log entries with verdict icons

### Settings
- **Display presets**: Minimal / Summary / Detailed / Debug
- **Individual toggles**: thinking visibility, tool call visibility, flightdeck tool visibility
- **Project info**: name, governance mode
- Persisted to `localStorage` (key: `flightdeck:display`)
- On WebSocket connect, client pushes saved config to server (overrides server default)

## Communication Model

### User → Lead
| Action | Mechanism | UI |
|--------|-----------|-----|
| Chat message | WS `chat:send` → Lead steer → response | Chat page input |
| Task comment | WS `task:comment` → Lead steer → response | TaskCard comment input |

### Lead → User
| Action | Mechanism | UI |
|--------|-----------|-----|
| Response | Lead steer returns text → `createMessage()` → WS `chat:message` | Chat message list |
| Streaming | `agent_message_chunk` → WS `chat:stream` | Real-time typing |
| Task comment reply | WS `task:comment` broadcast | TaskCard comments |

### Agent ↔ Agent
| Action | MCP Tool | Mechanism |
|--------|----------|-----------|
| DM | `flightdeck_send(to)` | `agentManager.sendToAgent()` steer |
| Channel | `flightdeck_send(channel)` | MessageLog write |
| Task comment | `flightdeck_send(taskId)` | ChatMessage + WS broadcast |
| Escalation | `flightdeck_escalate` | Lead steer |
| Interrupt | `flightdeck_agent_interrupt` | ACP cancel + write (V1-style) |

### Reply References
- User → Lead: `parentId` set by gateway (auto-links response to user message)
- Agent → Agent: `parentId` param in `flightdeck_send`

### Stream ID Consistency
Stream chunks and final message share the same pre-generated `msg-xxx` ID (via `messageId()` at steer start). Frontend clears streaming state by matching ID.

## Real-time Updates

All state changes broadcast via WebSocket:
- `chat:message` — new message (Lead response, system events)
- `chat:stream` — streaming token chunks (text, thinking, tool calls)
- `task:comment` — task comment + Lead reply
- `state:update` — task/agent state changed → frontend refetches all data
- `agent:stream` — per-agent output streaming (WIP)
- `display:config` — display settings sync

## State Management

React Context (`FlightdeckProvider`) with `useFlightdeck()` hook. No external state library.

- Projects, tasks, agents, decisions, messages fetched on mount via REST API
- Real-time updates via WebSocket events
- Streaming state via `useRef` Maps (avoids re-render per token) + `requestAnimationFrame` batching
- Tool calls merged by `toolCallId` via `toolCallMapRef`
- Display config persisted to `localStorage`, synced to server on WS connect

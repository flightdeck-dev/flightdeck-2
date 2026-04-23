# Flightdeck Web UI — Design Guide

## Design Philosophy

Notion-inspired. Clean, minimal, content-first. Subtle borders, muted colors. No heavy shadows or gradients.

## Theme

CSS custom properties with light/dark mode (`.dark` class toggle).

### Color Palette

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--color-surface` | `#ffffff` | `#191919` | Page background |
| `--color-surface-secondary` | `#f7f7f5` | `#202020` | Cards, sidebar, code blocks |
| `--color-surface-hover` | `#f1f1ef` | `#2a2a2a` | Hover states, active nav |
| `--color-border` | `#e8e8e5` | `#2e2e2e` | All borders |
| `--color-text-primary` | `#37352f` | `#e3e3e0` | Body text |
| `--color-text-secondary` | `#787774` | `#9b9b97` | Labels, metadata |
| `--color-text-tertiary` | `#b4b4b0` | `#5a5a58` | Placeholders, disabled |

### Status Colors (same in both themes)

| Token | Color | Usage |
|-------|-------|-------|
| `--color-status-ready` | `#2f80ed` | Ready tasks, primary buttons |
| `--color-status-running` | `#d97706` | Busy agents, running tasks |
| `--color-status-in-review` | `#9333ea` | In-review state |
| `--color-status-done` | `#16a34a` | Done tasks, idle agents |
| `--color-status-failed` | `#dc2626` | Errors, terminate buttons |
| `--color-status-cancelled` | `#9ca3af` | Offline, cancelled |

Status badges use 15% opacity background: `color-mix(in srgb, {color} 15%, transparent)`.

### Typography

- **Sans**: Inter → system-ui fallback
- **Mono**: JetBrains Mono → ui-monospace fallback
- Body text `text-sm` (14px), labels/metadata `text-xs` (12px)

## Icons

[Lucide React](https://lucide.dev/), `strokeWidth={1.5}` throughout.

| Context | Icons | Size |
|---------|-------|------|
| Sidebar nav | `LayoutDashboard`, `MessageSquare`, `ListTodo`, `Bot`, `Scale`, `Settings` | 16 |
| Agent roles | `Crown` (lead), `Code` (worker), `Search` (reviewer), `ClipboardList` (director) | 20 |
| Tool calls | `Settings` (flightdeck_*), `Terminal` (shell), `FileText` (file), `Search` (search), `Wrench` (default) | 14 |
| Actions | `Plus`, `Send`, `ChevronDown`/`Up`/`Left`/`Right` | 14–18 |

## Layout

```
┌──────────┬──────────────────────────────────┐
│ Sidebar  │           Main Content           │
│ (w-56)   │          (max-w-5xl)             │
│          │                                  │
│ Projects │                                  │
│  ▸ proj  │       Page Component             │
│   ├ Dashboard                               │
│   ├ Chat │                                  │
│   ├ Tasks│                                  │
│   ├ Agents                                  │
│   └ Decisions                               │
│          │                                  │
│ Settings │                                  │
│ 2 busy   │                                  │
└──────────┴──────────────────────────────────┘
```

- **Sidebar**: `w-56`, collapsible to `w-12` via `PanelLeft`/`PanelLeftClose` toggle
- Active page: `bg-[var(--color-surface-hover)]` + `font-medium`
- Bottom: agent status summary (busy/idle count with pulse dot)

## Pages

### Dashboard
- Summary stat cards: task counts by state, agent count, cost
- Active agents list (hides offline/suspended/hibernated/retired)
- Status dots: busy = orange pulse, idle = green, other = gray

### Chat
- **User messages**: right-aligned, blue rounded bubble
- **Lead messages**: left-aligned, no bubble, clean text with Markdown rendering
- **Streaming**: real-time token-by-token display while Lead is typing
- **Typing indicator**: shown during streaming, clears when response completes
- **Thinking blocks**: 🧠 icon, gray italic, truncated — click to expand
- **Tool call cards**: merged by `toolCallId`, smart icon by tool type
  - Summary: one-line `🔧 tool_name(brief) → result`
  - Detailed: expandable `<details>` with input + result sections
- **Display modes** (Settings):
  - Minimal — text only
  - Summary — thinking collapsed, tool calls one-line
  - Detailed — everything expanded
  - Debug — same as detailed, includes flightdeck internal tools
- **IME safe**: Chinese/Japanese input Enter doesn't trigger send

### Tasks
- Filter bar: All + each state as tab
- **TaskCard**: expandable — title, state badge, agent assignment, priority
  - Expanded: description, claim, dependency tree, **comments list**, comment input
  - Comments display with author + timestamp
- Create task modal: title, description, role, priority

### Agents
- Responsive grid (1–3 cols)
- **AgentCard**: role icon, ID (mono), status badge (animated pulse if busy), model/runtime/cost
- Actions: Interrupt + Terminate buttons
- **Output Panel** (click to expand):
  - **Output tab**: dark monospace terminal-style, auto-scrolls, live streaming
  - **Send Message tab**: text input + Send button + Interrupt button (red)
  - Live activity dot on Output button when agent is producing output
- Terminated agents: collapsed section, 60% opacity

### Decisions
- List of decision log entries with verdict icons (`Check`, `X`, `Circle`)
- Category icons: architecture, performance, security, style, dependency

### Settings
- Display preset selector: Minimal / Summary / Detailed / Debug
- Individual toggles: thinking, tool calls, flightdeck tools
- Project info display (name, governance mode)
- Settings persist across page refreshes (localStorage)

## Interaction Patterns

- **Expandable cards**: `<details>`/`summary` or toggle state, with `ChevronDown`/`Up` indicator
- **Buttons**: rounded-lg, status-colored backgrounds, `hover:opacity-90`, `disabled:opacity-40`
- **Inputs**: `bg-[var(--color-surface)]` + `border` + `focus:border-[var(--color-status-ready)]`
- **Loading states**: skeleton `animate-pulse` blocks matching content shape
- **Empty states**: centered icon + message + hint text
- **Badges**: small rounded-full pills with status color background (15% opacity) + text color

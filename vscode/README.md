# Flightdeck VSCode Extension

IDE integration for [Flightdeck 2.0](../README.md) — multi-agent orchestration for coding agents.

## Features

- **Sidebar panel** — project status, specs with nested tasks, agent list
- **Status bar** — live task completion count (✈️ Flightdeck: 3/8 tasks done)
- **Command palette** — create specs/tasks, show status, open dashboard, init project
- **Task detail webview** — click any task to see details + action buttons (claim, submit, fail, escalate)

## Setup

```bash
cd vscode
npm install
npm run compile
```

Then press F5 in VSCode to launch the Extension Development Host.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `flightdeck.serverUrl` | `http://localhost:4600` | Flightdeck server URL |
| `flightdeck.pollInterval` | `30` | Poll interval in seconds |

## Architecture

The extension communicates with Flightdeck via its REST API (`/api/*`). It does NOT import the core library directly — it's a pure HTTP client.

## Commands

| Command | Description |
|---|---|
| `Flightdeck: Create Spec` | Prompt for title, create via API |
| `Flightdeck: Create Task` | Prompt for title + role, create via API |
| `Flightdeck: Show Status` | Show project status in output channel |
| `Flightdeck: Open Dashboard` | Open web UI in browser |
| `Flightdeck: Initialize Project` | Run `flightdeck init` in terminal |
| `Flightdeck: Refresh` | Manually refresh all views |

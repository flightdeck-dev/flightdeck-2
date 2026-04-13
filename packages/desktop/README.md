# Flightdeck Desktop

Electron shell for Flightdeck 2.0 — wraps the web UI and manages the daemon lifecycle.

## Architecture

```
┌──────────────────────────────────┐
│         Electron Shell           │
│  ┌────────────┐  ┌───────────┐  │
│  │  Renderer   │  │  System   │  │
│  │  (Web UI)   │  │   Tray    │  │
│  └─────┬──────┘  └───────────┘  │
│        │ HTTP                    │
│  ┌─────▼──────────────────────┐  │
│  │  Daemon (child process)    │  │
│  │  packages/server CLI       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- **Electron** = window shell + daemon lifecycle manager
- **Web UI** loads from the daemon's HTTP server (same as browser usage)
- **Daemon** runs as a managed child process, auto-starts/restarts
- **System tray** for quick access — minimize to tray on close

## Development

```bash
# From monorepo root
cd packages/desktop

# Install deps
npm install

# Compile TypeScript
npm run compile

# Run in dev mode (requires daemon server + web UI to be built)
npm run dev
```

## Building

```bash
# Package for distribution
npm run build
```

Outputs to `release/` — produces platform-specific installers:
- **macOS:** .dmg
- **Windows:** .exe (NSIS installer)
- **Linux:** .AppImage, .deb

## IPC Bridge

The preload script exposes `window.flightdeck` with:

| Method | Description |
|--------|-------------|
| `getDaemonStatus()` | Returns `{ status, port, url }` |
| `getProjects()` | Fetches projects from daemon API |
| `restartDaemon()` | Restarts the daemon process |
| `onDaemonStatus(cb)` | Subscribe to status changes |
| `onDaemonLog(cb)` | Subscribe to daemon log output |

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Electron main process — window, IPC, lifecycle |
| `src/daemon.ts` | Daemon spawn, health check, auto-restart |
| `src/tray.ts` | System tray icon and context menu |
| `src/preload.ts` | Secure IPC bridge for renderer |

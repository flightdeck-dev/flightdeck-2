# Flightdeck 2.0 — Timeouts & Timers Reference

All timeouts, intervals, and timing-related constants in the codebase.

## Active Timeouts & Timers

| Component | Type | Value | File | Description |
|-----------|------|-------|------|-------------|
| **Kill grace period** | setTimeout | **10s** | `AcpAdapter.ts:750` | SIGTERM → SIGKILL escalation when killing an agent process |
| **Orchestrator tick** | setInterval | **5 min** (default) | `Orchestrator.ts:505` | Main scheduling loop — evaluates tasks, processes completions, checks stalls |
| **Lead heartbeat** | setInterval | **30 min** (default) | `LeadManager.ts:68` | Periodic steer to Lead for status check. Configurable via `heartbeat.interval` |
| **Workflow step timeout** | execSync timeout | **60s** | `WorkflowEngine.ts:107` | Max time for a single workflow shell command |
| **Retrospective TTL** | Map pruning | **24h** | `Orchestrator.ts:55-56` | Entries in `retrospectivesDone` are pruned after 24h to prevent memory leak |
| **Agent timers** | user-defined | variable | `TimerManager.ts` | Agents can set custom timers via `flightdeck_timer_set` (one-shot or repeating) |

## Components with NO Timeout (by design)

| Component | File | Why no timeout |
|-----------|------|----------------|
| **ACP initialize** | `AcpAdapter.ts:407` | Waits indefinitely for Copilot CLI to initialize. If the process crashes, the `close` event handles cleanup. A timeout here would kill slow-starting agents unnecessarily. |
| **ACP session/new** | `AcpAdapter.ts:428` | Same — waits for session creation. MCP server loading can take 5-10s. |
| **ACP prompt** | `AcpAdapter.ts:461,665` | Agent thinking time is unbounded — complex tasks can take minutes. The orchestrator detects stalls instead of hard-killing. |
| **Spawn (cpSpawn)** | `AcpAdapter.ts:328` | Process creation is instant (OS-level). If the binary doesn't exist, `error` event fires with ENOENT. |
| **HTTP server** | `cli/daemon.ts` | Standard HTTP — no request timeout configured. Node.js default is 0 (no timeout). |

## Configuration

```typescript
// Orchestrator tick interval (passed to start())
orchestrator.start(5 * 60 * 1000); // 5 minutes

// LeadManager heartbeat (passed via opts)
heartbeat: {
  enabled: true,
  interval: 30 * 60 * 1000, // 30 minutes
  conditions: []
}

// Kill grace period (hardcoded in AcpAdapter.kill())
setTimeout(() => { process.kill('SIGKILL'); }, 10_000);
```

## Notes

- The orchestrator tick interval and heartbeat interval are the main "pulse" of the system
- No ACP communication has a timeout — this is intentional. Agent operations are long-running by nature
- The workflow step timeout (60s) is for automated shell commands, not agent prompts
- Agent-created timers (via MCP tool) are managed by TimerManager and cleaned up on agent termination

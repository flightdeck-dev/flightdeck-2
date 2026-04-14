---
name: iterative-review
description: Iterative test-observe-fix cycle for Flightdeck development. Use when running integration tests against the Flightdeck daemon, observing Lead/agent behavior, identifying bugs, fixing them, and re-testing. Applies to any scenario where you need to exercise the Flightdeck orchestration loop (daemon → Lead → Planner → Workers) and continuously improve based on observed behavior.
---

# Iterative Review Cycle

A structured loop for testing Flightdeck's multi-agent orchestration, observing behavior, and fixing issues.

## The Loop

```
TEST → OBSERVE → DOCUMENT → FIX → VERIFY → repeat
```

Each iteration should produce: observed behaviors, filed issues, code fixes with tests, and verified green CI.

## 1. TEST — Run the System

Start the daemon **without exec timeout** (it's a long-running process):

```bash
# Single project to limit memory (~4GB per ACP agent)
cd ~/clawspace/flightdeck-2 && npx --prefix packages/server \
  tsx packages/server/src/cli/index.ts start \
  --project <name> --no-recover
```

Use `exec(background=true)` with **no timeout**. The daemon stays alive until explicitly killed.

Create tasks and interact with Lead:

```bash
# Create tasks
bash skills/flightdeck/scripts/fd-api.sh create-task <project> "<title>" "<description>" "<role>" "<priority>"

# Talk to Lead (synchronous — may hang if Lead is busy)
bash skills/flightdeck/scripts/fd-api.sh chat <project> "<message>"

# Post message without waiting for reply (async)
curl -sf -X POST http://localhost:18800/api/projects/<project>/messages \
  -H 'Content-Type: application/json' \
  -d '{"content":"<message>"}'
```

**Memory budget:** Each Copilot ACP agent ≈ 4GB RSS. On a 32GB machine, max ~6 concurrent agents. Prefer serial over parallel when possible.

## 2. OBSERVE — Watch Behavior

Check these systematically:

```bash
# Agent status — are they actually running?
fd-api.sh agents <project> | jq '.[] | {id: .id[:20], role, status, acp: .acpSessionId}'

# Task state — did tasks get claimed and assigned?
fd-api.sh tasks <project> | jq '.[] | {title, state, assignedAgent}'

# Messages — did Lead respond?
fd-api.sh messages <project> | jq '.[-5:] | .[] | {authorType, content: .content[:200]}'

# Daemon logs — any errors?
process(action=log, sessionId=<daemon-session>)
```

### Known Failure Patterns

| Symptom | Likely Cause |
|---------|-------------|
| Agent status=busy but acpSessionId=null | Orchestrator didn't spawn ACP process |
| Tasks stay "ready" despite Lead being "busy" | Lead not auto-claiming; needs explicit prompt |
| Lead says "done" but task state unchanged | Lead hallucinated — always verify via API |
| chat endpoint hangs forever | Lead busy processing; use async message POST instead |
| SIGKILL on daemon | Check if exec had a timeout set (most common cause) |
| Planner creates unwanted tasks | Planner acts autonomously; may need clearer scope |

## 3. DOCUMENT — Record Findings

Append observations to the review log:

```bash
cat >> ~/clawspace/flightdeck-2/reviews/iteration-log.md << 'LOG'
## Iteration N — <date>
### Observed
- <what happened>
### Expected
- <what should have happened>
### Root Cause
- <why>
### Fix
- <what to change>
LOG
```

## 4. FIX — Make Changes

For code fixes, spawn focused subagents:

```
sessions_spawn(
  label: "fix-<issue>",
  mode: "run",
  task: "<specific bug description with file paths, expected behavior, and fix approach>"
)
```

Each fix subagent should:
- Fix the specific bug (minimal change)
- Write tests for the fix
- Run `pnpm test` to verify nothing broke

**Critical rule: verify subagent results.** Never trust self-reported "all tests pass." Always run `pnpm test` yourself after all fixes land.

## 5. VERIFY — Confirm Fixes

```bash
cd ~/clawspace/flightdeck-2 && pnpm test 2>&1 | tail -5
git diff --stat  # review changes
```

Then restart the daemon and re-test the original scenario to confirm the behavioral fix.

## Key Lessons

- **exec timeout kills daemons** — never set timeout on long-running processes
- **Lead hallucinates actions** — always verify task state via API, not Lead's messages
- **Agents register but don't spawn** — check acpSessionId, not just status
- **chat endpoint is synchronous** — use async POST for non-blocking messages
- **One ACP agent ≈ 4GB** — plan agent count around available memory
- **Planner is autonomous** — it may create tasks you didn't ask for
- **Subagent self-reports are unreliable** — run `pnpm test` yourself after fixes

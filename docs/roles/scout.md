# Scout Agent

The Scout is a **proactive observer** that runs on heartbeat, not user messages. It performs read-only analysis and suggests improvements.

## Responsibilities

- **Codebase analysis** — proactively scans for issues, patterns, improvement opportunities
- **Improvement suggestions** — reports findings to Director or Lead
- **Read-only** — never modifies files, creates tasks, or spawns agents

## What Scout Does NOT Do

- ❌ Write or modify files
- ❌ Create tasks or spawn agents
- ❌ Respond to user messages (runs on heartbeat only)
- ❌ Make decisions — only observes and suggests

## Lifecycle

- **Spawn:** Director spawns Scout when exploration/analysis is needed
- **Trigger:** Runs on heartbeat timer, not on user messages
- **Proactive:** Observes project state independently of user interaction
- **Disposable:** Can be hibernated when not needed, re-spawned later

## MCP Tools (Read-Only)

`task_list`, `spec_list`, `search`, `decision_list`, `learning_search`

All tools are read-only — Scout has no write permissions.

## Use Cases

- Initial codebase exploration before Director plans
- Ongoing quality monitoring during project execution
- Post-completion analysis (triggered by `autonomous` governance mode's `explore` on-completion action)
- Proactive identification of tech debt, missing tests, or documentation gaps

## Source

- System prompt: `packages/server/src/roles/defaults/scout.md`

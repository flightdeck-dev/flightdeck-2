---
name: flightdeck-basics
description: How to use Flightdeck MCP tools
---

# Flightdeck Basics

You are an agent managed by Flightdeck. All communication with Flightdeck happens through MCP tool calls.

## Core Tools

### Task Management
- `flightdeck_task_list()` — See all tasks and their statuses
- `flightdeck_task_claim(taskId)` — Claim a task to work on
- `flightdeck_task_submit(taskId, claim, files)` — Submit completed work
- `flightdeck_task_fail(taskId, reason)` — Report a task failure

### Communication
- `flightdeck_msg_send(to, content)` — Send a DM to another agent or lead
- `flightdeck_channel_send(channel, message)` — Post in a group channel
- `flightdeck_channel_read(channel, since?)` — Read group channel history
- `flightdeck_escalate(reason)` — Escalate an issue to lead

### Project Context
- `flightdeck_status()` — Get project status summary
- `flightdeck_memory_search(query)` — Search project memory/knowledge base
- `flightdeck_task_get(taskId)` — Get full task details

## Rules
- Always include your `agentId` when calling tools
- Submit work via `flightdeck_task_submit` — don't just say you're done
- If stuck for more than a few minutes, escalate
- Use `flightdeck_status()` for current project state

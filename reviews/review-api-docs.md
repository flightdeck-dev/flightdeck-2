# Flightdeck 2.0 — API Design & Documentation Review

**Reviewer:** Claw (subagent)  
**Date:** 2026-04-14  
**Scope:** REST API, MCP tools, CLI, roles, documentation

---

## 1. REST API Endpoint Design

**File:** `packages/server/src/api/HttpServer.ts`

### Strengths
- Clean project-scoped routing: `/api/projects/:name/*` is well-structured
- Consistent JSON response helper (`json(status, body)`)
- Proper CORS handling, body size limits (1MB), and OPTIONS preflight
- Good use of HTTP status codes (201 for creation, 409 for conflict, 413 for oversized body)
- Auth check hook is clean and injectable

### Issues

| Severity | Issue |
|----------|-------|
| **Medium** | **No router abstraction** — entire API is a single `createServer` callback with a chain of `if/else if` blocks (~250 lines). This will become unmaintainable. Consider extracting a lightweight router (even a map of `[method, pattern] → handler`). |
| **Medium** | **Inconsistent sub-path matching** — some routes use `subPath === '/tasks'`, others use `subPath.match(/^\/tasks\/[^/]+$/)`. The regex routes don't extract params cleanly. A router would fix this. |
| **Medium** | **Missing PATCH/PUT for tasks** — you can POST to create and GET to read, but there's no endpoint to update task state (claim, complete, fail) via REST. All mutations go through MCP only. If the REST API is meant to be a full alternative, it's incomplete. If it's intentionally read-heavy + chat, document that. |
| **Low** | **`/report` returns markdown with `Content-Type: text/markdown`** while all other endpoints return JSON. Consider supporting `Accept` header negotiation or a `?format=json` param. |
| **Low** | **No pagination** on `/tasks`, `/agents`, `/decisions` (decisions has limit but no offset/cursor). |
| **Low** | **`/messages` POST does too much** — it handles sync and async Lead steering, message creation, webhook notification, and WebSocket broadcast in one handler. Extract this into a service method. |
| **Info** | `/api/gateway/state` sits outside the project scope (`/api/projects/...`). This is fine but should be documented as a system-level endpoint. |

### Error Response Format
Errors consistently use `{ error: string }` — good. But there's no error code field for programmatic handling. Consider `{ error: string, code?: string }`.

---

## 2. MCP Tool Design (59 tools)

**File:** `packages/server/src/mcp/server.ts` (1163 lines)

### Strengths
- **Excellent role-based filtering** via `toolPermissions.ts` — each role only sees relevant tools. This is genuinely well-designed and reduces agent confusion.
- **Helpful error messages** — `permError()` tells agents exactly which roles can use a tool and suggests alternatives. This is great UX for AI agents.
- **Consistent naming convention** — `flightdeck_{domain}_{action}` (e.g., `flightdeck_task_claim`, `flightdeck_msg_send`). Uniform prefix prevents conflicts with other MCP servers.
- **Self-discovery** — `flightdeck_tools_available` lets agents introspect their permissions.
- **zod validation** on all tool inputs.

### Issues

| Severity | Issue |
|----------|-------|
| **High** | **`agentId` passed by the agent itself in most tools** — this is a trust issue. An agent can impersonate another by passing a different agentId. The agent ID should come from the MCP session context (env var `FLIGHTDECK_AGENT_ID`), not from tool params. Currently `_ENV_AGENT_ID` is read but many tools still accept `agentId` as a user param. |
| **Medium** | **59 tools is a lot.** Some agents (especially workers with 13 tools) are fine, but Lead has 40+ tools. Consider grouping related tools or using a single `flightdeck_task` tool with an `action` sub-param for the 12 task state transitions. |
| **Medium** | **Inconsistent param naming** — `spec_id` uses snake_case in `flightdeck_suggestion_list` but `taskId` uses camelCase in `flightdeck_task_get`. Pick one. (snake_case is more common in MCP tools.) |
| **Medium** | **`flightdeck_escalate` requires `taskId`** but escalations aren't always task-scoped (could be about project-level issues). Make `taskId` optional. |
| **Low** | **`flightdeck_report`** is listed in ROLE_TOOLS for lead but I don't see it registered as a `server.tool()` in the MCP server code (only `flightdeck_cost_report` and the REST `/report` endpoint). Phantom tool reference? |
| **Low** | **Some tools lack `.describe()` on params** — e.g., `flightdeck_escalate`'s `taskId` and `reason` have no descriptions, while `flightdeck_suggestion_list` params have good `.describe()` annotations. Be consistent. |
| **Info** | The README lists only ~12 MCP tools ("Available MCP tools") but there are actually 59. The list is very outdated. |

---

## 3. Role System

**Files:** `docs/roles/lead.md`, `docs/roles/planner.md`, `packages/server/src/mcp/toolPermissions.ts`

### Strengths
- Clear separation of concerns per role
- Lead and Planner role docs are concise, actionable, and include sentinel values (`FLIGHTDECK_IDLE`, `FLIGHTDECK_NO_REPLY`)
- "What NOT to Do" sections are excellent — prevent common agent mistakes

### Issues

| Severity | Issue |
|----------|-------|
| **High** | **Only 2 of 8 roles have role docs** — `lead.md` and `planner.md` exist, but `worker`, `reviewer`, `product-thinker`, `qa-tester`, `tech-writer`, and `scout` have no role markdown files. The `toolPermissions.ts` defines 8 distinct roles with different tool sets, but 6 have no behavioral guidance. Agents need these. |
| **Medium** | **Planner output format is informal** — the "Output Format" section shows a pseudo-format but agents should use `flightdeck_declare_tasks` tool. The doc should show the tool call, not a text format. |
| **Low** | **No role overview page** — there's no single doc listing all roles, their responsibilities, and how they interact. `toolPermissions.ts` is the closest thing. |

---

## 4. CLI Design

**File:** `packages/server/src/cli/index.ts`

### Strengths
- Good help text with clear command groupings
- `--json` flag for all query commands — great for scripting
- `gateway` subcommand group is well-organized (start/stop/restart/status/probe/install)
- `doctor` command for diagnostics

### Issues

| Severity | Issue |
|----------|-------|
| **Medium** | **Monolithic switch/case** — the entire CLI is a single async IIFE with a giant switch. For 20+ commands this is hard to maintain. Consider a command registry pattern. |
| **Medium** | **`start` is an alias for `gateway run`** — confusing. Users might expect `start` to run the daemon (background), not foreground. The README says `flightdeck init` but the binary isn't `flightdeck` — it's `npx tsx src/cli/index.ts`. |
| **Low** | **No `--version` flag.** |
| **Low** | **`parseArgs` with `strict: false`** — this swallows unknown flags silently. Could hide user errors. |

---

## 5. README Accuracy

### Issues

| Severity | Issue |
|----------|-------|
| **High** | **MCP tools list is severely outdated** — README lists ~12 tools, actual count is 59. Missing: all task state transitions (cancel/pause/resume/retry/skip/reopen), declare_tasks, declare_subtasks, agent_spawn/terminate/restart/interrupt, channel_send/read, memory_*, learning_*, timer_*, decision_*, suggestion_*, role_*, thread_*, discuss, escalate, etc. |
| **Medium** | **Library API import path is wrong** — README shows `import { Flightdeck } from '@flightdeck/core'` but the actual package is `@flightdeck-ai/shared` (shared) and the server facade. The lower-level example imports `TaskDAG, SpecStore, AgentRegistry, VerificationEngine, EventBus` — several of these don't exist by those names in the codebase. |
| **Medium** | **CLI examples show `flightdeck` binary** but no `bin` field or npm link setup is documented. Users need `npx tsx src/cli/index.ts`. |
| **Low** | **Module table is outdated** — lists `events/`, `persistence/` as separate modules, but actual structure uses `storage/` with SqliteStore, and events are part of the orchestrator. |
| **Low** | **No mention of WebSocket API** — the web UI connects via WebSocket but there's no documentation of the WS protocol. |

---

## 6. Documentation Gaps

| Priority | Missing Doc |
|----------|------------|
| **High** | Role docs for 6 of 8 roles (worker, reviewer, product-thinker, qa-tester, tech-writer, scout) |
| **High** | MCP tool reference — a complete list with params, permissions, and examples |
| **Medium** | REST API reference — endpoint list with request/response schemas |
| **Medium** | WebSocket protocol documentation |
| **Medium** | Governance profiles documentation (autonomous/collaborative/supervised — mentioned in architecture but not documented) |
| **Low** | Error code reference |
| **Low** | Configuration reference (`.flightdeck/config.yaml` options) |

---

## 7. Summary Scorecard

| Area | Score | Notes |
|------|-------|-------|
| REST API Design | **B** | Clean project-scoped structure, but no router, incomplete mutation endpoints |
| MCP Tool Design | **A-** | Excellent role filtering and error messages; agentId trust issue is the main concern |
| Error Consistency | **B+** | Consistent `{ error }` format in REST; MCP uses `errorResponse()` helper throughout |
| CLI Design | **B** | Good UX and help text; monolithic implementation, binary naming confusion |
| README | **C** | Outdated MCP list, wrong import paths, aspirational module table |
| Role Docs | **D** | Only 2 of 8 roles documented |
| Architecture Docs | **A** | ARCHITECTURE.md is excellent — clear diagrams, accurate module descriptions |

### Top 5 Recommendations (Priority Order)

1. **Write role docs for all 8 roles** — agents are flying blind without behavioral guidance for worker/reviewer/qa-tester/tech-writer/product-thinker/scout
2. **Fix agentId trust** — derive agent identity from session context, not tool params
3. **Update README MCP tools list** — or better, auto-generate it from `server.tool()` registrations
4. **Fix README import paths and module table** to match actual codebase
5. **Add param descriptions (`.describe()`) to all MCP tool parameters** for better agent comprehension

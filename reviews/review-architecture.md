# Flightdeck 2.0 — Architecture & Code Quality Review

**Reviewed:** 2026-04-14  
**Codebase:** `~/clawspace/flightdeck-2/`  
**Stats:** ~13.3K LOC server, 61 source files, 61 test files, 6 packages

---

## 1. Overall Architecture & Package Structure

**Packages:** server, shared, web, tui, desktop, vscode  
**Monorepo:** pnpm workspaces, `tsconfig.base.json` shared config

### Strengths
- Clean facade pattern (`Flightdeck` class in `facade.ts`) — single entry point wrapping all subsystems
- Good separation: storage, orchestration, agents, governance, verification, workflow
- Branded ID types (`TaskId`, `AgentId`, etc.) in shared — excellent type safety pattern
- MCP server cleanly separated from core logic

### Issues

**🔴 CRITICAL: Diverged shared/server type definitions**
- `packages/shared/src/core/types.ts` and `packages/server/src/core/types.ts` are **near-identical copies** that have already diverged:
  - Server `AGENT_ROLES` is missing `'scout'` that shared has
  - Server `AGENT_STATUSES` is missing `'suspended'` that shared has  
  - Server `Task` interface is missing `parentTaskId`, `stale`, `compactedAt` fields
  - Server is missing `RoleModelConfig`, `AgentsConfig`, and `notifications` config
  - Server `transition()` still has `unblock_dependents` side effect removed from shared
- **Impact:** Runtime type mismatches, potential crashes when server code handles tasks with fields it doesn't know about
- **Fix:** Delete `packages/server/src/core/types.ts` entirely. Server already imports from `@flightdeck-ai/shared` in most files.

**🟡 `web/src/lib/types.ts` is a third, manually-maintained type copy**
- File: `packages/web/src/lib/types.ts`
- Defines its own `Task`, `Agent`, `Decision`, `Spec`, `ChatMessage`, `Thread`, `ProjectStatus`, `Activity` types
- Uses plain `string` instead of branded IDs
- Has both camelCase AND snake_case variants (`assignedAgent` + `assigned_agent`, `dependsOn` + `depends_on`) — suggests unstable API serialization
- `TaskState` is missing `blocked` and `gated` states that exist in shared
- `DecisionStatus` has completely different values (`'recorded' | 'confirmed' | 'rejected'` vs shared's `'auto_approved' | 'pending_review' | ...`)
- **Fix:** Import from `@flightdeck-ai/shared` or create a `@flightdeck-ai/shared/api` export with API-specific types

**🟡 TUI has yet another set of inline types**
- `packages/tui/src/hooks/useFlightdeck.ts` defines its own `Task`, `ChatMessage`, `ActivityItem`, `StatusData`, `TaskCounts`
- Same divergence risk as web types

---

## 2. Code Duplication & DRY Violations

**🔴 File-based storage classes repeat the same pattern**
- `DecisionLog`, `MessageLog`, `ReportStore`, `SpecStore`, `LearningsStore`, `SuggestionStore` all follow identical patterns:
  - Constructor takes a directory path
  - `mkdirSync(dir, { recursive: true })` in every write method
  - JSONL append/read with `appendFileSync`/`readFileSync` + split + parse
  - Filtering logic reimplemented per class
- **Files:** `packages/server/src/storage/DecisionLog.ts`, `MessageLog.ts`, `ReportStore.ts`, `LearningsStore.ts`, `SuggestionStore.ts`
- **Fix:** Extract a `JsonlStore<T>` base class with `append()`, `readAll()`, `list()` methods

**🟡 Dual storage: file-based + SQLite**
- `SqliteStore` (503 lines) manages tasks/agents/costs in SQLite
- Six other stores use file-based JSONL/markdown in parallel
- `MemoryStore` (228 lines) uses BOTH (files + SQLite FTS)
- This dual-storage approach means data consistency is manual — no transactions across the two systems

**🟡 `useFlightdeck` hook duplicated across web and TUI**
- `packages/web/src/hooks/useFlightdeck.tsx` and `packages/tui/src/hooks/useFlightdeck.ts`
- Both manage WebSocket connections, state polling, reconnection logic
- Could share a headless `@flightdeck-ai/client` package

---

## 3. TypeScript Best Practices & Type Safety

### Positives
- `strict: true` everywhere ✅
- No `@ts-ignore` or `@ts-expect-error` usage ✅
- Branded types for IDs ✅
- Zod validation in MCP server ✅

### Issues

**🟡 32 `as any` casts in server package**
- Scattered across the codebase; should audit each for proper typing

**🟡 10 explicit `: any` type annotations**
- Should be replaced with proper types or `unknown`

**🟡 241 `console.log/warn/error` calls in server**
- No structured logging framework
- Makes log filtering, levels, and production log management difficult
- **Fix:** Introduce a lightweight logger (e.g., `pino`) with log levels

**🟡 `main` field points to source, not dist**
- `packages/server/package.json`: `"main": "src/index.ts"` — works with `tsx` but breaks standard Node.js resolution
- `packages/shared/package.json`: same issue
- **Fix:** Point `main` to `dist/`, use `exports` with conditions for dev vs prod

---

## 4. Dependency Management

**🔴 Corrupted `pnpm-workspace.yaml` `allowBuilds` section**
```yaml
allowBuilds:
  '3': true
  '"': true
  ',': true
  '-': true
  '[': true
  ']': true
  ...
```
- These are individual characters, not package names — looks like a corrupted/malformed entry
- **Fix:** Remove or fix the `allowBuilds` section

**🟡 `@types/ws` in `dependencies` instead of `devDependencies`**
- File: `packages/server/package.json`
- `@types/*` packages should always be in devDependencies

**🟡 Desktop uses CommonJS (`module: "commonjs"`), rest uses ESM**
- `packages/desktop/tsconfig.json` — forced by Electron, but worth noting for interop awareness

**🟡 No lockfile or engine constraints visible**
- No `engines` field in root `package.json`
- TypeScript versions vary: `^5.8.3` (server), `^5.7.0` (web, tui), `^5.5.0` (desktop)

**✅ No circular dependencies detected** — imports flow cleanly: shared → server → (web | tui | desktop | vscode)

---

## 5. Performance Bottlenecks

**🟡 MCP server is a 1163-line monolith**
- File: `packages/server/src/mcp/server.ts`
- 40+ tool handlers registered inline in a single `createMcpServer()` function
- Each handler creates its own `Flightdeck` facade instance (or should share one)
- **Fix:** Split into per-domain tool files: `tools/tasks.ts`, `tools/agents.ts`, `tools/messaging.ts`, etc.

**🟡 JSONL stores read entire file on every query**
- `DecisionLog.readAll()`, `MessageLog.read()` all do `readFileSync` → parse all lines → filter
- For long-running projects with thousands of decisions/messages, this will degrade
- **Fix:** Use SQLite for everything, or add pagination/streaming to file stores

**🟡 `SqliteStore` at 503 lines — doing too much**
- Manages tasks, agents, costs, and cost aggregation in one class
- Individual methods are fine but the class violates SRP

**🟡 Facade constructor is eager**
- `Flightdeck` constructor initializes ALL subsystems (12+ classes) even if the caller only needs one
- For MCP tool calls that only need `dag.listTasks()`, this is wasteful
- **Fix:** Lazy initialization or factory methods per subsystem

---

## 6. Additional Observations

**🟡 Root-level test files outside package structure**
- `test-lead-only.ts`, `test-lead-e2e.ts`, `test-mini.ts`, `test-collab-e2e.ts`, `test-e2e-claw.ts` in repo root
- These are ad-hoc integration tests, not part of `vitest` test suite
- Should move to `packages/server/tests/e2e/` or a dedicated `packages/e2e/`

**🟡 Missing `packages/cli` and `packages/mcp`**
- The task description mentioned these packages, but they don't exist as separate packages
- CLI lives in `packages/server/src/cli/` (618 lines) — reasonable for now
- MCP lives in `packages/server/src/mcp/` — could be extracted later

**🟡 Gateway code is substantial (964+ lines across 3 files)**
- `cli/gateway.ts` (503), `cli/gateway-lifecycle.ts` (461), `cli/gateway/auth.ts`, `cli/gateway/service.ts`
- This is HTTP server + daemon lifecycle management embedded in the CLI directory
- Should be its own module: `packages/server/src/gateway/`

---

## Summary

| Category | Rating | Key Action |
|----------|--------|------------|
| Architecture | ⭐⭐⭐⭐ | Clean facade + subsystems; extract gateway module |
| Type Safety | ⭐⭐⭐ | Fix the **3 diverged type definition files** (critical) |
| DRY | ⭐⭐⭐ | Extract `JsonlStore<T>` base; share client hooks |
| Dependencies | ⭐⭐⭐⭐ | Fix corrupted `pnpm-workspace.yaml`; move `@types/ws` |
| Performance | ⭐⭐⭐ | Split MCP monolith; lazy facade init; paginate file stores |

**Top 3 priorities:**
1. **Delete `server/src/core/types.ts`** — it's a stale copy of shared types causing silent divergence
2. **Fix `web/src/lib/types.ts`** — import from `@flightdeck-ai/shared` instead of maintaining a third copy
3. **Split `mcp/server.ts`** — 1163-line single function is unmaintainable

# Flightdeck 2.0 — Test Suite Review

**Date:** 2026-04-14
**Codebase:** `~/clawspace/flightdeck-2/`
**Test runner:** Vitest (v3.2.4), globals mode, node environment
**Current status:** ✅ 61 test files, 635 tests, all passing (14.3s)

---

## 1. Coverage Gaps

### Modules with NO tests

| Module | Files | LOC | Risk |
|--------|-------|-----|------|
| `api/` | HttpServer.ts, WebSocketServer.ts | 540 | **HIGH** — HTTP routes & WebSocket handlers are critical entry points, completely untested |
| `db/` | database.ts, schema.ts | 161 | **MEDIUM** — schema definitions + DB init; indirectly tested via SqliteStore but no direct validation |
| `projects/` | ProjectManager.ts | 82 | **MEDIUM** — project lifecycle management has no dedicated tests |

### Packages with NO tests

- `packages/shared` — zero test files (shared types/utilities)
- `packages/web` — zero test files (frontend)
- `packages/tui` — zero test files (terminal UI)
- `packages/desktop` — zero test files (Electron)
- `packages/vscode` — zero test files (VS Code extension)

All tests live exclusively in `packages/server/tests/`. The other 5 packages have **no test coverage at all**.

### Thin coverage within tested modules

- `verification/verification.test.ts` — **19 lines, 1 test**. Only checks that `Verifier.verify()` returns a pending result. No tests for pass/fail flows, verification criteria, or edge cases.
- `governance/gate.test.ts` — 23 lines, 3 tests. Minimal.
- `core/ids.test.ts` — 24 lines, 3 tests. Only basic ID generation.

---

## 2. Test Quality Assessment

### Strong areas ✅

- **DAG tests** (dag/*.test.ts, ~680 LOC total) — Thorough coverage of task lifecycle: dependencies, promotion, claiming, completion, retries, epics, subtasks, compaction. Tests real behaviors, not just constructors.
- **Orchestrator tests** (312 LOC) — Tests tick behavior, agent assignment, ACP session handling, stale detection. Uses real SqliteStore + TaskDAG (not mocks).
- **E2E tests** (1,593 LOC across 3 files) — `server-e2e.test.ts`, `supervisor-e2e.test.ts`, `role-separation-e2e.test.ts` use the Facade directly. Well-structured scenario-based tests referencing a test scenarios doc.
- **MCP tests** (5 files, ~597 LOC) — Good coverage of tool permissions, role filtering, error handling, chat tools.
- **Storage tests** (6 files, ~631 LOC) — SQLite store, message log, decision log, learnings, FTS all tested with real DB instances.

### Smoke-test-level files ⚠️

- `verification/verification.test.ts` — Single assertion that a stub returns pending. This is a placeholder, not a real test.
- `core/ids.test.ts` — Only checks ID format/uniqueness basics.

### Overall verdict

Most tests are **meaningful integration tests** using real SQLite instances (created in temp dirs, cleaned up after). This is good — they test actual behavior, not just mocked interfaces. The test quality is generally high for the server package.

---

## 3. Edge Cases Not Covered

### Critical gaps

1. **Concurrent operations** — No tests for race conditions: two agents claiming the same task, concurrent DAG mutations, parallel orchestrator ticks.
2. **Error paths in API layer** — HttpServer.ts (303 LOC) and WebSocketServer.ts (237 LOC) have zero tests. No validation of malformed requests, auth failures, rate limiting.
3. **Database corruption/recovery** — No tests for what happens when SQLite file is corrupted, disk full, or schema migration fails.
4. **Large scale** — No tests with 100+ tasks, 10+ agents, deep dependency chains. Only small DAGs tested.
5. **Task state machine boundary conditions** — While state transitions are tested, invalid transition combinations and re-entrant state changes aren't exhaustively covered.
6. **WebSocket reconnection/disconnect** — `websocket-display.test.ts` tests display logic but not connection lifecycle edge cases.
7. **Project cleanup/teardown** — ProjectManager has no tests; project deletion, data cleanup untested.

### Missing negative tests

- What happens when agents are registered with duplicate IDs?
- What happens when a dependency references a non-existent task?
- What happens when the store is closed and operations are attempted?

---

## 4. Test Organization & Naming

### Structure ✅

```
packages/server/tests/
├── agents/          (11 files)
├── cli/             (1 file)
├── comms/           (2 files)
├── core/            (2 files)
├── dag/             (6 files)
├── display/         (2 files)
├── e2e/             (3 files)
├── facade/          (1 file)
├── governance/      (2 files)
├── integrations/    (1 file)
├── isolation/       (1 file)
├── lead/            (3 files)
├── mcp/             (5 files)
├── orchestrator/    (5 files) [+ timer.test.ts]
├── reporting/       (1 file)
├── roles/           (1 file)
├── skills/          (1 file)
├── specs/           (1 file)
├── status/          (1 file)
├── storage/         (6 files)
├── verification/    (2 files)
├── workflow/        (2 files)
└── global-cleanup.ts
```

**Good:** Test directory mirrors `src/` structure. Easy to find tests for any module.

### Naming conventions

- Files: `<feature>.test.ts` — consistent ✅
- Describe blocks: Use class/module name — consistent ✅
- Test names: Descriptive behavior statements (`'assigns ready tasks to idle agents'`, `'promotes dependents when task completes'`) — good ✅
- No `test_1`, `test_2` anti-patterns ✅

### Minor issues

- `global-cleanup.ts` exists as a global setup but there's no corresponding teardown registration visible in tests (cleanup happens per-test via afterEach).
- E2E tests use `beforeEach`/`afterEach` at module scope (outside `describe`), which is fine but inconsistent with other files.

---

## 5. Flaky Test Patterns

### Risk: Time-dependent tests

33 of 61 test files reference `Date.now()`, `new Date()`, `setTimeout`, or `setInterval`. None use `vi.useFakeTimers()`. This means:

- **Timer-based tests** (e.g., `timer.test.ts`, `scout.test.ts`) could be sensitive to system load.
- **Timestamp assertions** are done loosely (checking truthiness, not exact values), which is appropriate but worth noting.

### Risk: File system tests

All storage/DAG tests create temp directories and real SQLite databases. This is:
- ✅ More reliable than mocks
- ⚠️ Potentially slow on constrained CI (14.3s is fine for now)
- ⚠️ Could fail if `/tmp` fills up or has permission issues

### Risk: No test isolation flags

No `concurrent: false` or pool configuration visible. All 61 files run in parallel by default. Since each creates its own temp dir/DB, this should be fine — but any test that touches shared state (like `gatewayState.test.ts` writing to `~/.flightdeck/`) could conflict.

### Current flakiness: **LOW**

No `.skip`, `.todo`, `.only`, or retry annotations found. All 635 tests pass cleanly. The architecture of per-test temp dirs with real SQLite is inherently more stable than mock-heavy approaches.

---

## 6. Mock Usage

### Current approach: Minimal mocking ✅

The codebase strongly prefers **real instances over mocks**:
- Real `SqliteStore` with temp DB files
- Real `TaskDAG`, `GovernanceEngine`, `Orchestrator`
- Real `Flightdeck` facade in E2E tests

### Where mocks ARE used

- `vi.spyOn(adapter, 'getMetadata')` in orchestrator tests — appropriate for external ACP calls
- Various `vi.fn()` for event handlers/callbacks
- Mock MCP server/transport in MCP tests

### Assessment

Mock usage is **appropriate and restrained**. Mocks are only used at genuine system boundaries (ACP adapter, external services), not for internal module interactions. This is a strength — tests catch real integration bugs.

---

## Summary & Recommendations

### Top priorities

1. **Add API tests** — HttpServer and WebSocketServer are the main entry points with 540 LOC and zero tests. Test route handlers, request validation, error responses, auth.
2. **Add ProjectManager tests** — Project lifecycle is untested.
3. **Expand verification tests** — Current single-test file is a placeholder.
4. **Add concurrency tests** — Race conditions in task claiming and DAG mutations are a real production risk.

### Medium priority

5. Add tests for `packages/shared` (shared utilities, type guards, validators).
6. Add fake timers (`vi.useFakeTimers()`) for time-sensitive tests to eliminate any flakiness risk.
7. Add negative/error-path tests across modules.
8. Consider adding coverage thresholds to CI (vitest coverage is configured but no minimum enforced).

### Low priority

9. Frontend packages (web, tui, desktop, vscode) — these may be tested differently or are UI-only.
10. Database schema migration tests.

### Strengths to preserve

- Real SQLite instances over mocks — keep this pattern
- Scenario-based E2E tests with doc references
- Clean test directory structure mirroring src
- Descriptive test names

**Overall grade: B+** — Strong server-side test suite with good quality and organization, but significant gaps in API layer, cross-package coverage, and edge case testing.

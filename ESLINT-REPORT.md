# ESLint Report — Flightdeck 2.0

**Date:** 2026-04-12
**Config:** `eslint.config.mjs` (flat config, typescript-eslint)

## Summary

| Metric | Count |
|--------|-------|
| **Errors** | 0 |
| **Warnings** | 99 |
| **Auto-fixed** | 6 (1 `prefer-const` error, 5 `consistent-type-imports`) |

## Warnings by Package

| Package | Warnings |
|---------|----------|
| **server** | 99 |
| shared | 0 |
| web | 0 |
| tui | 0 |
| vscode | 0 |

All issues are in the `server` package — the other packages are clean.

## Warnings by Rule

| Rule | Count | Description |
|------|-------|-------------|
| `@typescript-eslint/no-explicit-any` | 55 | Untyped `any` usage |
| `@typescript-eslint/no-unused-vars` | 44 | Unused variables/imports |

## Top Files by Warning Count

| File | Warnings |
|------|----------|
| `server/src/cli/index.ts` | 34 |
| `server/src/mcp/server.ts` | 20 |
| `server/src/agents/AcpAdapter.ts` | 10 |
| `server/src/verification/ReviewFlow.ts` | 7 |
| `server/src/orchestrator/Orchestrator.ts` | 5 |
| `server/src/storage/SqliteStore.ts` | 4 |
| *(10 more files with 1-3 each)* | |

## What Was Auto-Fixed

- 1× `prefer-const` — `let` → `const` where variable was never reassigned
- 5× `consistent-type-imports` — Added `type` keyword to type-only imports

## Recommendations

1. **`no-explicit-any` (55 warnings):** Most are in `cli/index.ts` (CLI argument handling) and `mcp/server.ts`. Consider:
   - Adding proper types for CLI command handlers and MCP tool parameters
   - Using `unknown` + type guards instead of `any` for external data
   - For truly dynamic cases, suppress with `// eslint-disable-next-line` + a comment explaining why

2. **`no-unused-vars` (44 warnings):** Mostly unused imports and catch-clause variables. Quick wins:
   - Remove unused imports (safe, no behavior change)
   - Prefix intentionally unused vars with `_` (e.g., `_err` in catch blocks)

3. **`cli/index.ts` is the hotspot** — 34 of 99 warnings. A focused cleanup pass on this file would cut warnings by a third.

## Config Details

- TypeScript support via `typescript-eslint`
- `no-console`: warn in library code, off in CLI (`server/src/cli/`, `server/src/mcp/`, `tui/`)
- `consistent-type-imports`: enforced with auto-fix
- Ignores: `dist/`, `node_modules/`, `*.d.ts`; relaxed rules for test files

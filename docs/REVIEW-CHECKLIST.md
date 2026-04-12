# Flightdeck 2.0 — Review Checklist for Subagent Work

## What was requested (from subagent task)

### 1. Role System
- [ ] RoleRegistry at src/roles/RoleRegistry.ts
- [ ] Loads from global (~/.flightdeck/roles/) + project level
- [ ] YAML frontmatter parsing in .md files
- [ ] 7 built-in roles: lead, planner, worker, reviewer, product-thinker, qa-tester, tech-writer
- [ ] Permission-based access control (replaces hardcoded role checks)
- [ ] Reviewer specialists (specialists/ subdirectory)
- [ ] MCP tools: flightdeck_role_list, flightdeck_role_info
- [ ] MCP server role checks updated to use RoleRegistry

### 2. Task Operations
- [ ] cancelTask, pauseTask, skipTask, reopenTask added to TaskDAG
- [ ] 'cancelled' and 'skipped' added to TaskState
- [ ] VALID_TRANSITIONS updated for new states
- [ ] declareTasks (batch) in TaskDAG
- [ ] MCP tools: task_cancel, task_pause, task_retry, task_skip, task_complete, task_reopen, declare_tasks

### 3. Agent Lifecycle
- [ ] MCP tools: agent_spawn, agent_terminate, agent_list, agent_restart, agent_interrupt
- [ ] agent_spawn = lead only, registers in SQLite
- [ ] SqliteStore agent CRUD complete

### 4. Structured Learnings
- [ ] LearningsStore at src/storage/LearningsStore.ts
- [ ] Append-only JSONL
- [ ] Schema: {id, agentId, category, content, tags[], timestamp}
- [ ] MCP tools: learning_add, learning_search

### 5. Cost Tracking
- [ ] recordCost, getCostByAgent, getCostByTask in SqliteStore
- [ ] MCP tool: flightdeck_cost_report (lead only)

### 6. Timer System
- [ ] TimerManager at src/orchestrator/TimerManager.ts
- [ ] MCP tools: timer_set, timer_cancel, timer_list

## Cross-cutting review points
- [ ] All existing tests still pass (npx vitest run)
- [ ] New tests written for each module
- [ ] Windows compat: path.join() not hardcoded /, os.homedir()
- [ ] No hardcoded role strings in MCP server (all through RoleRegistry)
- [ ] test-e2e-*.ts files NOT modified
- [ ] Facade (src/facade.ts) updated to expose new operations
- [ ] Error messages are self-contained (what went wrong + how to fix)

## NOT doing (confirmed with Justin)
- ~~Agent budget / max concurrent~~ — dropped
- ~~Sub-lead~~ — not needed
- ~~Capability acquisition~~ — not needed
- ~~File locking / conflict detection~~ — worktree isolation handles this

## Architecture changes (Justin requested 03:13 UTC)
- [ ] **Database: Switch to Drizzle ORM** — currently using raw better-sqlite3, need to migrate to Drizzle like 1.0
  - Define schema with Drizzle schema definitions (src/db/schema.ts)
  - Use drizzle-orm + drizzle-kit
  - Migrate SqliteStore to use Drizzle queries instead of raw SQL
- [ ] **Packaging: Switch to pnpm workspaces monorepo** — currently single package, need to restructure like 1.0
  - packages/server (core + MCP + CLI)
  - packages/shared (types, protocol, domain)
  - packages/web (future React dashboard)
  - packages/docs (future)
  - Root pnpm-workspace.yaml

## After review
- [ ] Fix any issues found
- [ ] Run full test suite
- [ ] git add + commit + push to github
- [ ] Update README if needed
- [ ] Report to Justin in #flightdeck

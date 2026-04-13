# Design: Subgraph Nesting & Dynamic Fan-out

> Status: **Explorative** — design exploration only, not planned for implementation
> Note: Flightdeck already has `parentTaskId` + `declareSubTasks` (from beads) which covers the subgraph use case. Fan-out is the genuinely new idea here. This doc captures thinking for future reference.
> Author: Claw 🦞
> Date: 2026-04-13
> Context: Inspired by ChatDev 2.0's subgraph nodes and dynamic edge fan-out. Adapted for Flightdeck's ACP-based coding agent architecture.

---

## Background

Flightdeck currently has a flat task DAG: tasks have dependencies, but no concept of "a task that is itself a DAG" or "a task that spawns N copies of itself at runtime." Two patterns from ChatDev 2.0 are worth adapting:

1. **Subgraph nesting** — a task that encapsulates a mini-DAG, executed as a unit
2. **Dynamic fan-out** — a task whose output determines how many parallel tasks to spawn

Both need to work with Flightdeck's fundamentals: MCP tools, ACP agents, SQLite state, and the Lead/Planner/Worker role hierarchy.

---

## 1. Subgraph Nesting (Task Groups)

### What it is

A **task group** is a task whose implementation is a sub-DAG of child tasks. From the parent DAG's perspective, the group is one node. Internally, it's a mini-workflow with its own tasks, dependencies, and completion criteria.

### Why it matters for coding agents

Real software work has natural nesting:
- "Build the auth module" → (design API, write middleware, write tests, integrate)
- "Set up CI" → (write workflow file, add secrets config, verify with dry run)

Today in Flightdeck, the Planner flattens everything into one level. Task groups let the Planner say "this is a chunk of related work — figure out the internals later."

### Design

#### Schema

```sql
-- New column on tasks table
ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES tasks(id);
-- A task with group_id is a child of that group task
-- The group task itself has type = 'group'
```

```typescript
// Task creation via MCP
interface CreateTaskParams {
  title: string;
  description?: string;
  type?: 'task' | 'group';  // NEW
  parentGroup?: string;      // NEW — group task ID
  dependencies?: string[];
  role?: string;
  // ...existing fields
}
```

#### Behavior

**Creating a group:**
```
Planner creates task "Build auth module" (type: group)
  → returns task ID "task-auth"

Planner creates child tasks:
  "Design auth API"      (parentGroup: "task-auth")
  "Write auth middleware" (parentGroup: "task-auth", depends on: "Design auth API")  
  "Write auth tests"     (parentGroup: "task-auth", depends on: "Write auth middleware")
```

**Execution rules:**
- A group task is **not assigned to a worker**. It has no agent.
- A group is `in_progress` when any child is `in_progress` or `pending`.
- A group is `completed` when **all children** are `completed`.
- A group is `failed` if **any child** is `failed` (configurable: fail-fast vs continue).
- Children follow normal DAG rules within the group.
- Cross-group dependencies are allowed: a task in group B can depend on a task in group A.

**Nesting depth:**
- Groups can contain groups (recursive). Max depth = 3 (configurable). This covers "epic → story → subtask" patterns without going crazy.

**Visibility:**
- `task_list` MCP tool gains a `groupId` filter.
- `task_compact` shows groups as collapsed summaries by default.
- Dashboard shows groups as expandable cards.

#### MCP tools

```
declare_task_group    — Create a group task + its children in one call
expand_group          — Add more children to an existing group  
collapse_group_status — Get summary: "3/5 done, 1 in progress, 1 blocked"
```

**Example — Planner perspective:**

```
// Planner calls declare_task_group:
{
  "group": {
    "title": "Build auth module",
    "description": "JWT-based auth with refresh tokens"
  },
  "tasks": [
    { "id": "auth-design", "title": "Design auth API", "role": "worker" },
    { "id": "auth-impl", "title": "Implement middleware", "role": "worker", "dependencies": ["auth-design"] },
    { "id": "auth-test", "title": "Write tests", "role": "worker", "dependencies": ["auth-impl"] },
    { "id": "auth-review", "title": "Review auth module", "role": "reviewer", "dependencies": ["auth-test"] }
  ]
}
// Returns: group task ID + all child IDs
```

**Example — Lead perspective:**

```
// Lead sees in task_compact:
// ┌─ [group] Build auth module (2/4 done)
// │   ├─ ✅ Design auth API
// │   ├─ ✅ Implement middleware  
// │   ├─ 🔄 Write tests (agent: worker-3)
// │   └─ ⏳ Review auth module (blocked)
```

### What this does NOT do

- Does not change how agents work. Workers still claim individual tasks.
- Does not introduce sub-DAG execution engines. The existing DAG scheduler handles children like normal tasks, just scoped.
- Does not require YAML. Groups are created programmatically by Planner/Lead.

---

## 2. Dynamic Fan-out

### What it is

A task produces output that implies "do this N times in parallel." The system automatically creates N task instances from a template.

### Why it matters for coding agents

- "Run tests on all 5 packages" → fan out to 5 parallel test tasks
- "Review all changed files" → fan out to N file review tasks
- "Migrate all API endpoints from v1 to v2" → fan out per endpoint

The key: **N is not known at planning time.** It comes from the output of a preceding task.

### Design

#### Schema

```sql
-- New columns on tasks table
ALTER TABLE tasks ADD COLUMN fan_out_template TEXT;  -- JSON template for spawned tasks
ALTER TABLE tasks ADD COLUMN fan_out_source TEXT REFERENCES tasks(id);  -- which task triggered fan-out
ALTER TABLE tasks ADD COLUMN fan_out_index INTEGER;  -- 0-based index in the fan-out batch
```

#### How it works

**Step 1: Planner declares a fan-out point**

```
// Planner creates:
{
  "title": "Discover packages to test",
  "role": "worker",
  "fanOut": {
    "template": {
      "title": "Test package: {{item.name}}",
      "description": "Run full test suite for {{item.name}} at {{item.path}}",
      "role": "worker"
    },
    "collectInto": "merge-test-results"  // optional: task that waits for all fan-out tasks
  }
}
```

**Step 2: Worker completes the discovery task**

Worker submits result with a structured `fanOutItems` field:

```
// Worker calls task_submit:
{
  "taskId": "discover-packages",
  "result": "Found 4 packages",
  "fanOutItems": [
    { "name": "@flightdeck/core", "path": "packages/core" },
    { "name": "@flightdeck/cli", "path": "packages/cli" },
    { "name": "@flightdeck/mcp", "path": "packages/mcp" },
    { "name": "@flightdeck/web", "path": "packages/web" }
  ]
}
```

**Step 3: System auto-creates N tasks**

Flightdeck reads the template, interpolates each item, creates 4 tasks:
- "Test package: @flightdeck/core"
- "Test package: @flightdeck/cli"
- "Test package: @flightdeck/mcp"
- "Test package: @flightdeck/web"

All 4 are children of an auto-created group. All 4 can run in parallel. If `collectInto` is specified, that task gets unblocked when all 4 complete.

**Step 4: Fan-in (collect)**

The `merge-test-results` task receives all 4 results as input context. It can summarize, aggregate, or decide next steps.

#### Constraints

- **Max fan-out: 20** (configurable). Prevents runaway spawning. If items > 20, chunk into batches.
- **Template variables:** `{{item.fieldName}}`, `{{index}}`, `{{total}}`, `{{source.title}}`
- **Fan-out tasks inherit** the project, priority, and tags of the source task.
- **No nested fan-out.** A fan-out task cannot itself fan out. (Keep it simple for v1.)

#### MCP tools

No new tools needed. Fan-out is triggered by including `fanOutItems` in `task_submit`. The Planner declares intent via the template in `task_create`.

#### Example — Full flow

```
Planner creates DAG:
  
  [discover-files] ──fan-out──> [lint-file: {{item}}] ──collect──> [report-results]
                                     (N copies)

1. Worker claims "discover-files", runs `find src -name '*.ts'`, submits:
   fanOutItems: ["auth.ts", "db.ts", "api.ts", "utils.ts", "types.ts"]

2. System creates 5 "lint-file" tasks, all parallel, in a group.

3. 5 workers each claim one, run eslint, submit results.

4. When all 5 complete, "report-results" is unblocked.
   Its input context contains all 5 lint outputs.
   Worker summarizes: "3 clean, 2 have warnings."
```

---

## How they compose

Subgraph + fan-out combine naturally:

```
[Plan migration] 
  → fan-out → [Migrate endpoint: {{item}}]  (each is a GROUP containing: modify, test, review)
  → collect → [Integration test all endpoints]
```

The fan-out creates N groups, each group is a sub-DAG. This handles complex parallel-then-converge workflows without the Planner having to know N upfront.

---

## What we're NOT doing (conscious scope limits)

1. **No YAML workflow files.** Flightdeck's DAGs are created by agents via MCP tools, not by humans editing YAML. The Planner IS the workflow author.
2. **No visual DAG editor.** Dashboard shows the DAG read-only. Editing is via Planner.
3. **No dynamic edge conditions.** Edges (dependencies) are static once created. Fan-out is the only runtime graph mutation.
4. **No recursive fan-out.** One level only. If you need deeper nesting, use groups inside fan-out.
5. **No ChatDev-style "cycle execution."** If you need retry loops, the reviewer rejects and the worker re-claims. No explicit cycle edges.

---

## Implementation priority

| Feature | Complexity | Value | Priority |
|---|---|---|---|
| Task groups (basic) | Low | High | P1 — do first |
| Group status rollup | Low | Medium | P1 |
| `declare_task_group` MCP tool | Low | High | P1 |
| Dynamic fan-out (template + spawn) | Medium | High | P2 |
| Fan-in (collect) | Medium | Medium | P2 |
| Nested groups (depth > 1) | Low | Low | P3 |
| Dashboard group visualization | Medium | Medium | P3 |

Start with task groups — it's mostly a `group_id` column + a few MCP tools + status rollup logic. Fan-out builds on top of groups.

---

## Open questions

1. **Should the Lead be able to fan-out, or only Planner?** Probably both — Lead might discover at runtime that work needs splitting.
2. **Fan-out + file locking:** If 5 parallel tasks all touch the same repo, file locking becomes critical. Current locking should handle it, but need to verify under fan-out load.
3. **Fan-out cost:** Each spawned task needs an ACP agent. 20 parallel agents = 20 processes. Memory implications on 16GB? Probably fine if they're not all active simultaneously.
4. **Template language:** `{{item.name}}` is simple Mustache-style. Do we need conditionals? Probably not for v1.

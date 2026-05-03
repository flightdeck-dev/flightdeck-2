# SQLite Tuning Guide for Flightdeck 2.0

This guide covers SQLite configuration and indexing decisions specific to Flightdeck's workload: a single-server multi-agent orchestrator with moderate write throughput, frequent status polling, and append-heavy audit logs.

## 1. WAL Mode vs Rollback Journal

### Current Configuration

Flightdeck already enables WAL mode in two places:

```typescript
// database.ts
sqlite.pragma('journal_mode = WAL');

// SqliteStore constructor (redundant — can be removed)
this._db.run(sql.raw('PRAGMA journal_mode=WAL'));
```

**Action:** Remove the duplicate WAL pragma in `SqliteStore.constructor`. The one in `createDatabase()` is sufficient and executes first.

### Why WAL Is Correct for Flightdeck

| Factor | WAL | Rollback Journal |
|--------|-----|------------------|
| Concurrent reads during writes | ✅ Readers don't block writers | ❌ Writers block all readers |
| Write throughput | Single writer, but readers proceed | Single writer, readers wait |
| Crash safety | Equivalent (both ACID) | Equivalent |
| File count | 3 files (db, -wal, -shm) | 1 file |
| Checkpoint overhead | Periodic (auto at 1000 pages) | None |

Flightdeck's access pattern is **many reads, moderate writes**:

- The orchestrator polls task states every tick (~5-30s)
- MCP tool calls read tasks/agents/messages on every request
- Writes happen when tasks transition states, agents heartbeat, or messages arrive
- Multiple components (orchestrator, MCP handlers, webhook notifier) read concurrently

WAL is the clear winner here. Rollback journal would cause the MCP read handlers to stall whenever the orchestrator writes a state transition — unacceptable for an interactive tool server.

### WAL Pitfalls to Watch

1. **WAL file growth:** If Flightdeck runs for days without checkpointing, the WAL file can grow large. SQLite auto-checkpoints at 1000 pages by default (4MB with 4KB pages), which is fine. If you see WAL files >50MB, something is wrong.

2. **Network filesystems:** WAL requires shared-memory (`-shm` file) and doesn't work on NFS/SMB. Flightdeck stores its DB locally, so this isn't an issue — but don't move the DB to a network mount.

3. **Long-running read transactions:** A `SELECT` that stays open prevents WAL checkpointing. Flightdeck uses `better-sqlite3` which is synchronous, so transactions are short-lived. No issue here.

## 2. Index Analysis

### Existing Indexes (from schema.sql)

Flightdeck defines 18 indexes across its tables. Here's an analysis of each:

#### ✅ Well-Placed Indexes

| Index | Table | Used By |
|-------|-------|---------|
| `idx_tasks_state` | tasks(state) | `getTasksByState()`, orchestrator tick polling for `ready`/`running` tasks |
| `idx_tasks_spec` | tasks(spec_id) | `listTasks(specId)`, `cancelTasksBySpec()`, `markTasksStaleBySpec()` |
| `idx_tasks_assigned_agent` | tasks(assigned_agent) | `resetOrphanedTasks()` subquery |
| `idx_tasks_parent` | tasks(parent_task_id) | `getSubTasks()` |
| `idx_mq_target_status` | message_queue(target_agent_id, status) | Queue polling — composite index is correct |
| `idx_messages_thread` | messages(thread_id) | Thread message retrieval |
| `idx_messages_task` | messages(task_id) | Task-scoped message lookup |
| `idx_task_events_task` | task_events(task_id) | `getTaskEvents()` |
| `idx_cost_entries_agent` | cost_entries(agent_id) | `getAgentTokenUsage()`, `getTokenUsageByAgent()` |
| `idx_escalations_status` | escalations(status) | `listEscalations(status)`, `countPendingEscalations()` |

#### ⚠️ Low-Value Indexes (Consider Removing)

| Index | Reason |
|-------|--------|
| `idx_agents_status` | `agents` table is tiny (typically <20 rows). Full scan is faster than index lookup. |
| `idx_agents_role` | Same — tiny table, no benefit from indexing. |
| `idx_messages_author_type` | Low cardinality (4 values). SQLite's query planner will often skip this. Only useful in compound queries. |
| `idx_messages_channel` | Low cardinality unless many channels. Monitor usage. |
| `idx_messages_recipient` | Similar to channel — low cardinality in most deployments. |
| `idx_activity_type` | Activity log is append-only; reads are rare. Index adds write overhead for little gain. |

Each unnecessary index adds ~5-15% write overhead per INSERT on that table. For high-traffic tables like `messages` and `activity_log`, removing unused indexes has measurable impact.

#### 🆕 Recommended New Indexes

**1. Composite index for task listing with ordering:**

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_spec_priority
  ON tasks (spec_id, priority DESC, created_at ASC);
```

`listTasks(specId)` queries `WHERE spec_id = ? ORDER BY priority DESC, created_at ASC`. Currently this uses `idx_tasks_spec` for the filter but requires a filesort for ordering. A composite covering index eliminates the sort.

**2. Composite index for message queue delivery:**

The existing `idx_mq_target_status` is already composite and correct. No change needed.

**3. Task events by timestamp range:**

```sql
CREATE INDEX IF NOT EXISTS idx_task_events_task_ts
  ON task_events (task_id, timestamp);
```

`getTaskEvents(taskId)` filters by `task_id` and orders by `timestamp`. The current separate indexes can't serve both efficiently. A composite index handles filter + sort in one scan.

**4. Cost entries composite for per-agent-per-model aggregation:**

```sql
CREATE INDEX IF NOT EXISTS idx_cost_entries_agent_model
  ON cost_entries (agent_id, model);
```

`getTokenUsageByAgent()` groups by `(agent_id, model)`. This composite index turns the GROUP BY into an index scan.

### Index Summary

| Action | Index | Impact |
|--------|-------|--------|
| **Add** | `idx_tasks_spec_priority` | Eliminates filesort on main task listing |
| **Add** | `idx_task_events_task_ts` | Faster event retrieval per task |
| **Add** | `idx_cost_entries_agent_model` | Faster cost aggregation |
| **Drop** | `idx_agents_status`, `idx_agents_role` | Tiny table, wasted overhead |
| **Monitor** | `idx_messages_author_type`, `idx_activity_type` | Drop if not queried by those columns alone |

## 3. Page Size Considerations

SQLite default page size is **4096 bytes** (4KB). Flightdeck doesn't explicitly set it, so it uses the default.

### Should You Change It?

| Page Size | Best For | Trade-off |
|-----------|----------|-----------|
| 4096 (default) | Mixed workloads, small-medium rows | Good balance |
| 8192 | Tables with large TEXT columns | Less overflow, fewer I/O ops |
| 16384 | Bulk reads of large records | Higher memory per page cache entry |
| 32768 | FTS and large BLOBs | Wastes memory for small queries |

Flightdeck has several tables with potentially large TEXT columns:
- `tasks.description` — can be multi-paragraph
- `tasks.context` — JSON context blob
- `messages.content` — full message text, can be very long
- `activity_log.details` — JSON details
- `messages.attachments` — JSON array of attachments

When a TEXT value exceeds the page payload capacity (~3.9KB for 4KB pages), SQLite stores it in **overflow pages**, requiring extra I/O to read.

**Recommendation: Increase to 8192 bytes.** This doubles the inline payload capacity, reducing overflow for message content and task descriptions. The memory cost is minimal — Flightdeck's default cache of 2000 pages would use 16MB instead of 8MB.

```sql
-- Must be set BEFORE any tables are created (on a new database)
-- or via VACUUM after changing
PRAGMA page_size = 8192;
VACUUM;
```

**Important:** `page_size` can only be changed on an empty database or by running `VACUUM` after setting it. For existing deployments, add this to a migration:

```typescript
// In createDatabase(), before schema creation:
sqlite.pragma('page_size = 8192');
sqlite.exec('VACUUM');  // Rewrites entire DB — one-time cost
sqlite.pragma('journal_mode = WAL');
```

## 4. PRAGMA Recommendations

### Current PRAGMAs

```typescript
sqlite.pragma('journal_mode = WAL');    // ✅ Good
sqlite.pragma('foreign_keys = ON');     // ✅ Good (though no FK constraints in schema)
```

### Recommended Additions

Add these to `createDatabase()` in `database.ts`:

```typescript
export function createDatabase(dbPath: string): FlightdeckDatabase {
  const sqlite = new Database(dbPath);

  // Performance PRAGMAs (set before WAL)
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');    // Safe with WAL; reduces fsync calls
  sqlite.pragma('cache_size = -16000');     // 16MB page cache (negative = KB)
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');     // Wait 5s on lock instead of failing immediately
  sqlite.pragma('temp_store = MEMORY');     // Temp tables/indexes in RAM
  sqlite.pragma('mmap_size = 268435456');   // 256MB memory-mapped I/O

  return drizzle(sqlite, { schema });
}
```

#### Explanation of Each

**`synchronous = NORMAL`** (currently defaults to `FULL`)

In WAL mode, `NORMAL` is safe against data corruption on power loss. The only risk is losing the last transaction in a crash — but Flightdeck isn't a bank. Task state can be reconstructed from the orchestrator. This reduces fsync calls from every commit to periodic checkpoints, typically **2-5x faster writes**.

> ⚠️ `synchronous = OFF` is NOT recommended. It risks database corruption on OS crash.

**`cache_size = -16000`** (16MB, up from default ~2MB)

Flightdeck's orchestrator repeatedly reads the same task and agent rows. A larger cache means these stay in memory between ticks. 16MB is conservative for a server process. The negative value specifies kilobytes.

For a VPS with ≥1GB RAM, you could go higher (`-32000` = 32MB). The sweet spot is roughly `cache_size ≈ DB file size` so the entire database lives in cache.

**`busy_timeout = 5000`**

Without this, concurrent write attempts immediately fail with `SQLITE_BUSY`. Flightdeck is single-threaded (Node.js + better-sqlite3), so this is mostly insurance for edge cases like:
- CLI tools accessing the DB while the server runs
- Future multi-process deployments
- `VACUUM` or checkpoint operations

5 seconds is generous. In practice, WAL locks resolve in <10ms.

**`temp_store = MEMORY`**

Directs SQLite to use RAM for temporary tables and indexes (used internally for sorting, grouping). Since Flightdeck queries are small-result-set, this avoids unnecessary temp file I/O.

**`mmap_size = 268435456`** (256MB)

Memory-mapped I/O lets SQLite read the database file via the OS page cache without copying into its own buffer. This can significantly speed up read-heavy workloads. 256MB is enough for any Flightdeck database (typical size: <50MB).

> ⚠️ On 32-bit systems or constrained environments (Raspberry Pi with <512MB RAM), reduce or disable mmap.

### PRAGMAs NOT Recommended

| PRAGMA | Why Not |
|--------|---------|
| `synchronous = OFF` | Risks corruption |
| `locking_mode = EXCLUSIVE` | Prevents CLI tools from reading the DB |
| `auto_vacuum = FULL` | Adds overhead on every DELETE; Flightdeck rarely deletes rows |
| `journal_size_limit` | Auto-checkpoint handles WAL size; manual limits can cause issues |

## 5. FTS5 Considerations

Flightdeck uses FTS5 for full-text message search:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED, author_type UNINDEXED, author_id UNINDEXED,
  content, tokenize='porter unicode61'
);
```

FTS5 tables have their own storage and aren't affected by `page_size`. However:

1. **Keep FTS in sync:** Ensure INSERT/UPDATE/DELETE on `messages` triggers corresponding FTS updates. Currently this isn't visible in the schema (no triggers). If FTS sync is manual, verify it's happening.

2. **FTS writes are expensive:** Each message insert writes to both `messages` and `messages_fts`. If you batch-insert messages (e.g., importing history), wrap in a transaction.

3. **Rebuild periodically:** `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` can be run during maintenance to optimize the FTS index.

## 6. Query-Specific Analysis

### Hot Path: Orchestrator Tick

The orchestrator tick is the most frequent read pattern. It calls:

1. `getTasksByState('ready')` → `SELECT * FROM tasks WHERE state = 'ready'`
2. `listAgents()` → `SELECT * FROM agents` (full scan, fine for <20 rows)
3. `getActiveAgentCount()` → `SELECT COUNT(*) FROM agents WHERE status IN ('idle', 'busy')`

The `idx_tasks_state` index serves query 1 well. Query 3 does a tiny table scan — no optimization needed.

### Hot Path: MCP Tool Calls

MCP handlers serve external requests. Key queries:

1. `listTasks(specId)` → `SELECT * FROM tasks WHERE spec_id = ? ORDER BY priority DESC, created_at ASC`
2. `getTask(id)` → primary key lookup (instant)
3. `getMessage(id)` → primary key lookup (instant)

Query 1 benefits from the proposed `idx_tasks_spec_priority` composite index.

### Hot Path: Message Queue Polling

```sql
SELECT * FROM message_queue WHERE target_agent_id = ? AND status = 'queued'
```

The existing `idx_mq_target_status` composite index handles this perfectly. No change needed.

### Write Path: State Transitions

`updateTaskState()` does a read-then-write pattern:

```typescript
const oldTask = this.getTask(id);        // SELECT by PK
this.logTaskEvent(id, fromState, ...);   // INSERT into task_events
this._db.update(tasks).set({...}).where(eq(tasks.id, id)).run();  // UPDATE by PK
```

This is 3 operations per state change. With `synchronous = NORMAL`, each runs ~1ms instead of ~5ms. Over a project with hundreds of state transitions, this adds up.

## 7. Monitoring

Add a periodic health check (e.g., in the orchestrator's timer):

```sql
-- Check WAL file size
PRAGMA wal_checkpoint(PASSIVE);

-- Check page cache hit ratio
PRAGMA cache_stats;

-- Check index usage (run manually during development)
EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE spec_id = 'test' ORDER BY priority DESC;
```

For development, the SQLite `sqlite3_analyzer` tool can show space usage per table and index, helping identify bloat.

## Summary of Recommendations

| Priority | Change | Expected Impact |
|----------|--------|-----------------|
| 🔴 High | Add `synchronous = NORMAL` | 2-5x faster writes |
| 🔴 High | Add `busy_timeout = 5000` | Prevents SQLITE_BUSY errors |
| 🟡 Medium | Add `cache_size = -16000` | Keeps hot data in memory |
| 🟡 Medium | Add `temp_store = MEMORY` | Faster sorts/aggregations |
| 🟡 Medium | Add `mmap_size = 268435456` | Faster reads via OS page cache |
| 🟡 Medium | Add `idx_tasks_spec_priority` composite index | Eliminates filesort |
| 🟢 Low | Add `idx_task_events_task_ts` composite | Faster event queries |
| 🟢 Low | Add `idx_cost_entries_agent_model` composite | Faster cost reports |
| 🟢 Low | Drop `idx_agents_status`, `idx_agents_role` | Cleaner, marginally faster agent writes |
| 🟢 Low | Increase `page_size` to 8192 | Fewer overflow pages for large text |
| 🟢 Low | Remove duplicate WAL pragma in SqliteStore | Code cleanup |

---

*Last updated: 2026-05-03. Based on Flightdeck 2.0 schema as of packages/server/sql/schema.sql.*

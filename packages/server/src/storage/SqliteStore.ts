import { eq, sql, count } from 'drizzle-orm';
import { tasks, agents, costEntries, specHashes } from '../db/schema.js';
import { createDatabase, type FlightdeckDatabase } from '../db/database.js';
import type { Task, Agent, CostEntry, TaskId, AgentId, TaskState, SpecId } from '@flightdeck-ai/shared';

export class SqliteStore {
  private _db: FlightdeckDatabase;

  get db(): FlightdeckDatabase {
    return this._db;
  }

  constructor(dbPath: string) {
    this._db = createDatabase(dbPath);
    // Enable WAL mode for better concurrent read performance
    this._db.run(sql.raw('PRAGMA journal_mode=WAL'));
    this.migrate();
  }

  private migrate(): void {
    // Use raw SQL for CREATE TABLE IF NOT EXISTS — Drizzle doesn't have a built-in "push" at runtime
    // We access the underlying better-sqlite3 instance via a raw query
    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT,
        parent_task_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending',
        role TEXT NOT NULL DEFAULT 'worker',
        depends_on TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 0,
        assigned_agent TEXT,
        acp_session_id TEXT,
        claim TEXT,
        source TEXT NOT NULL DEFAULT 'planned',
        cost REAL DEFAULT 0,
        compacted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `));

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'acp',
        acp_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_spec_id TEXT,
        cost_accumulated REAL NOT NULL DEFAULT 0,
        last_heartbeat TEXT
      )
    `));

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS cost_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        spec_id TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      )
    `));

    // ── Migrations ──

    // Add stale column to tasks (FR-008)
    const staleCols = this._db.all(sql.raw("PRAGMA table_info(tasks)")) as { name: string }[];
    if (!staleCols.some(c => c.name === 'stale')) {
      this._db.run(sql.raw(`ALTER TABLE tasks ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`));
    }

    // Spec hashes table for change detection (FR-008)
    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS spec_hashes (
        spec_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `));

    // ── New tables ──

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS file_locks (
        file_path TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        reason TEXT DEFAULT '',
        acquired_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        expires_at TEXT NOT NULL
      )
    `));

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        action_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `));

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_agent_id TEXT NOT NULL,
        source_agent_id TEXT,
        message_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        delivered_at TEXT
      )
    `));

    // Messages + threads tables (Web UI chat) — must be before indexes that reference them
    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        parent_id TEXT,
        task_id TEXT,
        author_type TEXT NOT NULL,
        author_id TEXT,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (parent_id) REFERENCES messages(id)
      )
    `));

    this._db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        origin_id TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY (origin_id) REFERENCES messages(id)
      )
    `));

    // ── Indexes ──

    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_tasks_spec ON tasks(spec_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_messages_author_type ON messages(author_type)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cost_entries_spec ON cost_entries(spec_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_file_locks_agent ON file_locks(agent_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_id)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(action_type)`));
    this._db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_mq_target_status ON message_queue(target_agent_id, status)`));

    // Migrations for older databases
    const cols = this._db.all(sql.raw("PRAGMA table_info(tasks)")) as { name: string }[];
    if (!cols.some(c => c.name === 'claim')) {
      this._db.run(sql.raw('ALTER TABLE tasks ADD COLUMN claim TEXT'));
    }
    if (!cols.some(c => c.name === 'cost')) {
      this._db.run(sql.raw('ALTER TABLE tasks ADD COLUMN cost REAL DEFAULT 0'));
    }
    if (!cols.some(c => c.name === 'source')) {
      this._db.run(sql.raw("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'planned'"));
    }
    if (!cols.some(c => c.name === 'parent_task_id')) {
      this._db.run(sql.raw('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT'));
    }
    if (!cols.some(c => c.name === 'compacted_at')) {
      this._db.run(sql.raw('ALTER TABLE tasks ADD COLUMN compacted_at TEXT'));
    }

    // Migrate cost_entries for older databases
    const costCols = this._db.all(sql.raw("PRAGMA table_info(cost_entries)")) as { name: string }[];
    if (!costCols.some(c => c.name === 'cache_read_tokens')) {
      this._db.run(sql.raw('ALTER TABLE cost_entries ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0'));
    }
    if (!costCols.some(c => c.name === 'cache_write_tokens')) {
      this._db.run(sql.raw('ALTER TABLE cost_entries ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0'));
    }
  }

  // ── Tasks ──

  insertTask(task: Task): void {
    this._db.insert(tasks).values({
      id: task.id,
      specId: task.specId,
      parentTaskId: task.parentTaskId ?? null,
      title: task.title,
      description: task.description,
      state: task.state,
      role: task.role,
      dependsOn: JSON.stringify(task.dependsOn),
      priority: task.priority,
      assignedAgent: task.assignedAgent,
      acpSessionId: task.acpSessionId,
      source: task.source || 'planned',
      stale: task.stale,
      compactedAt: task.compactedAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }).run();
  }

  getTask(id: TaskId): Task | null {
    const row = this._db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? this.rowToTask(row) : null;
  }

  listTasks(specId?: SpecId): Task[] {
    const query = specId
      ? this._db.select().from(tasks).where(eq(tasks.specId, specId)).orderBy(sql`priority DESC, created_at ASC`)
      : this._db.select().from(tasks).orderBy(sql`priority DESC, created_at ASC`);
    return query.all().map(r => this.rowToTask(r));
  }

  updateTaskState(id: TaskId, state: TaskState, agentId?: AgentId | null): void {
    const now = new Date().toISOString();
    if (agentId !== undefined) {
      this._db.update(tasks)
        .set({ state, assignedAgent: agentId, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    } else {
      this._db.update(tasks)
        .set({ state, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    }
  }

  deleteTask(id: TaskId): void {
    this._db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  getTasksByState(state: TaskState): Task[] {
    return this._db.select().from(tasks).where(eq(tasks.state, state)).all().map(r => this.rowToTask(r));
  }

  getTaskStats(): Record<TaskState, number> {
    const rows = this._db.select({
      state: tasks.state,
      count: count(),
    }).from(tasks).groupBy(tasks.state).all();
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.state] = row.count;
    }
    return stats as Record<TaskState, number>;
  }

  updateTaskClaim(id: TaskId, claim: string): void {
    const now = new Date().toISOString();
    this._db.update(tasks)
      .set({ claim, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  clearTaskAssignment(id: TaskId): void {
    const now = new Date().toISOString();
    this._db.update(tasks)
      .set({ assignedAgent: null, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  updateTaskDependsOn(id: TaskId, deps: TaskId[]): void {
    const now = new Date().toISOString();
    this._db.update(tasks)
      .set({ dependsOn: JSON.stringify(deps), updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  updateTaskParent(id: TaskId, parentTaskId: TaskId): void {
    const now = new Date().toISOString();
    this._db.update(tasks)
      .set({ parentTaskId, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  compactTask(id: TaskId, summary: string): void {
    const now = new Date().toISOString();
    this._db.update(tasks)
      .set({ description: summary, compactedAt: now, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  getSubTasks(parentTaskId: TaskId): Task[] {
    return this._db.select().from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId))
      .all().map(r => this.rowToTask(r));
  }

  private rowToTask(row: typeof tasks.$inferSelect): Task {
    return {
      id: row.id as TaskId,
      specId: (row.specId ?? null) as SpecId | null,
      parentTaskId: (row.parentTaskId ?? null) as TaskId | null,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      role: row.role as Task['role'],
      dependsOn: JSON.parse(row.dependsOn) as TaskId[],
      priority: row.priority,
      assignedAgent: (row.assignedAgent ?? null) as AgentId | null,
      acpSessionId: (row.acpSessionId ?? null) as string | null,
      source: (row.source as Task['source']) || 'planned',
      stale: Boolean(row.stale),
      compactedAt: (row.compactedAt ?? null) as string | null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Agents ──

  insertAgent(agent: Agent): void {
    this._db.insert(agents).values({
      id: agent.id,
      role: agent.role,
      runtime: agent.runtime,
      acpSessionId: agent.acpSessionId,
      status: agent.status,
      currentSpecId: agent.currentSpecId,
      costAccumulated: agent.costAccumulated,
      lastHeartbeat: agent.lastHeartbeat,
    }).run();
  }

  getAgent(id: AgentId): Agent | null {
    const row = this._db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? this.rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    return this._db.select().from(agents).all().map(r => this.rowToAgent(r));
  }

  updateAgentStatus(id: AgentId, status: Agent['status']): void {
    this._db.update(agents).set({ status }).where(eq(agents.id, id)).run();
  }

  updateAgentAcpSession(id: AgentId, acpSessionId: string | null): void {
    this._db.update(agents).set({ acpSessionId }).where(eq(agents.id, id)).run();
  }

  updateAgentHeartbeat(id: AgentId): void {
    this._db.update(agents)
      .set({ lastHeartbeat: new Date().toISOString() })
      .where(eq(agents.id, id))
      .run();
  }

  deleteAgent(id: AgentId): boolean {
    const result = this._db.delete(agents).where(eq(agents.id, id)).run();
    return result.changes > 0;
  }

  /** Remove all agents with status 'offline'. Returns count deleted. */
  purgeOfflineAgents(): number {
    const result = this._db.delete(agents).where(eq(agents.status, 'offline')).run();
    return result.changes;
  }

  /** List all agents with status 'suspended'. */
  listSuspendedAgents(): Agent[] {
    return this._db.select().from(agents).where(eq(agents.status, 'suspended')).all().map(r => this.rowToAgent(r));
  }

  getActiveAgentCount(): number {
    const row = this._db.select({ count: count() })
      .from(agents)
      .where(sql`${agents.status} IN ('idle', 'busy')`)
      .get();
    return row?.count ?? 0;
  }

  recordCost(agentId: AgentId, amount: number): void {
    this._db.update(agents)
      .set({ costAccumulated: sql`${agents.costAccumulated} + ${amount}` })
      .where(eq(agents.id, agentId))
      .run();
  }

  getCostByAgent(): Array<{ agentId: string; cost: number }> {
    return this._db.select({
      agentId: agents.id,
      cost: agents.costAccumulated,
    }).from(agents).orderBy(sql`${agents.costAccumulated} DESC`).all();
  }

  getCostByTask(): Array<{ taskId: string; cost: number }> {
    return this._db.select({
      taskId: tasks.id,
      cost: sql<number>`COALESCE(${tasks.cost}, 0)`,
    }).from(tasks).orderBy(sql`${tasks.cost} DESC`).all();
  }

  recordTaskCost(taskId: TaskId, amount: number): void {
    this._db.update(tasks)
      .set({ cost: sql`COALESCE(${tasks.cost}, 0) + ${amount}` })
      .where(eq(tasks.id, taskId))
      .run();
  }

  private rowToAgent(row: typeof agents.$inferSelect): Agent {
    return {
      id: row.id as AgentId,
      role: row.role as Agent['role'],
      runtime: row.runtime as Agent['runtime'],
      acpSessionId: (row.acpSessionId ?? null) as string | null,
      status: row.status as Agent['status'],
      currentSpecId: (row.currentSpecId ?? null) as SpecId | null,
      costAccumulated: row.costAccumulated,
      lastHeartbeat: (row.lastHeartbeat ?? null) as string | null,
    };
  }

  // ── Cost ──

  insertCostEntry(entry: CostEntry): void {
    this._db.insert(costEntries).values({
      agentId: entry.agentId,
      specId: entry.specId,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheWriteTokens: entry.cacheWriteTokens ?? 0,
      costUsd: entry.costUsd,
      timestamp: entry.timestamp,
    }).run();
  }

  getTotalCost(specId?: SpecId): number {
    const row = specId
      ? this._db.select({ total: sql<number>`COALESCE(SUM(${costEntries.costUsd}), 0)` })
          .from(costEntries).where(eq(costEntries.specId, specId)).get()
      : this._db.select({ total: sql<number>`COALESCE(SUM(${costEntries.costUsd}), 0)` })
          .from(costEntries).get();
    return row?.total ?? 0;
  }

  close(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal drizzle client property
    (this._db as any).$client.close();
  }

  // ── Spec Hashes (FR-008) ──

  getSpecHash(specId: SpecId): string | null {
    const row = this._db.select().from(specHashes).where(eq(specHashes.specId, specId as string)).get();
    return row?.contentHash ?? null;
  }

  upsertSpecHash(specIdVal: SpecId, contentHash: string): void {
    const now = new Date().toISOString();
    // SQLite upsert
    this._db.run(sql`INSERT INTO spec_hashes (spec_id, content_hash, updated_at) VALUES (${specIdVal as string}, ${contentHash}, ${now}) ON CONFLICT(spec_id) DO UPDATE SET content_hash = ${contentHash}, updated_at = ${now}`);
  }

  getAllSpecHashes(): Map<string, string> {
    const rows = this._db.select().from(specHashes).all();
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.specId, r.contentHash);
    return map;
  }

  // ── Task Staleness (FR-008) ──

  markTasksStaleBySpec(specId: SpecId): number {
    const now = new Date().toISOString();
    const result = this._db.run(sql`UPDATE tasks SET stale = 1, updated_at = ${now} WHERE spec_id = ${specId as string} AND state NOT IN ('done', 'skipped', 'cancelled')`);
    return result.changes;
  }

  clearTaskStale(id: TaskId): void {
    this._db.run(sql`UPDATE tasks SET stale = 0 WHERE id = ${id as string}`);
  }
}

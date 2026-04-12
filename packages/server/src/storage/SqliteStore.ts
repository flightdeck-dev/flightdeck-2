import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, sql, and, count } from 'drizzle-orm';
import { tasks, agents, costEntries } from '../db/schema.js';
import { createDatabase, type FlightdeckDatabase } from '../db/database.js';
import type { Task, Agent, CostEntry, TaskId, AgentId, TaskState, SpecId } from '@flightdeck-ai/shared';

export class SqliteStore {
  private db: FlightdeckDatabase;

  constructor(dbPath: string) {
    this.db = createDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    // Use raw SQL for CREATE TABLE IF NOT EXISTS — Drizzle doesn't have a built-in "push" at runtime
    // We access the underlying better-sqlite3 instance via a raw query
    this.db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT,
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `));

    this.db.run(sql.raw(`
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

    this.db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS cost_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        spec_id TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      )
    `));

    // Migrations for older databases
    const cols = this.db.all(sql.raw("PRAGMA table_info(tasks)")) as { name: string }[];
    if (!cols.some(c => c.name === 'claim')) {
      this.db.run(sql.raw('ALTER TABLE tasks ADD COLUMN claim TEXT'));
    }
    if (!cols.some(c => c.name === 'cost')) {
      this.db.run(sql.raw('ALTER TABLE tasks ADD COLUMN cost REAL DEFAULT 0'));
    }
  }

  // ── Tasks ──

  insertTask(task: Task): void {
    this.db.insert(tasks).values({
      id: task.id,
      specId: task.specId,
      title: task.title,
      description: task.description,
      state: task.state,
      role: task.role,
      dependsOn: JSON.stringify(task.dependsOn),
      priority: task.priority,
      assignedAgent: task.assignedAgent,
      acpSessionId: task.acpSessionId,
      source: task.source || 'planned',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }).run();
  }

  getTask(id: TaskId): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? this.rowToTask(row) : null;
  }

  listTasks(specId?: SpecId): Task[] {
    const query = specId
      ? this.db.select().from(tasks).where(eq(tasks.specId, specId)).orderBy(sql`priority DESC, created_at ASC`)
      : this.db.select().from(tasks).orderBy(sql`priority DESC, created_at ASC`);
    return query.all().map(r => this.rowToTask(r));
  }

  updateTaskState(id: TaskId, state: TaskState, agentId?: AgentId | null): void {
    const now = new Date().toISOString();
    if (agentId !== undefined) {
      this.db.update(tasks)
        .set({ state, assignedAgent: agentId, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    } else {
      this.db.update(tasks)
        .set({ state, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    }
  }

  getTasksByState(state: TaskState): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.state, state)).all().map(r => this.rowToTask(r));
  }

  getTaskStats(): Record<TaskState, number> {
    const rows = this.db.select({
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
    this.db.update(tasks)
      .set({ claim, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  clearTaskAssignment(id: TaskId): void {
    const now = new Date().toISOString();
    this.db.update(tasks)
      .set({ assignedAgent: null, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  updateTaskDependsOn(id: TaskId, deps: TaskId[]): void {
    const now = new Date().toISOString();
    this.db.update(tasks)
      .set({ dependsOn: JSON.stringify(deps), updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
  }

  private rowToTask(row: typeof tasks.$inferSelect): Task {
    return {
      id: row.id as TaskId,
      specId: (row.specId ?? null) as SpecId | null,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      role: row.role as Task['role'],
      dependsOn: JSON.parse(row.dependsOn) as TaskId[],
      priority: row.priority,
      assignedAgent: (row.assignedAgent ?? null) as AgentId | null,
      acpSessionId: (row.acpSessionId ?? null) as string | null,
      source: (row.source as Task['source']) || 'planned',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Agents ──

  insertAgent(agent: Agent): void {
    this.db.insert(agents).values({
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
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? this.rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    return this.db.select().from(agents).all().map(r => this.rowToAgent(r));
  }

  updateAgentStatus(id: AgentId, status: Agent['status']): void {
    this.db.update(agents).set({ status }).where(eq(agents.id, id)).run();
  }

  updateAgentAcpSession(id: AgentId, acpSessionId: string | null): void {
    this.db.update(agents).set({ acpSessionId }).where(eq(agents.id, id)).run();
  }

  updateAgentHeartbeat(id: AgentId): void {
    this.db.update(agents)
      .set({ lastHeartbeat: new Date().toISOString() })
      .where(eq(agents.id, id))
      .run();
  }

  deleteAgent(id: AgentId): boolean {
    const result = this.db.delete(agents).where(eq(agents.id, id)).run();
    return result.changes > 0;
  }

  getActiveAgentCount(): number {
    const row = this.db.select({ count: count() })
      .from(agents)
      .where(sql`${agents.status} IN ('idle', 'busy')`)
      .get();
    return row?.count ?? 0;
  }

  recordCost(agentId: AgentId, amount: number): void {
    this.db.update(agents)
      .set({ costAccumulated: sql`${agents.costAccumulated} + ${amount}` })
      .where(eq(agents.id, agentId))
      .run();
  }

  getCostByAgent(): Array<{ agentId: string; cost: number }> {
    return this.db.select({
      agentId: agents.id,
      cost: agents.costAccumulated,
    }).from(agents).orderBy(sql`${agents.costAccumulated} DESC`).all();
  }

  getCostByTask(): Array<{ taskId: string; cost: number }> {
    return this.db.select({
      taskId: tasks.id,
      cost: sql<number>`COALESCE(${tasks.cost}, 0)`,
    }).from(tasks).orderBy(sql`${tasks.cost} DESC`).all();
  }

  recordTaskCost(taskId: TaskId, amount: number): void {
    this.db.update(tasks)
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
    this.db.insert(costEntries).values({
      agentId: entry.agentId,
      specId: entry.specId,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      costUsd: entry.costUsd,
      timestamp: entry.timestamp,
    }).run();
  }

  getTotalCost(specId?: SpecId): number {
    const row = specId
      ? this.db.select({ total: sql<number>`COALESCE(SUM(${costEntries.costUsd}), 0)` })
          .from(costEntries).where(eq(costEntries.specId, specId)).get()
      : this.db.select({ total: sql<number>`COALESCE(SUM(${costEntries.costUsd}), 0)` })
          .from(costEntries).get();
    return row?.total ?? 0;
  }

  close(): void {
    (this.db as any).$client.close();
  }
}

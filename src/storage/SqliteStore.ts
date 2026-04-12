import Database from 'better-sqlite3';
import type { Task, Agent, CostEntry, TaskId, AgentId, TaskState, SpecId } from '../core/types.js';

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'acp',
        acp_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_spec_id TEXT,
        cost_accumulated REAL NOT NULL DEFAULT 0,
        last_heartbeat TEXT
      );

      CREATE TABLE IF NOT EXISTS cost_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        spec_id TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      );
    `);
    // Add claim column if missing (migration)
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'claim')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN claim TEXT');
    }
    if (!cols.some(c => c.name === 'cost')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN cost REAL DEFAULT 0');
    }
  }

  // ── Tasks ──

  insertTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, spec_id, title, description, state, role, depends_on, priority, assigned_agent, acp_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.specId, task.title, task.description, task.state, task.role,
      JSON.stringify(task.dependsOn), task.priority, task.assignedAgent, task.acpSessionId,
      task.createdAt, task.updatedAt,
    );
  }

  getTask(id: TaskId): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(specId?: SpecId): Task[] {
    const rows = specId
      ? this.db.prepare('SELECT * FROM tasks WHERE spec_id = ? ORDER BY priority DESC, created_at ASC').all(specId) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC').all() as Record<string, unknown>[];
    return rows.map(r => this.rowToTask(r));
  }

  updateTaskState(id: TaskId, state: TaskState, agentId?: AgentId | null): void {
    const now = new Date().toISOString();
    if (agentId !== undefined) {
      this.db.prepare('UPDATE tasks SET state = ?, assigned_agent = ?, updated_at = ? WHERE id = ?')
        .run(state, agentId, now, id);
    } else {
      this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, now, id);
    }
  }

  getTasksByState(state: TaskState): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE state = ?').all(state) as Record<string, unknown>[];
    return rows.map(r => this.rowToTask(r));
  }

  getTaskStats(): Record<TaskState, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) as count FROM tasks GROUP BY state').all() as { state: string; count: number }[];
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.state] = row.count;
    }
    return stats as Record<TaskState, number>;
  }

  updateTaskClaim(id: TaskId, claim: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET claim = ?, updated_at = ? WHERE id = ?')
      .run(claim, now, id);
  }

  clearTaskAssignment(id: TaskId): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET assigned_agent = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  updateTaskDependsOn(id: TaskId, deps: TaskId[]): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(deps), now, id);
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as TaskId,
      specId: (row.spec_id ?? null) as SpecId | null,
      title: row.title as string,
      description: row.description as string,
      state: row.state as TaskState,
      role: row.role as Task['role'],
      dependsOn: JSON.parse(row.depends_on as string) as TaskId[],
      priority: row.priority as number,
      assignedAgent: (row.assigned_agent ?? null) as AgentId | null,
      acpSessionId: (row.acp_session_id ?? null) as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // ── Agents ──

  insertAgent(agent: Agent): void {
    this.db.prepare(`
      INSERT INTO agents (id, role, runtime, acp_session_id, status, current_spec_id, cost_accumulated, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.role, agent.runtime, agent.acpSessionId, agent.status, agent.currentSpecId, agent.costAccumulated, agent.lastHeartbeat);
  }

  getAgent(id: AgentId): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents').all() as Record<string, unknown>[];
    return rows.map(r => this.rowToAgent(r));
  }

  updateAgentStatus(id: AgentId, status: Agent['status']): void {
    this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
  }

  updateAgentHeartbeat(id: AgentId): void {
    this.db.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  deleteAgent(id: AgentId): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getActiveAgentCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM agents WHERE status IN ('idle', 'busy')").get() as { count: number };
    return row.count;
  }

  recordCost(agentId: AgentId, amount: number): void {
    this.db.prepare('UPDATE agents SET cost_accumulated = cost_accumulated + ? WHERE id = ?')
      .run(amount, agentId);
  }

  getCostByAgent(): Array<{ agentId: string; cost: number }> {
    return this.db.prepare('SELECT id as agentId, cost_accumulated as cost FROM agents ORDER BY cost DESC').all() as Array<{ agentId: string; cost: number }>;
  }

  getCostByTask(): Array<{ taskId: string; cost: number }> {
    return this.db.prepare('SELECT id as taskId, COALESCE(cost, 0) as cost FROM tasks ORDER BY cost DESC').all() as Array<{ taskId: string; cost: number }>;
  }

  recordTaskCost(taskId: TaskId, amount: number): void {
    this.db.prepare('UPDATE tasks SET cost = COALESCE(cost, 0) + ? WHERE id = ?')
      .run(amount, taskId);
  }

  private rowToAgent(row: Record<string, unknown>): Agent {
    return {
      id: row.id as AgentId,
      role: row.role as Agent['role'],
      runtime: row.runtime as Agent['runtime'],
      acpSessionId: (row.acp_session_id ?? null) as string | null,
      status: row.status as Agent['status'],
      currentSpecId: (row.current_spec_id ?? null) as SpecId | null,
      costAccumulated: row.cost_accumulated as number,
      lastHeartbeat: (row.last_heartbeat ?? null) as string | null,
    };
  }

  // ── Cost ──

  insertCostEntry(entry: CostEntry): void {
    this.db.prepare(`
      INSERT INTO cost_entries (agent_id, spec_id, tokens_in, tokens_out, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.agentId, entry.specId, entry.tokensIn, entry.tokensOut, entry.costUsd, entry.timestamp);
  }

  getTotalCost(specId?: SpecId): number {
    const row = specId
      ? this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_entries WHERE spec_id = ?').get(specId) as { total: number }
      : this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_entries').get() as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

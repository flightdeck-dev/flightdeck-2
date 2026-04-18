import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { eq, sql, count } from 'drizzle-orm';
import { tasks, agents, costEntries, specHashes, taskEvents, taskComments, fileLocks, savedSessions } from '../db/schema.js';
import { createDatabase, type FlightdeckDatabase } from '../db/database.js';
import type { Task, Agent, CostEntry, TaskId, AgentId, TaskState, SpecId } from '@flightdeck-ai/shared';

export interface TaskStateChangeEvent {
  taskId: TaskId;
  fromState: TaskState | null;
  toState: TaskState;
  agentId?: AgentId | null;
}

export class SqliteStore extends EventEmitter {
  private _db: FlightdeckDatabase;

  get db(): FlightdeckDatabase {
    return this._db;
  }

  constructor(dbPath: string) {
    super();
    this._db = createDatabase(dbPath);
    // Enable WAL mode for better concurrent read performance
    this._db.run(sql.raw('PRAGMA journal_mode=WAL'));
    this.migrate();
  }

  private migrate(): void {
    // Read and execute the unified schema SQL file
    const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../sql/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
      try {
        this._db.run(sql.raw(stmt));
      } catch {
        // Ignore errors from indexes on columns that don't exist yet (will be added below)
      }
    }
    // Add new columns to existing tables (idempotent)
    this.addColumnIfMissing('messages', 'channel', 'text');
    this.addColumnIfMissing('messages', 'recipient', 'text');
    this.addColumnIfMissing('tasks', 'needs_review', 'integer NOT NULL DEFAULT 1');
    this.addColumnIfMissing('cost_entries', 'model', 'text');
    this.addColumnIfMissing('cost_entries', 'duration_ms', 'integer');
    this.addColumnIfMissing('agents', 'context_window_tokens', 'integer');
    this.addColumnIfMissing('agents', 'context_window_limit', 'integer');
    this.addColumnIfMissing('agents', 'model', 'text');
    this.addColumnIfMissing('tasks', 'acceptance_criteria', 'text');
    this.addColumnIfMissing('tasks', 'context', 'text');
    // Re-run index creation after columns are ensured
    try { this._db.run(sql.raw('CREATE INDEX IF NOT EXISTS `idx_messages_channel` ON `messages` (`channel`)')); } catch {}
    try { this._db.run(sql.raw('CREATE INDEX IF NOT EXISTS `idx_messages_recipient` ON `messages` (`recipient`)')); } catch {}
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    try {
      this._db.run(sql.raw(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`));
    } catch {
      // Column already exists — ignore
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
      needsReview: task.needsReview !== false,
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
    // Log state transition
    const oldTask = this.getTask(id);
    const fromState = oldTask?.state ?? null;
    if (oldTask) {
      this.logTaskEvent(id, fromState, state, agentId ?? oldTask.assignedAgent);
    }
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
    // Emit event for orchestrator reactivity
    this.emit('task-state-changed', {
      taskId: id,
      fromState,
      toState: state,
      agentId: agentId ?? oldTask?.assignedAgent,
    } satisfies TaskStateChangeEvent);
  }

  logTaskEvent(taskId: TaskId, fromState: string | null, toState: string, agentId?: string | null, reason?: string): void {
    try {
      this._db.insert(taskEvents).values({
        taskId,
        fromState,
        toState,
        agentId: agentId ?? null,
        reason: reason ?? null,
      }).run();
    } catch {
      // Best effort — don't break task flow if logging fails
    }
  }

  getTaskEvents(taskId: TaskId): Array<{ id: number; taskId: string; fromState: string | null; toState: string; agentId: string | null; reason: string | null; timestamp: string }> {
    return this._db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(taskEvents.timestamp).all();
  }

  addTaskComment(taskId: TaskId, content: string, agentId?: string | null, type: 'comment' | 'review' = 'comment', verdict?: string | null): number {
    const result = this._db.insert(taskComments).values({
      taskId,
      agentId: agentId ?? null,
      type,
      verdict: verdict ?? null,
      content,
    }).run();
    return Number(result.lastInsertRowid);
  }

  getTaskComments(taskId: TaskId): Array<{ id: number; taskId: string; agentId: string | null; type: string; verdict: string | null; content: string; timestamp: string }> {
    return this._db.select().from(taskComments).where(eq(taskComments.taskId, taskId)).orderBy(taskComments.timestamp).all();
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
      needsReview: row.needsReview !== false,
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
      runtimeName: agent.runtimeName ?? null,
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

  listAgents(includeRetired = false): Agent[] {
    const all = this._db.select().from(agents).all().map(r => this.rowToAgent(r));
    return includeRetired ? all : all.filter(a => a.status !== 'retired');
  }

  /** Set agent status to 'hibernated', preserving acpSessionId for later resume. */
  hibernateAgent(id: AgentId, savedSessionId: string): void {
    this._db.update(agents)
      .set({ status: 'hibernated', acpSessionId: savedSessionId })
      .where(eq(agents.id, id))
      .run();
  }

  /** Set agent status to 'retired', preserving acpSessionId for potential unretire. */
  retireAgent(id: AgentId): void {
    this._db.update(agents)
      .set({ status: 'retired' })
      .where(eq(agents.id, id))
      .run();
  }

  /** Unretire an agent — set status back to 'hibernated'. */
  unretireAgent(id: AgentId): void {
    this._db.update(agents)
      .set({ status: 'hibernated' })
      .where(eq(agents.id, id))
      .run();
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

  /**
   * Reset tasks whose assignedAgent no longer exists in the agents table.
   * Running/in_review/claimed tasks are moved back to 'ready'; their agent assignment is cleared.
   * Returns the number of tasks reset.
   */
  resetOrphanedTasks(): number {
    const now = new Date().toISOString();
    const result = this._db.run(sql`
      UPDATE tasks
      SET state = 'ready', assigned_agent = NULL, updated_at = ${now}
      WHERE assigned_agent IS NOT NULL
        AND state IN ('running', 'in_review', 'claimed')
        AND assigned_agent NOT IN (SELECT id FROM agents)
    `);
    return result.changes;
  }

  /** List all agents with status 'hibernated'. */
  listHibernatedAgents(): Agent[] {
    return this._db.select().from(agents).where(eq(agents.status, 'hibernated')).all().map(r => this.rowToAgent(r));
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

  getTokenUsageByAgent(): Array<{ agentId: string; model: string | null; totalIn: number; totalOut: number; totalCacheRead: number; totalCacheWrite: number; totalCost: number; requestCount: number }> {
    return this._db.select({
      agentId: costEntries.agentId,
      model: costEntries.model,
      totalIn: sql<number>`SUM(${costEntries.tokensIn})`,
      totalOut: sql<number>`SUM(${costEntries.tokensOut})`,
      totalCacheRead: sql<number>`SUM(${costEntries.cacheReadTokens})`,
      totalCacheWrite: sql<number>`SUM(${costEntries.cacheWriteTokens})`,
      totalCost: sql<number>`SUM(${costEntries.costUsd})`,
      requestCount: sql<number>`COUNT(*)`,
    }).from(costEntries)
      .groupBy(costEntries.agentId, costEntries.model)
      .orderBy(sql`SUM(${costEntries.tokensIn}) + SUM(${costEntries.tokensOut}) DESC`)
      .all();
  }

  getTokenUsageTotal(): { totalIn: number; totalOut: number; totalCacheRead: number; totalCacheWrite: number; totalCost: number; requestCount: number } {
    const row = this._db.select({
      totalIn: sql<number>`COALESCE(SUM(${costEntries.tokensIn}), 0)`,
      totalOut: sql<number>`COALESCE(SUM(${costEntries.tokensOut}), 0)`,
      totalCacheRead: sql<number>`COALESCE(SUM(${costEntries.cacheReadTokens}), 0)`,
      totalCacheWrite: sql<number>`COALESCE(SUM(${costEntries.cacheWriteTokens}), 0)`,
      totalCost: sql<number>`COALESCE(SUM(${costEntries.costUsd}), 0)`,
      requestCount: sql<number>`COUNT(*)`,
    }).from(costEntries).get();
    return row ?? { totalIn: 0, totalOut: 0, totalCacheRead: 0, totalCacheWrite: 0, totalCost: 0, requestCount: 0 };
  }

  updateAgentContextWindow(agentId: AgentId, currentTokens: number, tokenLimit: number): void {
    this._db.run(sql`UPDATE agents SET context_window_tokens = ${currentTokens}, context_window_limit = ${tokenLimit} WHERE id = ${agentId}`);
  }

  updateAgentModel(agentId: AgentId, model: string): void {
    this._db.run(sql`UPDATE agents SET model = ${model} WHERE id = ${agentId}`);
  }

  updateTaskDescription(taskId: TaskId, description: string): void {
    this._db.update(tasks)
      .set({ description, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
  }

  updateTaskRole(taskId: TaskId, role: string): void {
    this._db.update(tasks)
      .set({ role, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
  }

  // ── File Locks ──

  acquireFileLock(filePath: string, agentId: string, agentRole: string, reason?: string, ttlMs: number = 10 * 60 * 1000): boolean {
    const now = new Date();
    // First, clean expired locks
    this._db.run(sql`DELETE FROM file_locks WHERE expires_at < ${now.toISOString()}`);
    // Check if already locked by someone else
    const existing = this._db.select().from(fileLocks).where(eq(fileLocks.filePath, filePath)).get();
    if (existing && existing.agentId !== agentId) {
      return false; // locked by another agent
    }
    // Upsert lock
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this._db.insert(fileLocks).values({
      filePath,
      agentId,
      agentRole,
      reason: reason ?? '',
      acquiredAt: now.toISOString(),
      expiresAt,
    }).onConflictDoUpdate({
      target: fileLocks.filePath,
      set: { agentId, agentRole, reason: reason ?? '', acquiredAt: now.toISOString(), expiresAt },
    }).run();
    return true;
  }

  releaseFileLock(filePath: string, agentId: string): boolean {
    const existing = this._db.select().from(fileLocks).where(eq(fileLocks.filePath, filePath)).get();
    if (!existing || existing.agentId !== agentId) return false;
    this._db.delete(fileLocks).where(eq(fileLocks.filePath, filePath)).run();
    return true;
  }

  listFileLocks(): Array<{ filePath: string; agentId: string; agentRole: string; reason: string; acquiredAt: string; expiresAt: string }> {
    // Clean expired first
    this._db.run(sql`DELETE FROM file_locks WHERE expires_at < ${new Date().toISOString()}`);
    return this._db.select().from(fileLocks).all() as any;
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
      runtimeName: row.runtimeName ?? null,
      acpSessionId: (row.acpSessionId ?? null) as string | null,
      status: row.status as Agent['status'],
      currentSpecId: (row.currentSpecId ?? null) as SpecId | null,
      costAccumulated: row.costAccumulated,
      lastHeartbeat: (row.lastHeartbeat ?? null) as string | null,
    };
  }

  // ── Cost ──

  insertCostEntry(entry: CostEntry & { model?: string; durationMs?: number }): void {
    this._db.insert(costEntries).values({
      agentId: entry.agentId,
      specId: entry.specId,
      model: entry.model ?? null,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheWriteTokens: entry.cacheWriteTokens ?? 0,
      costUsd: entry.costUsd,
      durationMs: entry.durationMs ?? null,
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

  // ── Saved Sessions (gateway restart recovery) ──

  saveSession(entry: { agentId: string; role: string; sessionId: string; localSessionId?: string; runtime?: string; cwd?: string; model?: string; status?: string }): void {
    const now = new Date().toISOString();
    this._db.run(sql`INSERT INTO saved_sessions (agent_id, role, session_id, local_session_id, runtime, cwd, model, status, saved_at) VALUES (${entry.agentId}, ${entry.role}, ${entry.sessionId}, ${entry.localSessionId ?? null}, ${entry.runtime ?? null}, ${entry.cwd ?? null}, ${entry.model ?? null}, ${entry.status ?? 'hibernated'}, ${now}) ON CONFLICT(agent_id) DO UPDATE SET role = ${entry.role}, session_id = ${entry.sessionId}, local_session_id = ${entry.localSessionId ?? null}, runtime = ${entry.runtime ?? null}, cwd = ${entry.cwd ?? null}, model = ${entry.model ?? null}, status = ${entry.status ?? 'hibernated'}, saved_at = ${now}`);
  }

  loadSessions(): Array<{ agentId: string; role: string; sessionId: string; localSessionId: string | null; runtime: string | null; cwd: string | null; model: string | null; status: string }> {
    return this._db.select().from(savedSessions).all();
  }

  clearSessions(): void {
    this._db.delete(savedSessions).run();
  }

  deleteSession(agentId: string): void {
    this._db.delete(savedSessions).where(eq(savedSessions.agentId, agentId)).run();
  }
}

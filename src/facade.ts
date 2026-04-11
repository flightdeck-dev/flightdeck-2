// Flightdeck — high-level facade that wires all modules together with persistence
// Used by CLI and MCP server as the single entry point

import Database from 'better-sqlite3';
import {
  type Task, type TaskId, type TaskState, type TaskAction, type RoleId, type AgentId,
  type Spec, type SpecId, type Change, type ChangeId, type ChangeStatus,
  type Message, type MessageId, type MessagePriority, type MessageType,
  type Agent, type AgentStatus,
  type Gate, type GateType,
  type ReviewVerdict,
  taskId, specId, changeId, agentId, messageId, gateId,
} from './core/types.js';
import type { ReviewRequest } from './verification/VerificationEngine.js';

export interface FlightdeckOptions {
  dbPath?: string;
}

export class Flightdeck {
  private sqlite: InstanceType<typeof Database>;

  constructor(opts: FlightdeckOptions = {}) {
    const dbPath = opts.dbPath ?? '.flightdeck/flightdeck.db';
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.initTables();
  }

  private initTables(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending',
        role TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        depends_on TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 0,
        spec_requirement_id TEXT,
        plan_id TEXT,
        assigned_agent TEXT,
        model TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        compacted INTEGER NOT NULL DEFAULT 0,
        compacted_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        requirements TEXT NOT NULL DEFAULT '[]',
        user_scenarios TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposed',
        diff TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'direct',
        priority TEXT NOT NULL DEFAULT 'normal',
        from_agent TEXT NOT NULL,
        to_agents TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        thread_id TEXT,
        reply_to TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'sent',
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'idle',
        capabilities TEXT NOT NULL DEFAULT '[]',
        cost_accumulated REAL NOT NULL DEFAULT 0,
        last_heartbeat TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        writer_agent TEXT NOT NULL DEFAULT 'unknown',
        writer_model TEXT NOT NULL DEFAULT 'unknown',
        reviewer_agent TEXT,
        reviewer_model TEXT,
        verdict TEXT,
        comments TEXT NOT NULL DEFAULT '[]',
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS gates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        await_type TEXT NOT NULL,
        await_id TEXT NOT NULL,
        timeout INTEGER,
        cleared INTEGER NOT NULL DEFAULT 0,
        cleared_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agents);
      CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  // ==== TASKS ====

  addTask(input: { title: string; description?: string; role: string; dependsOn?: string[]; priority?: number; files?: string[] }): Task {
    const id = taskId();
    const now = new Date().toISOString();
    const deps = input.dependsOn ?? [];
    
    // Validate deps exist
    for (const dep of deps) {
      const row = this.sqlite.prepare('SELECT id FROM tasks WHERE id = ?').get(dep);
      if (!row) throw new Error(`Dependency '${dep}' not found`);
    }

    const state: TaskState = deps.length > 0 ? 'pending' : 'ready';
    
    this.sqlite.prepare(`
      INSERT INTO tasks (id, title, description, state, role, files, depends_on, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.title, input.description ?? '', state, input.role, JSON.stringify(input.files ?? []), JSON.stringify(deps), input.priority ?? 0, now, now);

    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  listTasks(filter?: { status?: TaskState }): Task[] {
    let rows: any[];
    if (filter?.status) {
      rows = this.sqlite.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC').all(filter.status) as any[];
    } else {
      rows = this.sqlite.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC').all() as any[];
    }
    return rows.map(r => this.rowToTask(r));
  }

  startTask(id: string, agentId: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task '${id}' not found`);
    if (task.state !== 'ready') throw new Error(`Task '${id}' is '${task.state}', must be 'ready' to start`);
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE tasks SET state = ?, assigned_agent = ?, updated_at = ? WHERE id = ?').run('running', agentId, now, id);
    return this.getTask(id)!;
  }

  completeTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task '${id}' not found`);
    if (task.state !== 'running' && task.state !== 'in_review') throw new Error(`Task '${id}' is '${task.state}', must be 'running' or 'in_review' to complete`);
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('done', now, id);
    // Resolve dependents
    this.resolveDependents(id);
    return this.getTask(id)!;
  }

  failTask(id: string, reason?: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task '${id}' not found`);
    if (task.state !== 'running' && task.state !== 'gated') throw new Error(`Task '${id}' is '${task.state}', cannot fail`);
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('failed', now, id);
    return this.getTask(id)!;
  }

  gateTask(id: string, awaitType: string, awaitId: string): Gate {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task '${id}' not found`);
    const gId = gateId();
    const now = new Date().toISOString();
    this.sqlite.prepare('INSERT INTO gates (id, task_id, await_type, await_id, created_at) VALUES (?, ?, ?, ?, ?)').run(gId, id, awaitType, awaitId, now);
    this.sqlite.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('gated', now, id);
    return { id: gId as any, taskId: id as any, awaitType: awaitType as any, awaitId, cleared: false, createdAt: new Date(now) };
  }

  private resolveDependents(completedId: string): void {
    const allTasks = this.sqlite.prepare('SELECT * FROM tasks WHERE state = ?').all('pending') as any[];
    const now = new Date().toISOString();
    for (const row of allTasks) {
      const deps: string[] = JSON.parse(row.depends_on);
      if (!deps.includes(completedId)) continue;
      const allDone = deps.every(d => {
        const t = this.sqlite.prepare('SELECT state FROM tasks WHERE id = ?').get(d) as any;
        return t && (t.state === 'done' || t.state === 'skipped');
      });
      if (allDone) {
        this.sqlite.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('ready', now, row.id);
      }
    }
  }

  topoSort(): string[] {
    const tasks = this.listTasks();
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const t of tasks) {
      inDegree.set(t.id, t.dependsOn.length);
      dependents.set(t.id, []);
    }
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        dependents.get(dep)?.push(t.id);
      }
    }
    const queue = tasks.filter(t => t.dependsOn.length === 0).map(t => t.id);
    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);
      for (const dep of dependents.get(id) ?? []) {
        const deg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, deg);
        if (deg === 0) queue.push(dep);
      }
    }
    return result;
  }

  dagStats() {
    const tasks = this.listTasks();
    const byState: Record<string, number> = {};
    for (const t of tasks) {
      byState[t.state] = (byState[t.state] ?? 0) + 1;
    }
    return { total: tasks.length, byState };
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id as TaskId,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      role: row.role as RoleId,
      files: JSON.parse(row.files),
      dependsOn: JSON.parse(row.depends_on),
      priority: row.priority,
      specRequirementId: row.spec_requirement_id ?? undefined,
      planId: row.plan_id ?? undefined,
      assignedAgent: row.assigned_agent ?? undefined,
      model: row.model ?? undefined,
      stale: !!row.stale,
      compacted: !!row.compacted,
      compactedSummary: row.compacted_summary ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ==== SPECS ====

  createSpec(title: string): Spec {
    const id = specId();
    const now = new Date().toISOString();
    this.sqlite.prepare('INSERT INTO specs (id, title, requirements, user_scenarios, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, '[]', '[]', now, now);
    return this.getSpec(id)!;
  }

  getSpec(id: string): Spec | undefined {
    const row = this.sqlite.prepare('SELECT * FROM specs WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id as SpecId,
      title: row.title,
      requirements: JSON.parse(row.requirements),
      userScenarios: JSON.parse(row.user_scenarios),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  listSpecs(): Spec[] {
    const rows = this.sqlite.prepare('SELECT * FROM specs ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id as SpecId,
      title: r.title,
      requirements: JSON.parse(r.requirements),
      userScenarios: JSON.parse(r.user_scenarios),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));
  }

  proposeChange(specIdVal: string, title?: string): Change {
    const spec = this.getSpec(specIdVal);
    if (!spec) throw new Error(`Spec '${specIdVal}' not found`);
    const id = changeId();
    const now = new Date().toISOString();
    const t = title ?? `Change to ${spec.title}`;
    this.sqlite.prepare('INSERT INTO changes (id, spec_id, title, description, status, diff, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, specIdVal, t, '', 'proposed', '{}', now, now);
    return this.getChange(id)!;
  }

  approveChange(id: string): Change {
    const change = this.getChange(id);
    if (!change) throw new Error(`Change '${id}' not found`);
    if (change.status !== 'proposed') throw new Error(`Change is '${change.status}', must be 'proposed'`);
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE changes SET status = ?, updated_at = ? WHERE id = ?').run('approved', now, id);
    return this.getChange(id)!;
  }

  getChange(id: string): Change | undefined {
    const row = this.sqlite.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id as ChangeId,
      specId: row.spec_id as SpecId,
      title: row.title,
      description: row.description,
      status: row.status as ChangeStatus,
      diff: JSON.parse(row.diff),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ==== AGENTS ====

  registerAgent(id: string, role: string, name?: string): Agent {
    const now = new Date().toISOString();
    this.sqlite.prepare('INSERT OR REPLACE INTO agents (id, name, role, model, status, capabilities, cost_accumulated, last_heartbeat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, name ?? id, role, 'unknown', 'idle', '[]', 0, now, now, now);
    return this.getAgent(id)!;
  }

  getAgent(id: string): Agent | undefined {
    const row = this.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id as AgentId,
      name: row.name,
      role: row.role as RoleId,
      model: row.model,
      status: row.status as AgentStatus,
      capabilities: JSON.parse(row.capabilities),
      costAccumulated: row.cost_accumulated,
      lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : undefined,
      sessionId: row.session_id ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  listAgents(): Agent[] {
    const rows = this.sqlite.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id as AgentId,
      name: r.name,
      role: r.role as RoleId,
      model: r.model,
      status: r.status as AgentStatus,
      capabilities: JSON.parse(r.capabilities),
      costAccumulated: r.cost_accumulated,
      lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat) : undefined,
      sessionId: r.session_id ?? undefined,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));
  }

  agentHeartbeat(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare('UPDATE agents SET last_heartbeat = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return result.changes > 0;
  }

  // ==== MESSAGES ====

  sendMessage(to: string, content: string, opts?: { from?: string; priority?: MessagePriority; threadId?: string }): Message {
    const id = messageId();
    const now = new Date().toISOString();
    const from = opts?.from ?? 'system';
    this.sqlite.prepare('INSERT INTO messages (id, type, priority, from_agent, to_agents, content, thread_id, delivery_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'direct', opts?.priority ?? 'normal', from, JSON.stringify([to]), content, opts?.threadId ?? null, 'sent', now);
    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | undefined {
    const row = this.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToMessage(row);
  }

  getInbox(agentId: string): Message[] {
    const rows = this.sqlite.prepare("SELECT * FROM messages WHERE to_agents LIKE ? ORDER BY created_at DESC").all(`%${agentId}%`) as any[];
    return rows.map(r => this.rowToMessage(r));
  }

  listMessages(opts?: { threadId?: string }): Message[] {
    let rows: any[];
    if (opts?.threadId) {
      rows = this.sqlite.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC').all(opts.threadId) as any[];
    } else {
      rows = this.sqlite.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 50').all() as any[];
    }
    return rows.map(r => this.rowToMessage(r));
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id as MessageId,
      type: row.type as MessageType,
      priority: row.priority as MessagePriority,
      from: row.from_agent as AgentId,
      to: JSON.parse(row.to_agents),
      content: row.content,
      threadId: row.thread_id ?? undefined,
      replyTo: row.reply_to ?? undefined,
      deliveryStatus: row.delivery_status as any,
      createdAt: new Date(row.created_at),
      readAt: row.read_at ? new Date(row.read_at) : undefined,
    };
  }

  // ==== VERIFICATION ====

  requestReview(taskId: string, reviewerAgent?: string): ReviewRequest {
    const id = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    this.sqlite.prepare('INSERT INTO reviews (id, task_id, writer_agent, writer_model, reviewer_agent, comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, taskId, 'unknown', 'unknown', reviewerAgent ?? null, '[]', now);
    return this.getReview(id)!;
  }

  decideReview(reviewId: string, verdict: string, comments?: string): ReviewRequest {
    const review = this.getReview(reviewId);
    if (!review) throw new Error(`Review '${reviewId}' not found`);
    const now = new Date().toISOString();
    const c = comments ? [comments] : [];
    this.sqlite.prepare('UPDATE reviews SET verdict = ?, comments = ?, completed_at = ? WHERE id = ?').run(verdict, JSON.stringify(c), now, reviewId);
    return this.getReview(reviewId)!;
  }

  getReview(id: string): ReviewRequest | undefined {
    const row = this.sqlite.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id as TaskId,
      writerAgent: row.writer_agent as AgentId,
      writerModel: row.writer_model,
      reviewerAgent: row.reviewer_agent as AgentId | undefined,
      reviewerModel: row.reviewer_model ?? undefined,
      verdict: row.verdict as ReviewVerdict | undefined,
      comments: JSON.parse(row.comments),
      createdAt: new Date(row.created_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      attempt: row.attempt,
    };
  }

  // ==== STATUS ====

  status() {
    const tasks = this.listTasks();
    const agents = this.listAgents();
    const byState: Record<string, number> = {};
    for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;
    return {
      tasks: { total: tasks.length, byState },
      agents: { total: agents.length, idle: agents.filter(a => a.status === 'idle').length, busy: agents.filter(a => a.status === 'busy').length },
    };
  }
}

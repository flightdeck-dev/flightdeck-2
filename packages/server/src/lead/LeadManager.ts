
import type { SqliteStore } from '../storage/SqliteStore.js';
import type { ProjectStore } from '../storage/ProjectStore.js';
import type { MessageStore, ChatMessage } from '../comms/MessageStore.js';
import type { AcpAdapter, AcpSession } from '../agents/AcpAdapter.js';
import { buildMemoryContext } from '../agents/AgentManager.js';
import { SessionStore } from '../acp/SessionStore.js';

/**
 * Events that can trigger a Lead steer.
 */
/**
 * Sentinel strings that agents can return.
 * FLIGHTDECK_IDLE — "I have nothing to do" (like OpenClaw's HEARTBEAT_OK)
 * FLIGHTDECK_NO_REPLY — "I processed this but have nothing to say to the user"
 */
export const FLIGHTDECK_IDLE = 'FLIGHTDECK_IDLE';
export const FLIGHTDECK_NO_REPLY = 'FLIGHTDECK_NO_REPLY';

export type PlannerEvent =
  | { type: 'critical_task_completed'; taskId: string; specId: string | null; title: string; remainingInSpec: number }
  | { type: 'task_failed'; taskId: string; error: string; retriesLeft: number }
  | { type: 'worker_escalation'; taskId: string; agentId: string; reason: string }
  | { type: 'spec_milestone'; specId: string; completed: number; total: number }
  | { type: 'plan_validation_request'; specId: string; context: string };

export type LeadEvent =
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'task_comment'; taskId: string; message: ChatMessage }
  | { type: 'task_failure'; taskId: string; error: string }
  | { type: 'escalation'; agentId: string; taskId: string; reason: string }
  | { type: 'spec_completed'; specId: string; summary: string }
  | { type: 'budget_warning'; currentSpend: number; limit: number }
  | { type: 'spec_changed'; specId: string; summary: string }
  | { type: 'heartbeat' }
  | { type: 'worker_recovery'; message: string }
  | { type: 'cron'; job: { id: string; name: string; prompt: string; skill?: string } };

export interface HeartbeatCondition {
  type: 'tasks_completed' | 'idle_duration' | 'time_window' | 'spec_completed' | 'cost_threshold' | 'custom';
  min?: number | string;
  start?: string;
  end?: string;
  expression?: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;  // ms
  conditions: HeartbeatCondition[];
}

export interface LeadManagerOptions {
  sqlite: SqliteStore;
  project: ProjectStore;
  messageStore?: MessageStore;
  acpAdapter: AcpAdapter;
  heartbeat?: HeartbeatConfig;
  projectName?: string;
  /** Working directory for spawned agents. Defaults to process.cwd(). */
  cwd?: string;
  /** Runtime name for Lead (e.g. 'copilot', 'opencode'). Falls back to adapter default. */
  leadRuntime?: string;
  /** Runtime name for Planner. Falls back to leadRuntime, then adapter default. */
  plannerRuntime?: string;
}

export class LeadManager {
  private sqlite: SqliteStore;
  private project: ProjectStore;
  private messageStore: MessageStore | null;
  private acpAdapter: AcpAdapter;
  private heartbeatConfig: HeartbeatConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leadSessionId: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private tasksSinceLastHeartbeat = 0;
  private lastSteerAt: string | null = null;
  private projectName: string | undefined;
  private agentCwd: string;
  private leadRuntime: string | undefined;
  private plannerRuntime: string | undefined;

  private plannerSessionId: string | null = null;
  private sessionStore: SessionStore;
  private transcriptSessionId: string | null = null;
  private suspendedPlannerInfo: { acpSessionId: string; cwd: string; model?: string } | null = null;
  private suspendedLeadInfo: { acpSessionId: string; cwd: string; model?: string } | null = null;
  private streamHandler: ((update: NonNullable<Parameters<NonNullable<AcpSession['onOutputChunk']>>>[0]) => void) | null = null;

  constructor(opts: LeadManagerOptions) {
    this.sqlite = opts.sqlite;
    this.project = opts.project;
    this.messageStore = opts.messageStore ?? null;
    this.acpAdapter = opts.acpAdapter;
    this.heartbeatConfig = opts.heartbeat ?? { enabled: false, interval: 30 * 60 * 1000, conditions: [] };
    this.projectName = opts.projectName;
    this.agentCwd = opts.cwd ?? process.cwd();
    this.sessionStore = new SessionStore(opts.projectName ?? 'default', opts.sqlite.db);
    this.leadRuntime = opts.leadRuntime;
    this.plannerRuntime = opts.plannerRuntime;
  }

  /** Start Lead ACP session */
  async spawnLead(): Promise<string> {
    // Purge stale offline agents before spawning
    const purged = this.sqlite.purgeOfflineAgents();
    if (purged > 0) {
      console.log(`  Purged ${purged} offline agent(s)`);
    }
    // Reset tasks that were assigned to now-deleted agents
    const orphaned = this.sqlite.resetOrphanedTasks();
    if (orphaned > 0) {
      console.log(`  Reset ${orphaned} orphaned task(s) to ready`);
    }

    // Build memory context for Lead's system prompt
    let memoryContext = '';
    try {
      const memoryDir = this.project.subpath('memory');
      memoryContext = buildMemoryContext(memoryDir);
    } catch { /* project may not support subpath in tests */ }

    const meta = await this.acpAdapter.spawn({
      role: 'lead',
      cwd: this.agentCwd,
      projectName: this.projectName,
      runtime: this.leadRuntime,
      ...(memoryContext ? { systemPrompt: memoryContext } : {}),
    });
    this.leadSessionId = meta.sessionId;
    this.wireStreamHandler();

    // Register Lead agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'lead',
      runtime: 'acp',
      runtimeName: this.leadRuntime ?? 'copilot',
      acpSessionId: meta.sessionId,
      status: 'busy',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    });

    if (this.heartbeatConfig.enabled) {
      this.startHeartbeatTimer();
    }
    return meta.sessionId;
  }

  /** Set suspended lead info for lazy resume on restart */
  setSuspendedLead(info: { acpSessionId: string; cwd: string; model?: string }): void {
    this.suspendedLeadInfo = info;
  }

  /** Check if lead is suspended (awaiting lazy resume) */
  isLeadSuspended(): boolean {
    return this.suspendedLeadInfo !== null && this.leadSessionId === null;
  }

  /** Send an event steer to Lead and return its response text */
  async steerLead(event: LeadEvent): Promise<string> {
    // Auto-wake suspended Lead on first steer
    if (!this.leadSessionId && this.isLeadSuspended() && this.suspendedLeadInfo) {
      const info = this.suspendedLeadInfo;
      this.suspendedLeadInfo = null;
      try {
        console.error(`  Auto-resuming suspended Lead from session ${info.acpSessionId}...`);
        await this.resumeLead(info.acpSessionId, info.cwd, info.model);
        console.error(`  Lead resumed (session: ${this.leadSessionId})`);
      } catch (err) {
        console.error(`  Failed to auto-resume Lead: ${err instanceof Error ? err.message : String(err)}`);
        // Fall back to fresh spawn
        try {
          console.error(`  Spawning fresh Lead...`);
          await this.spawnLead();
          console.error(`  Lead spawned fresh (session: ${this.leadSessionId})`);
        } catch (err2) {
          console.error(`  Failed to spawn Lead: ${err2 instanceof Error ? err2.message : String(err2)}`);
          return '';
        }
      }
    }
    // If still no Lead (no saved session, first-ever boot) — spawn fresh
    if (!this.leadSessionId && !this.isLeadSuspended()) {
      try {
        console.error(`  Spawning Lead on-demand...`);
        await this.spawnLead();
        console.error(`  Lead spawned on-demand (session: ${this.leadSessionId})`);
      } catch (err) {
        console.error(`  Failed to spawn Lead on-demand: ${err instanceof Error ? err.message : String(err)}`);
        return '';
      }
    }
    if (!this.leadSessionId) return '';
    const steer = this.buildSteer(event);
    const sourceMessageId = event.type === 'user_message' ? event.message.id : undefined;
    const response = await this.acpAdapter.steer(this.leadSessionId, { content: steer, sourceMessageId });
    this.lastSteerAt = new Date().toISOString();

    // Log to SessionStore for session transcript search
    this.logSessionEvent('user', steer);
    if (response) this.logSessionEvent('agent', response);

    return response;
  }

  /** Set a handler to receive streaming updates (tool calls, thoughts, text chunks) from the lead session */
  setStreamHandler(handler: (update: NonNullable<Parameters<NonNullable<AcpSession['onOutputChunk']>>>[0]) => void): void {
    this.streamHandler = handler;
    this.wireStreamHandler();
  }

  /** Wire the stream handler onto the current lead session's onOutputChunk */
  private wireStreamHandler(): void {
    if (!this.leadSessionId || !this.streamHandler) return;
    const session = this.acpAdapter.getSession(this.leadSessionId);
    if (session) {
      const handler = this.streamHandler;
      session.onOutputChunk = (update) => handler(update);
    }
  }

  /** Get merged source message IDs from the last steer (for multi-parent replies) */
  getLastMergedSourceIds(): string[] {
    if (!this.leadSessionId) return [];
    const session = this.acpAdapter.getSession(this.leadSessionId);
    return session?.lastMergedSourceIds ?? [];
  }

  /** Log a conversation event to SessionStore for transcript search. */
  private logSessionEvent(role: 'user' | 'agent', content: string): void {
    try {
      if (!this.transcriptSessionId) {
        const entry = this.sessionStore.createSession(this.projectName ?? 'default', this.agentCwd);
        this.transcriptSessionId = entry.id;
      }
      this.sessionStore.appendEvent(this.transcriptSessionId, { role, content, ts: Date.now() });
    } catch { /* best effort */ }
  }

  /** Build a self-contained steer message with context */
  buildSteer(event: LeadEvent): string {
    const parts: string[] = [];

    switch (event.type) {
      case 'user_message': {
        const ts = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${ts}] [USER]`);
        if (event.message.id) parts.push(`message_id: ${event.message.id}`);
        parts.push(`source: web-dashboard`);
        if (event.message.parentId) parts.push(`reply_to: ${event.message.parentId}`);
        if (event.message.taskId) parts.push(`task_id: ${event.message.taskId}`);
        parts.push('---');
        parts.push(event.message.content);
        parts.push('');
        parts.push(`For project status: read .flightdeck/status.md`);
        break;
      }

      case 'task_comment': {
        const tcTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${tcTs}] [USER]`);
        if (event.message.id) parts.push(`message_id: ${event.message.id}`);
        parts.push(`task_id: ${event.taskId}`);
        parts.push(`source: task_comment`);
        if (event.message.parentId) parts.push(`reply_to: ${event.message.parentId}`);
        parts.push('---');
        parts.push(event.message.content);
        parts.push('');
        parts.push(`For full task history: flightdeck_task_get("${event.taskId}")`);
        break;
      }

      case 'task_failure': {
        const tfTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${tfTs}] [SYSTEM]`);
        parts.push(`task_id: ${event.taskId}`);
        parts.push(`source: task_failure`);
        parts.push('---');
        parts.push(`Task ${event.taskId} failed after retries: ${event.error}`);
        parts.push('');
        parts.push(`For task details: flightdeck_task_get("${event.taskId}")`);
        break;
      }

      case 'escalation': {
        const escTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${escTs}] [AGENT ${event.agentId}]`);
        parts.push(`agent_id: ${event.agentId}`);
        parts.push(`task_id: ${event.taskId}`);
        parts.push(`source: escalation`);
        parts.push('---');
        parts.push(event.reason);
        break;
      }

      case 'spec_completed': {
        const scTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${scTs}] [SYSTEM]`);
        parts.push(`source: spec_completed`);
        parts.push('---');
        parts.push(`Spec ${event.specId} is complete. ${event.summary}`);
        parts.push('');
        parts.push('Please write a retrospective to memory/retrospectives/ and update memory/PROJECT.md.');
        break;
      }

      case 'budget_warning': {
        const bwTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${bwTs}] [SYSTEM]`);
        parts.push(`source: budget_warning`);
        parts.push('---');
        parts.push(`Spending: $${event.currentSpend.toFixed(2)} / $${event.limit.toFixed(2)} limit`);
        break;
      }

      case 'spec_changed': {
        const schTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${schTs}] [SYSTEM]`);
        parts.push(`source: spec_changed`);
        parts.push('---');
        parts.push(`Spec ${event.specId} was modified. ${event.summary}`);
        parts.push('');
        parts.push('Review affected tasks with flightdeck_task_list and re-plan if needed.');
        break;
      }

      case 'heartbeat':
        return this.buildHeartbeatSteer();

      case 'worker_recovery': {
        const wrTs = new Date().toISOString().slice(0, 19) + 'Z';
        parts.push(`[${wrTs}] [SYSTEM]`);
        parts.push(`source: worker_recovery`);
        parts.push('---');
        parts.push(event.message);
        break;
      }

      case 'cron': {
        parts.push(`[cron: ${event.job.name}]`);
        parts.push(event.job.prompt);
        break;
      }
    }

    return parts.join('\n');
  }

  /** Build heartbeat steer with project status + HEARTBEAT.md content */
  buildHeartbeatSteer(): string {
    const parts: string[] = [];
    parts.push('[heartbeat steer]');

    // Project status
    const stats = this.sqlite.getTaskStats?.() ?? {};
    const totalCost = this.sqlite.getTotalCost();
    parts.push(`Project status: ${JSON.stringify(stats)}, total cost: $${totalCost.toFixed(2)}`);

    // Recent completions
    parts.push(`Tasks completed since last heartbeat: ${this.tasksSinceLastHeartbeat}`);

    // Pending decisions count
    parts.push('');

    // HEARTBEAT.md content
    const heartbeatMd = this.project.readHeartbeat();
    if (heartbeatMd) {
      parts.push('--- HEARTBEAT.md ---');
      parts.push(heartbeatMd);
      parts.push('---');
      parts.push('');
      parts.push('Follow the instructions in HEARTBEAT.md. Update it if needed.');
    }

    return parts.join('\n');
  }

  /** Check if all heartbeat conditions are met */
  checkHeartbeatConditions(): boolean {
    for (const cond of this.heartbeatConfig.conditions) {
      switch (cond.type) {
        case 'tasks_completed': {
          const min = typeof cond.min === 'number' ? cond.min : parseInt(cond.min ?? '1', 10);
          if (this.tasksSinceLastHeartbeat < min) return false;
          break;
        }
        case 'idle_duration': {
          if (!this.lastSteerAt) break; // no steers yet, condition passes
          const minMs = parseDuration(cond.min);
          const elapsed = Date.now() - new Date(this.lastSteerAt).getTime();
          if (elapsed < minMs) return false;
          break;
        }
        case 'time_window': {
          const now = new Date();
          const hours = now.getHours();
          const minutes = now.getMinutes();
          const current = hours * 60 + minutes;
          const start = parseTime(cond.start ?? '08:00');
          const end = parseTime(cond.end ?? '22:00');
          if (current < start || current > end) return false;
          break;
        }
        // cost_threshold, spec_completed, custom — not implemented yet
      }
    }
    return true;
  }

  /** Record a task completion for heartbeat condition tracking */
  recordTaskCompletion(): void {
    this.tasksSinceLastHeartbeat++;
  }

  /** Spawn Planner as a persistent ACP session */
  async spawnPlanner(): Promise<string> {
    const meta = await this.acpAdapter.spawn({
      role: 'planner',
      cwd: this.agentCwd,
      projectName: this.projectName,
      runtime: this.plannerRuntime,
    });
    this.plannerSessionId = meta.sessionId;

    // Register Planner agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'planner',
      runtime: 'acp',
      runtimeName: this.plannerRuntime ?? this.leadRuntime ?? 'copilot',
      acpSessionId: meta.sessionId,
      status: 'busy',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    });

    return meta.sessionId;
  }

  /** Set suspended planner info for lazy resume */
  setSuspendedPlanner(info: { acpSessionId: string; cwd: string; model?: string }): void {
    this.suspendedPlannerInfo = info;
  }

  /** Check if planner is suspended (awaiting lazy resume) */
  isPlannerSuspended(): boolean {
    return this.suspendedPlannerInfo !== null && this.plannerSessionId === null;
  }

  /** Build a steer message for a PlannerEvent */
  buildPlannerSteer(event: PlannerEvent): string {
    const parts: string[] = [];

    switch (event.type) {
      case 'critical_task_completed':
        parts.push('[plan event: critical task completed]');
        parts.push(`Task "${event.title}" (${event.taskId}) has been completed.`);
        if (event.specId) parts.push(`Spec: ${event.specId}`);
        parts.push(`Remaining tasks in spec: ${event.remainingInSpec}`);
        parts.push('');
        parts.push('Please validate that remaining tasks\' assumptions still hold given this completion.');
        parts.push('If any downstream tasks need updated descriptions, new dependencies, or should be skipped, take action now.');
        parts.push('If no changes are needed, respond with FLIGHTDECK_NO_REPLY.');
        break;

      case 'task_failed':
        parts.push('[plan event: task failed]');
        parts.push(`Task ${event.taskId} failed: ${event.error}`);
        parts.push(`Retries left: ${event.retriesLeft}`);
        parts.push('');
        parts.push('Evaluate whether this task should be re-decomposed into smaller subtasks, the approach changed, or other tasks affected.');
        parts.push('If no plan changes are needed, respond with FLIGHTDECK_NO_REPLY.');
        break;

      case 'worker_escalation':
        parts.push('[plan event: worker escalation]');
        parts.push(`Agent ${event.agentId} escalated on task ${event.taskId}: ${event.reason}`);
        parts.push('');
        parts.push('Decide: Is the task description unclear? Is it too large and should be decomposed? Is there a missing dependency?');
        parts.push('If no plan changes are needed, respond with FLIGHTDECK_NO_REPLY.');
        break;

      case 'spec_milestone':
        parts.push('[plan event: spec milestone]');
        parts.push(`Spec ${event.specId}: ${event.completed}/${event.total} tasks completed.`);
        parts.push('');
        parts.push('Progress checkpoint. Review: Is the remaining plan still coherent? Should priorities be reordered?');
        parts.push('If no changes are needed, respond with FLIGHTDECK_NO_REPLY.');
        break;

      case 'plan_validation_request':
        parts.push('[plan event: validation request]');
        parts.push(`Spec ${event.specId} needs plan review.`);
        parts.push(`Context: ${event.context}`);
        parts.push('');
        parts.push('Please review the remaining plan and make any necessary adjustments.');
        parts.push('If no changes are needed, respond with FLIGHTDECK_NO_REPLY.');
        break;
    }

    return parts.join('\n');
  }

  /** Send a structured PlannerEvent steer */
  async steerPlannerEvent(event: PlannerEvent): Promise<string> {
    const message = this.buildPlannerSteer(event);
    return this.steerPlanner(message);
  }

  /** Steer the persistent Planner with a request */
  async steerPlanner(message: string): Promise<string> {
    // Auto-resume suspended planner on first steer
    if (this.isPlannerSuspended() && this.suspendedPlannerInfo) {
      const info = this.suspendedPlannerInfo;
      this.suspendedPlannerInfo = null;
      try {
        console.error(`  Auto-resuming suspended Planner from session ${info.acpSessionId}...`);
        await this.resumePlanner(info.acpSessionId, info.cwd, info.model);
        console.error(`  Planner resumed (session: ${this.plannerSessionId})`);
      } catch (err) {
        console.error(`  Failed to auto-resume Planner: ${err instanceof Error ? err.message : String(err)}`);
        return '';
      }
    }
    if (!this.plannerSessionId) return '';
    const response = await this.acpAdapter.steer(this.plannerSessionId, { content: message });
    return response;
  }

  /** Get Planner session ID */
  getPlannerSessionId(): string | null {
    return this.plannerSessionId;
  }

  /** Get Lead session ID */
  getLeadSessionId(): string | null {
    return this.leadSessionId;
  }

  /**
   * Resume a Lead agent from a previous ACP session.
   * Falls back to fresh spawn if resume fails.
   */
  async resumeLead(previousAcpSessionId: string, cwd: string, model?: string): Promise<string> {
    try {
      const meta = await this.acpAdapter.resumeSession({
        previousSessionId: previousAcpSessionId,
        cwd,
        role: 'lead',
        model,
      });
      this.leadSessionId = meta.sessionId;
      this.wireStreamHandler();

      this.sqlite.insertAgent({
        id: meta.agentId,
        role: 'lead',
        runtime: 'acp',
      runtimeName: this.leadRuntime ?? 'copilot',
        acpSessionId: meta.sessionId,
        status: 'busy',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });

      return meta.sessionId;
    } catch (err) {
      console.error(`  Lead resume failed (${err instanceof Error ? err.message : String(err)}), marking offline (not spawning fresh to avoid cascading errors)`);
      return '';
    }
  }

  /**
   * Resume a Planner agent from a previous ACP session.
   * Falls back to fresh spawn if resume fails.
   */
  async resumePlanner(previousAcpSessionId: string, cwd: string, model?: string): Promise<string> {
    try {
      const meta = await this.acpAdapter.resumeSession({
        previousSessionId: previousAcpSessionId,
        cwd,
        role: 'planner',
        model,
      });
      this.plannerSessionId = meta.sessionId;

      this.sqlite.insertAgent({
        id: meta.agentId,
        role: 'planner',
        runtime: 'acp',
        runtimeName: this.plannerRuntime ?? this.leadRuntime ?? 'copilot',
        acpSessionId: meta.sessionId,
        status: 'busy',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });

      return meta.sessionId;
    } catch (err) {
      console.error(`  Planner resume failed (${err instanceof Error ? err.message : String(err)}), marking offline (not spawning fresh to avoid cascading errors)`);
      return '';
    }
  }

  /**
   * Handle a Lead response and decide whether to forward to the user.
   * Returns null if the response should be suppressed (IDLE/NO_REPLY).
   */
  handleLeadResponse(response: string, _eventType?: LeadEvent['type']): string | null {
    const trimmed = response.trim();

    // FLIGHTDECK_IDLE on heartbeat → don't forward, just log
    if (trimmed === FLIGHTDECK_IDLE) {
      return null;
    }

    // FLIGHTDECK_NO_REPLY on any event → don't forward
    if (trimmed === FLIGHTDECK_NO_REPLY) {
      return null;
    }

    // Any other response → forward to user
    return response;
  }

  /** Stop heartbeat timer */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private isHeartbeating = false;

  private startHeartbeatTimer(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.isHeartbeating) return; // Guard against overlapping heartbeats
      if (this.checkHeartbeatConditions()) {
        this.isHeartbeating = true;
        this.steerLead({ type: 'heartbeat' })
          .catch(() => {})
          .finally(() => { this.isHeartbeating = false; });
        this.tasksSinceLastHeartbeat = 0;
        this.lastHeartbeatAt = new Date().toISOString();
      }
    }, this.heartbeatConfig.interval);
  }
}

/** Parse duration string like "15m", "1h", "30s" to ms */
function parseDuration(val: string | number | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'number') return val;
  const match = val.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return parseInt(val, 10) || 0;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return n;
  }
}

/** Parse "HH:MM" to minutes since midnight */
function parseTime(val: string): number {
  const [h, m] = val.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

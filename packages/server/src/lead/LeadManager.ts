
import type { SqliteStore } from '../storage/SqliteStore.js';
import type { ProjectStore } from '../storage/ProjectStore.js';
import type { MessageStore, ChatMessage } from '../comms/MessageStore.js';
import type { AcpAdapter } from '../agents/AcpAdapter.js';

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
  | { type: 'heartbeat' };

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

  private plannerSessionId: string | null = null;
  private suspendedPlannerInfo: { acpSessionId: string; cwd: string; model?: string } | null = null;

  constructor(opts: LeadManagerOptions) {
    this.sqlite = opts.sqlite;
    this.project = opts.project;
    this.messageStore = opts.messageStore ?? null;
    this.acpAdapter = opts.acpAdapter;
    this.heartbeatConfig = opts.heartbeat ?? { enabled: false, interval: 30 * 60 * 1000, conditions: [] };
    this.projectName = opts.projectName;
  }

  /** Start Lead ACP session */
  async spawnLead(): Promise<string> {
    // Purge stale offline agents before spawning
    const purged = this.sqlite.purgeOfflineAgents();
    if (purged > 0) {
      console.log(`  Purged ${purged} offline agent(s)`);
    }

    const meta = await this.acpAdapter.spawn({
      role: 'lead',
      cwd: process.cwd(),
      projectName: this.projectName,
    });
    this.leadSessionId = meta.sessionId;

    // Register Lead agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'lead',
      runtime: 'acp',
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

  /** Send an event steer to Lead and return its response text */
  async steerLead(event: LeadEvent): Promise<string> {
    if (!this.leadSessionId) return '';
    const steer = this.buildSteer(event);
    const response = await this.acpAdapter.steer(this.leadSessionId, { content: steer });
    this.lastSteerAt = new Date().toISOString();
    return response;
  }

  /** Build a self-contained steer message with context */
  buildSteer(event: LeadEvent): string {
    const parts: string[] = [];

    switch (event.type) {
      case 'user_message':
        parts.push(`[user message]`);
        parts.push(`User says: ${event.message.content}`);
        parts.push('');
        parts.push(`For project status: read .flightdeck/status.md`);
        break;

      case 'task_comment':
        parts.push(`[task comment]`);
        parts.push(`User commented on task ${event.taskId}:`);
        parts.push(`"${event.message.content}"`);
        parts.push('');
        parts.push(`For full task history: flightdeck_task_get("${event.taskId}")`);
        break;

      case 'task_failure':
        parts.push(`[task failure]`);
        parts.push(`Task ${event.taskId} failed after retries: ${event.error}`);
        parts.push('');
        parts.push(`For task details: flightdeck_task_get("${event.taskId}")`);
        break;

      case 'escalation':
        parts.push(`[escalation]`);
        parts.push(`Agent ${event.agentId} escalated on task ${event.taskId}:`);
        parts.push(`"${event.reason}"`);
        break;

      case 'spec_completed':
        parts.push(`[spec completed]`);
        parts.push(`Spec ${event.specId} is complete. ${event.summary}`);
        parts.push('');
        parts.push('Please write a retrospective to memory/retrospectives/ and update memory/PROJECT.md.');
        break;

      case 'budget_warning':
        parts.push(`[budget warning]`);
        parts.push(`Spending: $${event.currentSpend.toFixed(2)} / $${event.limit.toFixed(2)} limit`);
        break;

      case 'heartbeat':
        return this.buildHeartbeatSteer();
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
      cwd: process.cwd(),
      projectName: this.projectName,
    });
    this.plannerSessionId = meta.sessionId;

    // Register Planner agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'planner',
      runtime: 'acp',
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

      this.sqlite.insertAgent({
        id: meta.agentId,
        role: 'lead',
        runtime: 'acp',
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

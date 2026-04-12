
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

export type LeadEvent =
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'task_comment'; taskId: string; message: ChatMessage }
  | { type: 'task_failure'; taskId: string; error: string }
  | { type: 'escalation'; agentId: string; taskId: string; reason: string }
  | { type: 'spec_completed'; specId: string; summary: string }
  | { type: 'budget_warning'; currentSpend: number; limit: number }
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

  private plannerSessionId: string | null = null;

  constructor(opts: LeadManagerOptions) {
    this.sqlite = opts.sqlite;
    this.project = opts.project;
    this.messageStore = opts.messageStore ?? null;
    this.acpAdapter = opts.acpAdapter;
    this.heartbeatConfig = opts.heartbeat ?? { enabled: false, interval: 30 * 60 * 1000, conditions: [] };
  }

  /** Start Lead ACP session */
  async spawnLead(): Promise<string> {
    const meta = await this.acpAdapter.spawn({
      role: 'lead',
      cwd: process.cwd(),
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

  /** Steer the persistent Planner with a request */
  async steerPlanner(message: string): Promise<void> {
    if (!this.plannerSessionId) return;
    await this.acpAdapter.steer(this.plannerSessionId, { content: message });
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

  private startHeartbeatTimer(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.checkHeartbeatConditions()) {
        this.steerLead({ type: 'heartbeat' }).catch(() => {});
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

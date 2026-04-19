
import type { SqliteStore } from '../storage/SqliteStore.js';
import type { ProjectStore } from '../storage/ProjectStore.js';
import type { MessageStore, ChatMessage } from '../comms/MessageStore.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';
import type { AcpSession } from '../agents/AcpAdapter.js';
import { buildMemoryContext } from '../agents/AgentManager.js';
import { SessionStore } from '../acp/SessionStore.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Format timestamp in user's timezone as ISO with offset */
function formatTs(): string {
  try {
    const gcPath = join(homedir(), '.flightdeck', 'v2', 'global-config.json');
    if (existsSync(gcPath)) {
      const tz = JSON.parse(readFileSync(gcPath, 'utf-8')).timezone;
      if (tz) {
        const d = new Date();
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          timeZoneName: 'longOffset',
        }).formatToParts(d);
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
        const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
      }
    }
  } catch {}
  return new Date().toISOString().slice(0, 19) + 'Z';
}

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
  | { type: 'plan_validation_request'; specId: string; context: string }
  | { type: 'file_conflict'; taskId: string; message: string };

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
  | { type: 'cron'; job: { id: string; name: string; prompt: string; skill?: string } }
  | { type: 'scout_report'; suggestions: Array<{ title: string; description: string; category: string; effort: string; impact: string }> };

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
  idleTimeoutDays?: number; // Default: 3. Stop heartbeat if no user interaction for this many days.
}

export interface LeadManagerOptions {
  sqlite: SqliteStore;
  project: ProjectStore;
  messageStore?: MessageStore;
  acpAdapter: any;
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
  private acpAdapter: any;
  private heartbeatConfig: HeartbeatConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leadSessionId: string | null = null;
  private leadAgentId: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private tasksSinceLastHeartbeat = 0;
  private lastSteerAt: string | null = null;
  private lastUserInteractionAt: number = Date.now();
  private projectName: string | undefined;
  private agentCwd: string;
  private leadRuntime: string | undefined;
  private plannerRuntime: string | undefined;
  /** Optional callback invoked during heartbeat when scout should run */
  public onScoutHeartbeat: (() => Promise<void>) | null = null;

  private plannerSessionId: string | null = null;
  private plannerAgentId: string | null = null;
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

  /** Spawn a new Lead agent session */
  async spawnLead(): Promise<string> {
    // Enforce single active Lead — if one exists, don't spawn another
    const existingLeads = this.sqlite.listAgents().filter(a => a.role === 'lead' && ['busy', 'idle'].includes(a.status));
    if (existingLeads.length > 0) {
      console.error(`  Lead already active (${existingLeads[0].id}), skipping spawn`);
      return this.leadSessionId ?? '';
    }

    // Re-read model config to pick up runtime changes (e.g. user switched from copilot to claude)
    try {
      const { ModelConfig } = await import('../agents/ModelConfig.js');
      const mc = new ModelConfig(this.project.subpath('.'));
      const leadConfig = mc.getRoleConfig('lead');
      if (leadConfig.runtime && leadConfig.runtime !== this.leadRuntime) {
        console.error(`  Lead runtime changed: ${this.leadRuntime} → ${leadConfig.runtime}`);
        this.leadRuntime = leadConfig.runtime;
      }
    } catch { /* fallback to existing runtime */ }

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

    // Build role configs and preference context for Lead
    let roleContext = '';
    try {
      const { ModelConfig } = await import('../agents/ModelConfig.js');
      const mc = new ModelConfig(this.project.subpath('.'));
      const roleConfigs = mc.getRoleConfigs();
      if (roleConfigs.length > 0) {
        roleContext += '\n## Available Roles & Models\n';
        for (const rc of roleConfigs) {
          const models = rc.enabledModels?.filter(m => m.enabled) ?? [];
          const modelList = models.map(m => `${m.runtime}:${m.model}${m.isDefault ? ' (default)' : ''}`).join(', ');
          roleContext += `- **${rc.role}**: ${modelList || `${rc.runtime}:${rc.model}`}\n`;
        }
      }
    } catch { /* best effort */ }

    // Inject current project status into Lead's system prompt
    let statusContext = '';
    try {
      const taskStats = this.sqlite.getTaskStats();
      const agentList = this.sqlite.listAgents().filter(a => ['busy', 'idle'].includes(a.status));
      const busyCount = agentList.filter(a => a.status === 'busy').length;
      const idleCount = agentList.filter(a => a.status === 'idle').length;
      statusContext = `\n## Current Project Status\nTasks: ${taskStats.running ?? 0} running, ${taskStats.ready ?? 0} ready, ${taskStats.done ?? 0} done, ${taskStats.failed ?? 0} failed\nAgents: ${busyCount} busy, ${idleCount} idle\n${agentList.length > 0 ? 'Active agents: ' + agentList.map(a => `${a.id} (${a.role}, ${a.status})`).join(', ') : 'No active agents'}`;
    } catch { /* best effort */ }

    const systemPrompt = [memoryContext, roleContext, statusContext].filter(Boolean).join('\n') || undefined;

    const meta = await this.acpAdapter.spawn({
      role: 'lead',
      cwd: this.agentCwd,
      projectName: this.projectName,
      runtime: this.leadRuntime,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    this.leadSessionId = meta.sessionId;
    this.leadAgentId = meta.agentId;
    this.wireStreamHandler();

    // Register Lead agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'lead',
      runtime: this.leadRuntime ?? 'acp',
      runtimeName: this.leadRuntime ?? 'copilot',
      acpSessionId: meta.sessionId,
      status: 'busy',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    });

    // Save the configured model to DB so UI can display it
    try { const mc = await import("../agents/ModelConfig.js").then(m => new m.ModelConfig(this.project.subpath("."))); const cfg = mc.getRoleConfig("lead"); if (cfg.model) this.sqlite.updateAgentModel(meta.agentId as any, cfg.model); } catch {}
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
    // Mark Lead as busy during steer
    if (this.leadAgentId) this.sqlite.updateAgentStatus(this.leadAgentId as any, 'busy');
    if (event.type === 'user_message') {
      this.lastUserInteractionAt = Date.now();
    }
    const steer = this.buildSteer(event);
    const sourceMessageId = event.type === 'user_message' ? event.message.id : undefined;
    try {
      const response = await this.acpAdapter.steer(this.leadSessionId, { content: steer, sourceMessageId });
      this.lastSteerAt = new Date().toISOString();
      // Mark Lead as idle after response
      if (this.leadAgentId) this.sqlite.updateAgentStatus(this.leadAgentId as any, 'idle');

      // Log to SessionStore for session transcript search
      this.logSessionEvent('user', steer);
      if (response) this.logSessionEvent('agent', response);

      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('ended') || msg.includes('Session')) {
        // Session is dead — reset and spawn fresh
        console.error(`  Lead session dead (${msg}), spawning fresh...`);
        this.leadSessionId = null;
        this.leadAgentId = null;
        try {
          await this.spawnLead();
          if (this.leadSessionId) {
            return this.acpAdapter.steer(this.leadSessionId, { content: steer, sourceMessageId });
          }
        } catch (err2) {
          console.error(`  Failed to respawn Lead: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      }
      console.error(`  Failed to steer Lead: ${msg}`);
      return '';
    }
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
      session.onOutputChunk = (update: any) => handler(update);
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
        const ts = formatTs();
        parts.push(`[${ts}] [USER]`);
        if (event.message.id) parts.push(`message_id: ${event.message.id}`);
        parts.push(`source: web-dashboard`);
        if (event.message.parentId) parts.push(`reply_to: ${event.message.parentId}`);
        if (event.message.taskId) parts.push(`task_id: ${event.message.taskId}`);
        parts.push('---');
        parts.push(event.message.content);
        parts.push('');
        parts.push(`For project status: use flightdeck_status tool`);
        break;
      }

      case 'task_comment': {
        const tcTs = formatTs();
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
        const tfTs = formatTs();
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
        const escTs = formatTs();
        parts.push(`[${escTs}] [AGENT ${event.agentId}]`);
        parts.push(`agent_id: ${event.agentId}`);
        parts.push(`task_id: ${event.taskId}`);
        parts.push(`source: escalation`);
        parts.push('---');
        parts.push(event.reason);
        break;
      }

      case 'spec_completed': {
        const scTs = formatTs();
        parts.push(`[${scTs}] [SYSTEM]`);
        parts.push(`source: spec_completed`);
        parts.push('---');
        parts.push(`Spec ${event.specId} is complete. ${event.summary}`);
        parts.push('');
        parts.push('Please write a retrospective to memory/retrospectives/ and update memory/PROJECT.md.');
        break;
      }

      case 'budget_warning': {
        const bwTs = formatTs();
        parts.push(`[${bwTs}] [SYSTEM]`);
        parts.push(`source: budget_warning`);
        parts.push('---');
        parts.push(`Spending: $${event.currentSpend.toFixed(2)} / $${event.limit.toFixed(2)} limit`);
        break;
      }

      case 'spec_changed': {
        const schTs = formatTs();
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
        const wrTs = formatTs();
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

      case 'scout_report': {
        const srTs = formatTs();
        parts.push(`[${srTs}] [SYSTEM]`);
        parts.push(`source: scout_report`);
        parts.push('---');
        parts.push('Scout has completed an analysis and has improvement suggestions:');
        parts.push('');
        for (const s of event.suggestions) {
          parts.push(`- **${s.title}** [${s.category}] (effort: ${s.effort}, impact: ${s.impact})`);
          parts.push(`  ${s.description}`);
        }
        parts.push('');
        parts.push('Evaluate these suggestions. Delegate worthwhile items to Planner.');
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
    // Check idle timeout — skip heartbeat if user has been inactive too long
    const idleTimeoutMs = (this.heartbeatConfig.idleTimeoutDays ?? 3) * 86400_000;
    if (Date.now() - this.lastUserInteractionAt > idleTimeoutMs) {
      return false; // Skip heartbeat — user inactive
    }

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
    // Read role-preference.md for Planner's system prompt
    let systemPrompt: string | undefined;
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const prefPath = join(this.project.subpath('.'), 'role-preference.md');
      if (existsSync(prefPath)) {
        const pref = readFileSync(prefPath, 'utf-8');
        systemPrompt = `## Task Planning Preference\n${pref}`;
      }
    } catch { /* best effort */ }

    const meta = await this.acpAdapter.spawn({
      role: 'planner',
      cwd: this.agentCwd,
      projectName: this.projectName,
      runtime: this.plannerRuntime,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    this.plannerSessionId = meta.sessionId;
    this.plannerAgentId = meta.agentId;

    // Register Planner agent in SQLite
    this.sqlite.insertAgent({
      id: meta.agentId,
      role: 'planner',
      runtime: this.plannerRuntime ?? this.leadRuntime ?? 'acp',
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

  /** Get Lead session info for gateway state persistence. */
  getLeadSessionInfo(): { agentId: string; sessionId: string; acpSessionId: string; runtime?: string } | null {
    if (!this.leadSessionId || !this.leadAgentId) return null;
    return {
      agentId: this.leadAgentId,
      sessionId: this.leadSessionId,
      acpSessionId: this.leadSessionId,
      runtime: this.leadRuntime,
    };
  }

  getPlannerSessionInfo(): { agentId: string; sessionId: string; acpSessionId: string; runtime?: string } | null {
    if (!this.plannerSessionId || !this.plannerAgentId) return null;
    return {
      agentId: this.plannerAgentId,
      sessionId: this.plannerSessionId,
      acpSessionId: this.plannerSessionId,
      runtime: this.plannerRuntime,
    };
  }

  /** Cancel the current Lead response (interrupt) */
  async cancelLead(): Promise<void> {
    if (!this.leadSessionId) return;
    const session = this.acpAdapter.getSession(this.leadSessionId);
    if (session?.acpSessionId && session.status !== 'ended') {
      try {
        await session.connection.cancel({ sessionId: session.acpSessionId });
      } catch {
        // Best effort — agent may have already finished
      }
    }
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
        runtime: this.leadRuntime,
      });
      this.leadSessionId = meta.sessionId;
    this.leadAgentId = meta.agentId;
      this.wireStreamHandler();

      this.sqlite.insertAgent({
        id: meta.agentId,
        role: 'lead',
        runtime: this.leadRuntime ?? 'acp',
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
    this.plannerAgentId = meta.agentId;

      this.sqlite.insertAgent({
        id: meta.agentId,
        role: 'planner',
        runtime: this.plannerRuntime ?? this.leadRuntime ?? 'acp',
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
        const tasksCompleted = this.tasksSinceLastHeartbeat;
        this.steerLead({ type: 'heartbeat' })
          .then(async () => {
            // Run scout if enabled and there were completed tasks
            const cfg = this.project.getConfig() as any;
            if (cfg.scoutEnabled && tasksCompleted > 0 && this.onScoutHeartbeat) {
              try { await this.onScoutHeartbeat(); } catch (e) { console.error('  Scout heartbeat failed:', e); }
            }
          })
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

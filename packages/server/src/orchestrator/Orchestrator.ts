import type { TaskId, SideEffect, ProjectConfig, AgentId } from '@flightdeck-ai/shared';
import { loadGlobalConfig } from '../config/GlobalConfig.js';
import { type TaskDAG } from '../dag/TaskDAG.js';
import { type SqliteStore } from '../storage/SqliteStore.js';
import { type GovernanceEngine } from '../governance/GovernanceEngine.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';
import { type SuggestionStore } from '../storage/SuggestionStore.js';
import type { WorkflowEngine, StepAction } from '../workflow/WorkflowEngine.js';
import type { AgentManager } from '../agents/AgentManager.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { MessageStore } from '../comms/MessageStore.js';
import type { WebSocketServer } from '../api/WebSocketServer.js';
import type { SessionManager } from '../agents/SessionManager.js';
import type { DecisionLog } from '../storage/DecisionLog.js';
import { StatusFileWriter, type StatusData } from '../status/StatusFileWriter.js';
import { SpecChangeDetector, type SpecChange } from '../specs/SpecChangeDetector.js';
import { WebhookNotifier, type NotificationsConfig, taskCompletedEvent, taskFailedEvent, specCompletedEvent, escalationEvent, agentStallEvent, budgetWarningEvent } from '../integrations/WebhookNotifier.js';
import type { SpecStore } from '../storage/SpecStore.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log, truncate } from '../utils/logger.js';

/** Format timestamp in user's timezone as ISO with offset */
function formatTs(): string {
  try {
    const gc = loadGlobalConfig() as any;
    if (gc.timezone) {
      const tz = gc.timezone;
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
  } catch {}
  return new Date().toISOString().slice(0, 19) + 'Z';
}

export interface GovernanceConfig {
  costThresholdPerDay?: number;
  maxRetries?: number;
  /** Hours after completion before a task gets compacted. Default: 24 */
  compactionTtlHours?: number;
  /** Minutes a task can be 'running' before sending a submit reminder. Default: 10 */
  stallTimeoutMinutes?: number;
}

export interface TickResult {
  readyTasksAssigned: number;
  stallsDetected: number;
  completionsProcessed: number;
  errorsHandled: number;
  tasksCompacted: number;
  retrospectivesTriggered: number;
  specChangesDetected: number;
  tasksMarkedStale: number;
}

/**
 * The Orchestrator is a tick loop that runs in the daemon.
 * It does NOT use tokens — it's pure code logic.
 *
 * Each tick:
 * 1. Promote ready tasks — check DAG dependencies, if all deps done → mark task ready
 * 2. Auto-assign ready tasks — find unassigned ready tasks, spawn worker agents
 * 3. Process completions — tasks in in_review that passed review → mark done
 * 4. Detect stalls — check ACP session state for running agents
 * 5. Check budget — if cost exceeds threshold, steer Lead with warning
 * 6. Broadcast state changes — push updates to WebSocket clients
 *
 * The orchestrator does NOT steer Lead for normal task completions.
 * Only for: failures (after retries), spec completions, budget warnings, escalations.
 */
export class Orchestrator {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private _paused = false;
  private _stopped = false;
  private adapter: AgentAdapter;
  private agentManager: AgentManager | null;
  private leadManager: LeadManager | null;
  private messageStore: MessageStore | null;
  private wsServer: WebSocketServer | null;
  private governanceConfig: GovernanceConfig;
  private sessionManager: SessionManager | null;
  private retryCount = new Map<TaskId, number>();
  private lastIdlePing = new Map<TaskId, number>();
  private idlePingCount = new Map<TaskId, number>();
  private notifiedTaskIds = new Set<string>();
  /** Tracks which specs have had retrospectives triggered. Bounded: entries older than 24h are pruned. */
  private retrospectivesDone = new Map<string, number>();
  private decisionLog: DecisionLog | null;
  private statusWriter: StatusFileWriter;
  private workflowEngine: WorkflowEngine | null;
  private suggestionStore: SuggestionStore | null;
  private specChangeDetector: SpecChangeDetector | null;
  private recentSpecChanges: SpecChange[] = [];
  private webhookNotifier: WebhookNotifier;
  /** Debounce timer for event-driven reactivity */
  private reactDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long to debounce state change events before running a reactive tick (ms) */
  private static readonly REACT_DEBOUNCE_MS = 500;
  /** Bound handler for cleanup */
  private boundReactHandler: (() => void) | null = null;

  constructor(
    private dag: TaskDAG,
    private store: SqliteStore,
    private governance: GovernanceEngine,
    adapter: AgentAdapter,
    private config: ProjectConfig,
    sessionManager?: SessionManager,
    opts?: {
      agentManager?: AgentManager;
      leadManager?: LeadManager;
      messageStore?: MessageStore;
      wsServer?: WebSocketServer;
      governanceConfig?: GovernanceConfig;
      decisionLog?: DecisionLog;
      workflowEngine?: WorkflowEngine;
      suggestionStore?: SuggestionStore;
      specStore?: SpecStore;
      notifications?: NotificationsConfig;
    },
  ) {
    this.adapter = adapter;
    this.sessionManager = sessionManager ?? null;
    this.agentManager = opts?.agentManager ?? null;
    this.leadManager = opts?.leadManager ?? null;
    this.messageStore = opts?.messageStore ?? null;
    this.wsServer = opts?.wsServer ?? null;
    this.governanceConfig = opts?.governanceConfig ?? {};
    this.decisionLog = opts?.decisionLog ?? null;
    this.statusWriter = new StatusFileWriter(1000, join(homedir(), '.flightdeck', 'v2', 'projects', config.name ?? 'unknown'));
    this.workflowEngine = opts?.workflowEngine ?? null;
    this.suggestionStore = opts?.suggestionStore ?? null;
    this.specChangeDetector = opts?.specStore ? new SpecChangeDetector(opts.specStore, store) : null;
    this.webhookNotifier = new WebhookNotifier(config, opts?.notifications);

    // Wire up effect handler so TaskDAG delegates complex effects to the Orchestrator
    this.dag.setEffectHandler((effect) => this.handleEffect(effect));
  }

  /**
   * Handle side effects delegated from TaskDAG that require external services
   * (spawning agents, sending messages, logging decisions).
   */
  private handleEffect(effect: SideEffect): void {
    log('Orchestrator', `Effect: ${effect.type}${(effect as any).taskId ? ` for ${(effect as any).taskId}` : ''}`);
    switch (effect.type) {
      case 'spawn_reviewer': {
        // With attention set, reviews are handled by processAttentionSetReviews in tick.
        // The spawn_reviewer effect just triggers a reactive tick to pick it up.
        this.scheduleReactiveTick();
        break;
      }
      case 'escalate': {
        const escalatedTask = this.dag.getTask(effect.taskId);
        this.leadManager?.steerLead({
          type: 'escalation',
          taskId: effect.taskId as string,
          agentId: (escalatedTask?.assignedAgent as string) ?? 'unknown',
          reason: effect.reason,
        });
        this.webhookNotifier?.notify(
          escalationEvent(this.config.name, effect.reason, (escalatedTask?.assignedAgent as string) ?? undefined),
        );
        // Also notify Director about escalations
        this.notifyDirectorIfNeeded(effect.taskId, 'escalated');
        break;
      }
      case 'notify_agent': {
        if (!this.messageStore) break;
        this.messageStore.createMessage({
          authorType: 'system',
          authorId: 'orchestrator',
          content: effect.message,
          taskId: null,
          
          parentId: null,
          metadata: null,
        });
        break;
      }
      case 'update_dag': {
        this.broadcastStateChange();
        break;
      }
      case 'log_decision': {
        if (this.decisionLog) {
          this.decisionLog.append(effect.decision);
        } else {
          this.governance.recordDecision(effect.decision);
        }
        break;
      }
      case 'notify_lead_completed': {
        this.leadManager?.steerLead({
          type: 'task_completed_notify',
          taskId: effect.taskId as string,
          title: effect.title,
          claim: effect.claim,
        });
        break;
      }
      case 'notify_lead_declared': {
        const titles = effect.tasks.map(t => t.title).join(', ');
        this.leadManager?.steerLead({
          type: 'tasks_declared_notify',
          message: `Director declared ${effect.tasks.length} task(s): ${titles}`,
        });
        break;
      }
    }
  }

  /**
   * Pause the orchestrator — stop claiming new tasks but let in-progress tasks finish.
   */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resume the orchestrator — start claiming new tasks again.
   */
  resume(): void {
    this._paused = false;
  }

  /**
   * Whether the orchestrator is paused.
   */
  get paused(): boolean {
    return this._paused;
  }

  /** Access the webhook notifier (may be null if no webhooks configured). */
  getWebhookNotifier(): WebhookNotifier {
    return this.webhookNotifier;
  }

  async tick(): Promise<TickResult> {
    // Guard: don't tick if explicitly stopped (DB may be closed)
    if (this._stopped) return {
      readyTasksAssigned: 0, stallsDetected: 0, completionsProcessed: 0,
      errorsHandled: 0, tasksCompacted: 0, retrospectivesTriggered: 0,
      specChangesDetected: 0, tasksMarkedStale: 0,
    };
    const result: TickResult = {
      readyTasksAssigned: 0,
      stallsDetected: 0,
      completionsProcessed: 0,
      errorsHandled: 0,
      tasksCompacted: 0,
      retrospectivesTriggered: 0,
      specChangesDetected: 0,
      tasksMarkedStale: 0,
    };

    // When paused, skip the entire tick — let in-progress tasks finish naturally
    // but don't promote, assign, or process anything new.
    if (this._paused) return result;


    let stateChanged = false;

    // 0. Check for spec changes (FR-008)
    const specChangeResult = this.checkSpecChanges();
    result.specChangesDetected = specChangeResult.changes;
    result.tasksMarkedStale = specChangeResult.staleMarked;
    if (specChangeResult.changes > 0) stateChanged = true;

    // 1. Promote ready tasks — pending tasks whose deps are all done
    const promoted = this.promoteReadyTasks();
    if (promoted > 0) stateChanged = true;

    // 2. Process attention set reviews for in_review tasks
    await this.processAttentionSetReviews();

    // 3. Detect stalls — check ACP session state for running agents
    const stalls = await this.detectStalls();
    result.stallsDetected = stalls.detected;
    result.errorsHandled += stalls.errors;
    if (stalls.detected > 0) stateChanged = true;

    // 4. Auto-assign ready tasks
    const assigned = this.autoAssignReadyTasks();
    result.readyTasksAssigned = assigned;
    if (assigned > 0) stateChanged = true;

    // 5. Check budget
    this.checkBudget();

    // 6. Check for spec completions — notify Lead only when all tasks in a spec are done
    const specResults = this.checkSpecCompletions();
    result.retrospectivesTriggered = specResults.retrospectives;

    // 7. Compact old completed tasks (FR-015)
    result.tasksCompacted = this.compactOldTasks();

    // Log tick summary
    if (result.readyTasksAssigned > 0 || result.stallsDetected > 0 || result.completionsProcessed > 0) {
      const agents = this.store.listAgents();
      const readyTasks = this.dag.getReadyTasks().filter(t => !t.assignedAgent).length;
      const runningTasks = this.dag.listTasks().filter(t => t.state === 'running').length;
      const idleAgents = agents.filter(a => a.status === 'idle').length;
      log('Orchestrator', `Tick: ${readyTasks} ready, ${runningTasks} running, ${idleAgents} idle agent(s)`);
    }

    // 8. Broadcast state changes to WebSocket clients
    if (stateChanged) {
      this.broadcastStateChange();
    }

    // 9. Write status files to project directory
    if (stateChanged) {
      this.writeStatusFiles();
    }

    return result;
  }

  /**
   * Check for spec file changes and mark affected tasks as stale (FR-008).
   */
  private checkSpecChanges(): { changes: number; staleMarked: number } {
    if (!this.specChangeDetector) return { changes: 0, staleMarked: 0 };

    const changes = this.specChangeDetector.checkForChanges();
    if (changes.length === 0) return { changes: 0, staleMarked: 0 };

    let staleMarked = 0;

    for (const change of changes) {
      if (change.isNew) continue; // New specs don't have linked tasks yet

      const marked = this.store.markTasksStaleBySpec(change.specId);
      staleMarked += marked;

      if (marked > 0) {
        // Notify Lead about stale tasks
        this.leadManager?.steerLead({
          type: 'spec_changed',
          specId: change.specId as string,
          summary: `Spec "${change.filename}" changed. ${marked} task(s) marked stale and may need re-planning.`,
        });
      }
    }

    // Store recent changes for MCP tool access
    this.recentSpecChanges = [...changes, ...this.recentSpecChanges].slice(0, 50);

    return { changes: changes.length, staleMarked };
  }

  /**
   * Get recent spec changes (for MCP tool access).
   */
  getRecentSpecChanges(): SpecChange[] {
    return this.recentSpecChanges;
  }

  /**
   * Promote pending tasks to ready when all dependencies are done.
   */
  private promoteReadyTasks(): number {
    const allTasks = this.dag.listTasks();
    let promoted = 0;

    for (const task of allTasks) {
      if (task.state !== 'pending' && task.state !== 'blocked') continue;

      // Check if all dependencies are done (or skipped/cancelled)
      const depsResolved = task.dependsOn.every(depId => {
        const dep = this.dag.getTask(depId);
        return dep && (dep.state === 'done' || dep.state === 'skipped' || dep.state === 'cancelled');
      });

      if (depsResolved) {
        try {
          this.store.updateTaskState(task.id, 'ready');
          promoted++;
        } catch { /* invalid transition or already ready */ }
      }
    }

    return promoted;
  }

  /**
   * Process tasks in in_review:
   * - If verification is disabled in governance, auto-complete them.
   * - If verification is enabled, reviewer agents handle the transition
   *   via the spawn_reviewer effect → completeTask/failTask.
   *
   * When a WorkflowEngine is configured, completed tasks are advanced
   * through their pipeline (e.g., running post-review steps).
   */

  /**
   * Process tasks in in_review state using the attention set (reviewers array).
   * - If task has reviewers assigned, steer each available reviewer
   * - If reviewer is unavailable (session ended/hibernated), notify Director
   * - If no reviewers assigned and needsReview is true, notify Director to assign
   */
  private reviewInProgress = new Set<string>();
  private reviewSteerRetries = new Map<string, number>();
  private async processAttentionSetReviews(): Promise<void> {
    if (!this.adapter) return;
    const inReviewTasks = this.dag.listTasks().filter(t => t.state === 'in_review');
    for (const task of inReviewTasks) {
      if (this.reviewInProgress.has(task.id)) continue;

      const reviewers = (task as any).reviewers as string[] | null;

      // No reviewers assigned — notify Director to assign
      if (!reviewers || reviewers.length === 0) {
        if (!this.notifiedTaskIds.has(`review-needed:${task.id}`)) {
          this.notifiedTaskIds.add(`review-needed:${task.id}`);
          this.leadManager?.steerDirectorEvent({
            type: 'reviewers_needed',
            taskId: task.id as string,
            title: task.title,
            message: `Task "${task.title}" (${task.id}) is in_review but has no reviewers assigned. Use flightdeck_task_set_reviewers("${task.id}", ["<agentId>"]) to assign.`,
          });
        }
        continue;
      }

      // Has reviewers — steer each one
      this.reviewInProgress.add(task.id);
      let steeredAny = false;

      for (const reviewerId of reviewers) {
        const agent = this.store.getAgent(reviewerId as any);
        if (!agent) {
          // Agent doesn't exist — notify Director
          this.leadManager?.steerDirectorEvent({
            type: 'reviewer_unavailable',
            taskId: task.id as string,
            agentId: reviewerId,
            title: task.title,
            message: `Reviewer "${reviewerId}" for task "${task.title}" does not exist. Spawn or reassign.`,
          });
          continue;
        }

        if (agent.status === 'hibernated' || agent.status === 'errored') {
          // Agent is hibernated/offline — notify Director
          this.leadManager?.steerDirectorEvent({
            type: 'reviewer_unavailable',
            taskId: task.id as string,
            agentId: reviewerId,
            title: task.title,
            message: `Reviewer "${reviewerId}" is ${agent.status}. Wake with flightdeck_agent_wake or reassign.`,
          });
          continue;
        }

        // Agent exists and is idle/busy — steer with review prompt
        if (agent.acpSessionId) {
          const reviewPrompt = [
            `[${formatTs()}] [SYSTEM] Review requested for task "${task.title}" (${task.id}).`,
            task.description ? `Description: ${task.description}` : '',
            (task as any).claim ? `Submission: ${(task as any).claim}` : '',
            (task as any).acceptanceCriteria ? `Acceptance Criteria: ${(task as any).acceptanceCriteria}` : '',
            '',
            'Review the work and use flightdeck_task_complete() to approve or flightdeck_task_fail() to reject with feedback.',
          ].filter(Boolean).join('\n');

          try {
            await this.adapter.steer(agent.acpSessionId, { content: reviewPrompt });
            steeredAny = true;
          } catch (err) {
            // Retry once
            const retryKey = `${task.id}:${reviewerId}`;
            const retries = this.reviewSteerRetries.get(retryKey) ?? 0;
            if (retries < 1) {
              this.reviewSteerRetries.set(retryKey, retries + 1);
              try {
                await this.adapter.steer(agent.acpSessionId, { content: reviewPrompt });
                steeredAny = true;
              } catch {
                this.leadManager?.steerDirectorEvent({
                  type: 'reviewer_unavailable',
                  taskId: task.id as string,
                  agentId: reviewerId,
                  title: task.title,
                  message: `Failed to steer reviewer "${reviewerId}" for task "${task.title}". Session may be dead.`,
                });
              }
            } else {
              this.leadManager?.steerDirectorEvent({
                type: 'reviewer_unavailable',
                taskId: task.id as string,
                agentId: reviewerId,
                title: task.title,
                message: `Failed to steer reviewer "${reviewerId}" after retry. Reassign or respawn.`,
              });
            }
          }
        }
      }

      if (!steeredAny) {
        // None of the reviewers could be steered
        this.reviewInProgress.delete(task.id);
      }
      // Note: reviewInProgress stays set until task leaves in_review state
      // The tick will re-check on next pass
    }

    // Clean up reviewInProgress for tasks no longer in_review
    for (const taskId of this.reviewInProgress) {
      const t = this.dag.getTask(taskId as any);
      if (!t || t.state !== 'in_review') {
        this.reviewInProgress.delete(taskId);
      }
    }
  }

  /**
   * Handle a workflow step action for a task.
   */
  private handleWorkflowAction(taskId: TaskId, action: StepAction): void {
    switch (action.type) {
      case 'run_command': {
        const cwd = this.config.cwd;
        const result = this.workflowEngine!.executeRunStep(action.command, cwd);
        if (result.success) {
          const nextAction = this.workflowEngine!.advanceTask(taskId);
          this.handleWorkflowAction(taskId, nextAction);
        } else {
          const currentStep = this.workflowEngine!.getCurrentStep(taskId);
          const failAction = this.workflowEngine!.handleFailure(
            taskId,
            (currentStep?.on_fail as 'return_to_worker' | 'reject' | 'warn' | 'skip') ?? 'warn',
          );
          this.handleWorkflowAction(taskId, failAction);
        }
        break;
      }
      case 'assign_role':
      case 'done':
      case 'pipeline_complete':
      case 'discussion':
        // These are informational — the task is already in its final state
        break;
    }
  }

  /**
   * Detect stalls by checking ACP session state.
   * - Active + no submit = working, do nothing
   * - Idle too long = possible stall → ACP ping
   * - Ended + no submit = definite stall → kill + respawn
   */
  private async detectStalls(): Promise<{ detected: number; errors: number }> {
    let detected = 0;
    let errors = 0;

    const runningTasks = this.dag.listTasks().filter(t => t.state === 'running');

    for (const task of runningTasks) {
      if (!task.assignedAgent || !task.acpSessionId) continue;

      try {
        const meta = await this.adapter.getMetadata(task.acpSessionId);
        if (!meta) continue;

        if (meta.status === 'running') {
          // Active session — let it run as long as it needs
          continue;
        }

        if (meta.status === 'idle') {
          // Idle session, task not submitted — ping at most once per 5 minutes
          const lastPing = this.lastIdlePing?.get(task.id) ?? 0;
          if (Date.now() - lastPing >= 300_000) {
            const count = (this.idlePingCount.get(task.id) ?? 0) + 1;
            this.idlePingCount.set(task.id, count);

            if (count >= 3) {
              // 3 consecutive idle pings — auto-escalate to Director
              this.notifyDirectorIfNeeded(task.id, 'session_stalled');
              this.idlePingCount.set(task.id, 0);
            } else {
              const desc = task.description || 'No description provided.';
              const ac = (task as any).acceptanceCriteria || 'Not specified.';
              await this.adapter.steer(task.acpSessionId, {
                content: `[${formatTs()}] [SYSTEM] Continue working on your assigned task.

Task: "${task.title}" (${task.id})
Description: ${desc}
Acceptance Criteria: ${ac}

Your turn ended but the task is not yet submitted. Continue making progress toward the acceptance criteria.

Continuation behavior:
- Keep the full task scope intact. Do not redefine success around a smaller or easier subset.
- If you're blocked, use flightdeck_escalate to ask for help.
- When done, use flightdeck_task_submit with a clear summary of what was completed.
- Do not stop working just because a turn ended — keep going until the task is complete or you're blocked.`,
              });
            }
            this.lastIdlePing.set(task.id, Date.now());
            detected++;
          }
        }

        if (meta.status === 'ended') {
          // Session ended without submit
          const retries = this.retryCount.get(task.id) ?? 0;
          const maxRetries = this.governanceConfig.maxRetries ?? 3;

          if (retries >= maxRetries) {
            // Max retries exhausted — fail the task and notify Lead
            this.store.updateTaskState(task.id, 'failed' as any);
            this.store.clearTaskAssignment(task.id);
            this.leadManager?.steerLead({
              type: 'task_failure',
              taskId: task.id as string,
              error: `Task "${task.title}" failed after ${retries} retries (agent session ended without submit)`,
            });
          } else {
            // Reset task for retry
            this.retryCount.set(task.id, retries + 1);
            this.store.updateTaskState(task.id, 'ready' as any);
            this.store.clearTaskAssignment(task.id);
            this.notifyDirectorIfNeeded(task.id, 'session_ended');
          }
          this.store.updateAgentStatus(task.assignedAgent, 'hibernated');
          detected++;
        }
      } catch {
        errors++;
      }
    }

    // Cross-check session health from SessionManager
    if (this.sessionManager) {
      const healthList = this.sessionManager.checkHealth();
      for (const h of healthList) {
        if (h.status === 'ended') {
          const staleTask = runningTasks.find(t => {
            const session = this.sessionManager?.getSession(h.sessionId);
            return session && t.assignedAgent === session.agentId;
          });
          if (staleTask && staleTask.assignedAgent) {
            try {
              this.dag.failTask(staleTask.id);
              this.dag.retryTask(staleTask.id);
              this.store.updateAgentStatus(staleTask.assignedAgent, 'hibernated');
              detected++;
            } catch { /* already handled */ }
          }
        }
      }
    }

    return { detected, errors };
  }

  /**
   * Find ready, unassigned tasks and assign to idle agents.
   */
  private autoAssignReadyTasks(): number {
    const readyTasks = this.dag.getReadyTasks().filter(t => !t.assignedAgent);
    const agents = this.store.listAgents().filter(a => a.status === 'idle');
    let notified = 0;

    for (const task of readyTasks) {
      // Check governance gate
      if (this.governance.shouldGateTaskStart(task.state, task.role)) {
        try {
          this.dag.gateTask(task.id);
        } catch { /* may not be valid transition */ }
        continue;
      }

      // Skip already-notified tasks
      if (this.notifiedTaskIds.has(task.id)) continue;

      // Notify Director instead of auto-assigning
      if (this.leadManager) {
        const t = task as any;
        const idleForRole = agents.filter(a => a.role === task.role);
        const idleList = idleForRole.length > 0
          ? idleForRole.map(a => `${a.id} (${a.role}${a.runtimeName ? ', runtime: ' + a.runtimeName : ''})`).join(', ')
          : '(none)';
        const lines = [
          `[SYSTEM] Task ready for assignment:`,
          `Task: "${task.title}" (${task.id})`,
          `Role: ${task.role}`,
          t.description ? `Description: ${t.description}` : '',
          task.runtime ? `Runtime: ${task.runtime}` : '',
          task.model ? `Model: ${task.model}` : '',
          '',
          `Assign with: flightdeck_task_delegate("${task.id}", "<agentId>")`,
          `Or spawn new: flightdeck_agent_spawn({role: "${task.role}", ...})`,
          `Idle ${task.role} agents: ${idleList}`,
        ].filter(Boolean).join('\n');
        this.leadManager.steerDirector?.(lines).catch(() => {});
        this.notifiedTaskIds.add(task.id);
        notified++;
        log('Orchestrator', `Notified Director about ready task "${truncate(task.title, 50)}" (${task.id})`);
      }
    }

    return notified;
  }

  /**
   * Check if total cost exceeds threshold → warn Lead.
   */
  private checkBudget(): void {
    const threshold = this.governanceConfig.costThresholdPerDay ?? this.config.costThresholdPerDay;
    if (!threshold) return;

    const totalCost = this.store.getTotalCost();
    const costResult = this.governance.checkCostThreshold(totalCost);

    if (!costResult.allowed) {
      // Over budget — steer Lead
      this.leadManager?.steerLead({
        type: 'budget_warning',
        currentSpend: totalCost,
        limit: threshold,
      });
      this.webhookNotifier?.notify(
        budgetWarningEvent(this.config.name, totalCost, threshold),
      );
    }
  }

  /**
   * Check if all tasks in any spec are complete.
   * Handles on_completion modes: explore, stop, ask.
   */
  private checkSpecCompletions(): { retrospectives: number } {
    let retrospectives = 0;
    const allTasks = this.dag.listTasks();
    const specTasks = new Map<string, { total: number; done: number }>();

    for (const task of allTasks) {
      if (!task.specId) continue;
      const entry = specTasks.get(task.specId) ?? { total: 0, done: 0 };
      entry.total++;
      if (task.state === 'done' || task.state === 'skipped' || task.state === 'cancelled') {
        entry.done++;
      }
      specTasks.set(task.specId, entry);
    }

    for (const [specId, counts] of specTasks) {
      if (counts.total > 0 && counts.done === counts.total) {
        // All tasks done — handle based on on_completion mode (only once per spec)
        if (!this.retrospectivesDone.has(specId)) {
          const onCompletion = this.config.onCompletion ?? 'stop';

          switch (onCompletion) {
            case 'explore': {
              // Notify Lead about completion
              this.leadManager?.steerLead({
                type: 'spec_completed',
                specId,
                summary: `All ${counts.total} tasks complete. Scout analysis requested.`,
              });
              // Scout runs async — fire and forget, store results when done
              this.runScoutAsync(specId);
              break;
            }
            case 'ask': {
              // Notify Lead + user, agents idle
              this.leadManager?.steerLead({
                type: 'spec_completed',
                specId,
                summary: `All ${counts.total} tasks complete. Awaiting user decision on next steps.`,
              });
              break;
            }
            case 'stop':
            default: {
              // Final report, mark spec as complete
              this.leadManager?.steerLead({
                type: 'spec_completed',
                specId,
                summary: `All ${counts.total} tasks complete.`,
              });
              break;
            }
          }

          this.leadManager?.recordTaskCompletion();
          this.retrospectivesDone.set(specId, Date.now());
          // Fire webhook for spec completion
          this.webhookNotifier?.notify(
            specCompletedEvent(this.config.name, specId, counts.total),
          );
          // Prune entries older than 24 hours to prevent unbounded growth
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          for (const [id, ts] of this.retrospectivesDone) {
            if (ts < cutoff) this.retrospectivesDone.delete(id);
          }
          retrospectives++;
        }
      }
    }

    return { retrospectives };
  }

  /**
   * Run the scout agent asynchronously and store suggestions.
   */
  private runScoutAsync(specId: string): void {
    if (!this.suggestionStore) return;
    // Log the scout analysis request
    if (this.messageStore) {
      const tasks = this.dag.listTasks().filter(t => t.specId === specId && t.state === 'done');
      this.messageStore.createMessage({
        authorType: 'system',
        authorId: 'orchestrator',
        content: `[scout] Analysis requested for spec ${specId}. ${tasks.length} completed tasks to review. Use flightdeck_suggestion_list to view results.`,
        taskId: null,
        
        parentId: null,
        metadata: null,
      });
    }
    // The actual scout agent spawn is triggered by the daemon's event loop,
    // which has access to the full Flightdeck facade and can call runScout().
  }

  /**
   * Compact completed tasks older than the configured TTL (FR-015).
   */
  private compactOldTasks(): number {
    const ttlHours = this.governanceConfig.compactionTtlHours ?? 24;
    const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();
    const allTasks = this.dag.listTasks();
    let compacted = 0;

    for (const task of allTasks) {
      // Skip already compacted or non-terminal tasks
      if (task.compactedAt) continue;
      if (task.state !== 'done' && task.state !== 'skipped' && task.state !== 'cancelled' && task.state !== 'failed') continue;
      // Check if completion is old enough
      if (task.updatedAt > cutoff) continue;

      try {
        this.dag.compactTask(task.id);
        compacted++;
      } catch { /* skip on error */ }
    }

    return compacted;
  }

  /**
   * Broadcast current state to all WebSocket clients.
   */
  private broadcastStateChange(): void {
    if (!this.wsServer) return;
    const stats = this.dag.getStats();
    // Broadcast structured state update for UI refresh
    this.wsServer.broadcast({
      type: 'state:update' as any,
      stats,
    } as any);
  }

  /**
   * Write status.md to the state directory (not project cwd).
   */
  private writeStatusFiles(): void {
    const cwd = this.config.cwd;
    if (!cwd) return; // No project cwd configured

    try {
      const tasks = this.dag.listTasks();
      const agents = this.store.listAgents();
      const totalCost = this.store.getTotalCost();

      const data: StatusData = {
        projectName: this.config.name,
        governance: this.config.governance,
        tasks,
        agents,
        totalCost,
      };

      this.statusWriter.writeStatus(cwd, data);
      // TaskContextWriter is now a no-op — context served via MCP tool
    } catch {
      // Status file writing is best-effort — don't crash the orchestrator
    }
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalHandle) return;
    // Recover orphaned running tasks from previous daemon session
    this.recoverOrphanedTasks();
    this.intervalHandle = setInterval(() => { void this.tick().catch(() => { /* DB may be closed */ }); }, intervalMs);

    // Subscribe to task state changes for event-driven reactivity
    this.boundReactHandler = () => this.scheduleReactiveTick();
    this.store.on('task-state-changed', this.boundReactHandler);

    // Subscribe to merge conflicts for Director notification
    this.store.on('merge-conflict', (info: { taskId: string; branch: string }) => {
      this.leadManager?.steerDirectorEvent({
        type: 'file_conflict',
        taskId: info.taskId,
        message: `Merge conflict on branch ${info.branch} for task ${info.taskId}. The worktree is preserved for manual resolution. Options: task_pause other conflicting tasks, task_retry on latest main, or escalate to Lead.`,
      });
    });
  }

  /**
   * On startup, reset any tasks stuck in 'running' state from a previous daemon session.
   * These tasks have no live ACP session, so they should be failed and retried.
   */
  private recoverOrphanedTasks(): void {
    const runningTasks = this.dag.listTasks().filter(t => t.state === 'running');
    let recovered = 0;
    for (const task of runningTasks) {
      // If the agent has no active session, it's orphaned
      const hasLiveSession = task.acpSessionId && this.sessionManager?.getSession(task.acpSessionId);
      if (!hasLiveSession) {
        try {
          this.dag.failTask(task.id);
          this.dag.retryTask(task.id); // back to ready
        } catch {
          // Task may already have been reset by another code path
        }
        if (task.assignedAgent) {
          const agentRecord = this.store.getAgent(task.assignedAgent);
          const newStatus = 'hibernated';
          this.store.updateAgentStatus(task.assignedAgent, newStatus);
        }
        recovered++;
      }
    }

    // Also reset any agents stuck in 'busy' with no live session
    const allAgents = this.store.listAgents();
    for (const agent of allAgents) {
      if (agent.status === 'busy') {
        const hasLiveSession = agent.acpSessionId && this.sessionManager?.getSession(agent.acpSessionId);
        if (!hasLiveSession) {
          // If agent has a saved session ID, hibernate (can resume later); otherwise offline
          const newStatus = 'hibernated';
          this.store.updateAgentStatus(agent.id, newStatus);
          recovered++;
        }
      }
    }

    if (recovered > 0) {
      console.log(`[orchestrator] Recovered ${recovered} orphaned task(s)/agent(s) on startup`);
    }
  }

  stop(): void {
    this._stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.reactDebounceTimer) {
      clearTimeout(this.reactDebounceTimer);
      this.reactDebounceTimer = null;
    }
    if (this.boundReactHandler) {
      this.store.removeListener('task-state-changed', this.boundReactHandler);
      this.boundReactHandler = null;
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Schedule a lightweight reactive tick after a debounce window.
   * Multiple state changes within REACT_DEBOUNCE_MS coalesce into one tick.
   * Only runs promote + auto-assign + spawn reviewers (not stall detection, compaction, etc.)
   */
  private scheduleReactiveTick(): void {
    if (this._paused) return;
    if (this.reactDebounceTimer) return; // already scheduled
    this.reactDebounceTimer = setTimeout(() => {
      this.reactDebounceTimer = null;
      void this.reactiveTick().catch(() => { /* DB may be closed */ });
    }, Orchestrator.REACT_DEBOUNCE_MS);
  }

  /**
   * Lightweight tick triggered by state change events.
   * Only promotes blocked/pending → ready and assigns ready tasks to idle agents.
   */
  private async reactiveTick(): Promise<void> {
    if (this._paused || this._stopped) return;
    let stateChanged = false;

    const promoted = this.promoteReadyTasks();
    if (promoted > 0) stateChanged = true;

    await this.processAttentionSetReviews();

    const assigned = this.autoAssignReadyTasks();
    if (assigned > 0) stateChanged = true;

    if (stateChanged) {
      this.broadcastStateChange();
      this.writeStatusFiles();
    }
  }

  /* ── Reactive Director notifications ─────────────────────────── */

  private specMilestonesSent = new Map<string, Set<number>>();

  private notifyDirectorIfNeeded(taskId: TaskId, eventType: 'completed' | 'failed' | 'escalated' | 'session_ended' | 'session_stalled'): void {
    if (!this.leadManager) return;

    const task = this.dag.getTask(taskId);
    if (!task) return;

    switch (eventType) {
      case 'completed': {
        const allTasks = this.dag.listTasks();
        const dependents = allTasks.filter(t =>
          t.dependsOn.includes(taskId) &&
          (t.state === 'pending' || t.state === 'ready' || t.state === 'blocked')
        );

        if (dependents.length > 0 && task.specId) {
          const specTasks = allTasks.filter(t => t.specId === task.specId);
          const remaining = specTasks.filter(t => t.state !== 'done' && t.state !== 'skipped' && t.state !== 'cancelled');

          this.leadManager.steerDirectorEvent({
            type: 'critical_task_completed',
            taskId: taskId as string,
            specId: task.specId as string,
            title: task.title,
            remainingInSpec: remaining.length,
          });
        }

        if (task.specId) {
          this.checkSpecMilestone(task.specId as string);
        }
        break;
      }
      case 'failed': {
        this.leadManager.steerDirectorEvent({
          type: 'task_failed',
          taskId: taskId as string,
          error: `Task "${task.title}" failed`,
          retriesLeft: (this.governanceConfig.maxRetries ?? 3) - (this.retryCount.get(taskId) ?? 0),
        });
        break;
      }
      case 'escalated': {
        this.leadManager.steerDirectorEvent({
          type: 'worker_escalation',
          taskId: taskId as string,
          agentId: (task.assignedAgent as string) ?? 'unknown',
          reason: 'Worker escalated',
        });
        break;
      }
      case 'session_ended': {
        this.leadManager.steerDirectorEvent({
          type: 'agent_session_ended',
          taskId: taskId as string,
          agentId: (task.assignedAgent as string) ?? 'unknown',
          title: task.title,
          message: `Agent session ended without submitting task "${task.title}". Decide: resume the agent, reassign to another worker, or fail the task.`,
        });
        break;
      }
      case 'session_stalled': {
        this.leadManager.steerDirectorEvent({
          type: 'session_stalled',
          taskId: taskId as string,
          agentId: (task.assignedAgent as string) ?? 'unknown',
          title: task.title,
        });
        break;
      }
    }
  }

  private checkSpecMilestone(specId: string): void {
    if (!this.leadManager) return;
    const allTasks = this.dag.listTasks().filter(t => t.specId === specId);
    const total = allTasks.length;
    if (total === 0) return;

    const completed = allTasks.filter(t => t.state === 'done' || t.state === 'skipped' || t.state === 'cancelled').length;
    const pct = Math.floor((completed / total) * 100);

    const milestones = [50, 75];
    const sent = this.specMilestonesSent.get(specId) ?? new Set();

    for (const m of milestones) {
      if (pct >= m && !sent.has(m)) {
        sent.add(m);
        this.specMilestonesSent.set(specId, sent);
        this.leadManager.steerDirectorEvent({
          type: 'spec_milestone',
          specId,
          completed,
          total,
        });
      }
    }

    // Prune milestone tracking for completed specs
    if (pct === 100) {
      this.specMilestonesSent.delete(specId);
    }
  }
}

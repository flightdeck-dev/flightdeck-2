import type { TaskId, SideEffect, ProjectConfig, AgentId } from '@flightdeck-ai/shared';
import { type TaskDAG } from '../dag/TaskDAG.js';
import { type SqliteStore } from '../storage/SqliteStore.js';
import { type GovernanceEngine } from '../governance/GovernanceEngine.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';
import { SuggestionStore } from '../storage/SuggestionStore.js';
import type { WorkflowEngine, StepAction } from '../workflow/WorkflowEngine.js';
import type { AgentManager } from '../agents/AgentManager.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { MessageStore } from '../comms/MessageStore.js';
import type { WebSocketServer } from '../api/WebSocketServer.js';
import type { SessionManager } from '../agents/SessionManager.js';
import type { DecisionLog } from '../storage/DecisionLog.js';
import { StatusFileWriter, type StatusData } from '../status/StatusFileWriter.js';
import { TaskContextWriter } from '../status/TaskContextWriter.js';
import { SpecChangeDetector, type SpecChange } from '../specs/SpecChangeDetector.js';
import { WebhookNotifier, type NotificationsConfig, taskCompletedEvent, taskFailedEvent, specCompletedEvent, escalationEvent, agentStallEvent, budgetWarningEvent } from '../integrations/WebhookNotifier.js';
import type { SpecStore } from '../storage/SpecStore.js';
import { processReview } from '../verification/ReviewFlow.js';

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
  private adapter: AgentAdapter;
  private agentManager: AgentManager | null;
  private leadManager: LeadManager | null;
  private messageStore: MessageStore | null;
  private wsServer: WebSocketServer | null;
  private governanceConfig: GovernanceConfig;
  private sessionManager: SessionManager | null;
  private retryCount = new Map<TaskId, number>();
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
    this.statusWriter = new StatusFileWriter();
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
    switch (effect.type) {
      case 'spawn_reviewer': {
        if (!this.adapter) break;
        const task = this.dag.getTask(effect.taskId);
        if (!task) break;
        // Use ReviewFlow.processReview which handles:
        // - Spawning reviewer agent with the review prompt
        // - Waiting for its verdict
        // - Transitioning task state (done/failed/running)
        processReview(effect.taskId, this.store, this.adapter, {
          cwd: this.config.cwd ?? process.cwd(),
          projectName: this.config.name,
          agentManager: this.agentManager ?? undefined,
        }).then(result => {
          if (result.passed) {
            this.webhookNotifier?.notify(
              taskCompletedEvent(this.config.name, task.title, (task.assignedAgent as string) ?? 'unknown'),
            );
            // Notify Planner if this was a critical-path completion
            this.notifyPlannerIfNeeded(effect.taskId, 'completed');
          } else {
            // Notify lead about review failure
            this.leadManager?.steerLead({
              type: 'task_failure',
              taskId: effect.taskId as string,
              error: `Review failed: ${result.feedback}`,
            });
          }
          this.broadcastStateChange();
        }).catch((err: unknown) => {
          console.error(`[${this.config.name}] Review spawn failed for task ${effect.taskId}:`, err instanceof Error ? err.message : String(err));
          // Leave in in_review for retry; notify Lead
          this.leadManager?.steerLead({
            type: 'task_failure',
            taskId: effect.taskId as string,
            error: `Review process failed: ${err instanceof Error ? err.message : String(err)}`,
          }).catch(() => {});
        });
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
        // Also notify Planner about escalations
        this.notifyPlannerIfNeeded(effect.taskId, 'escalated');
        break;
      }
      case 'notify_agent': {
        if (!this.messageStore) break;
        this.messageStore.createMessage({
          authorType: 'system',
          authorId: 'orchestrator',
          content: effect.message,
          taskId: null,
          threadId: null,
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

    // 2. Spawn reviewers for in_review tasks that don't have one yet.
    //    The spawn_reviewer effect fires from TaskDAG.processEffects, but
    //    MCP server runs a separate Flightdeck instance (no effectHandler).
    //    So we catch in_review tasks here as a reliable fallback.
    await this.spawnMissingReviewers();

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
  // processCompletions removed: reviews are always handled by ReviewFlow

  /**
   * Spawn reviewers for in_review tasks that don't have an active review.
   * The spawn_reviewer effect fires inside TaskDAG, but the MCP server runs
   * a separate Flightdeck instance without the effectHandler. So we poll
   * for in_review tasks here as a reliable catch-all.
   */
  private reviewInProgress = new Set<string>();
  private async spawnMissingReviewers(): Promise<void> {
    if (!this.adapter) return;
    const inReviewTasks = this.dag.listTasks().filter(t => t.state === 'in_review');
    for (const task of inReviewTasks) {
      if (this.reviewInProgress.has(task.id)) continue; // Already has a reviewer
      this.reviewInProgress.add(task.id);
      processReview(task.id, this.store, this.adapter, {
        cwd: this.config.cwd ?? process.cwd(),
        projectName: this.config.name,
        agentManager: this.agentManager ?? undefined,
      }).then(result => {
        this.reviewInProgress.delete(task.id);
        if (result.passed) {
          this.webhookNotifier?.notify(
            taskCompletedEvent(this.config.name, task.title, (task.assignedAgent as string) ?? 'unknown'),
          );
          this.notifyPlannerIfNeeded(task.id, 'completed');
        } else {
          this.leadManager?.steerLead({
            type: 'task_failure',
            taskId: task.id as string,
            error: `Review failed: ${result.feedback}`,
          });
        }
        this.broadcastStateChange();
      }).catch((err: unknown) => {
        this.reviewInProgress.delete(task.id);
        console.error(`[${this.config.name}] Review failed for ${task.id}:`, err instanceof Error ? err.message : String(err));
      });
    }
  }
  // via spawn_reviewer effect. No auto-approve in tick.

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
          // Active session — check if running too long without progress
          const runningMinutes = (Date.now() - new Date(task.updatedAt).getTime()) / 60_000;
          if (runningMinutes > (this.governanceConfig.stallTimeoutMinutes ?? 10)) {
            // Running too long — send a reminder to submit
            await this.adapter.steer(task.acpSessionId, {
              content: `[${new Date().toISOString().slice(0, 19)}Z] [SYSTEM] Task "${task.title}" (${task.id}) has been running for ${Math.round(runningMinutes)} minutes. If you've completed the work, please call flightdeck_task_submit now. If blocked, call flightdeck_escalate.`,
            });
            detected++;
          }
          continue;
        }

        if (meta.status === 'idle') {
          // Idle session, task not submitted — light ping
          await this.adapter.steer(task.acpSessionId, {
            content: `[${new Date().toISOString().slice(0, 19)}Z] [SYSTEM] Stall check: task "${task.title}" (${task.id}) is still assigned to you. Submit progress or escalate if blocked.`,
          });
          detected++;
        }

        if (meta.status === 'ended') {
          // Session ended without submit — definite stall
          await this.adapter.kill(task.acpSessionId);

          const maxRetries = this.governanceConfig.maxRetries ?? 3;
          const retries = this.retryCount.get(task.id) ?? 0;

          this.dag.failTask(task.id);

          if (retries < maxRetries) {
            // Retry: reset to ready for re-assignment
            this.dag.retryTask(task.id);
            this.retryCount.set(task.id, retries + 1);
          } else {
            // Max retries exhausted — notify Lead
            this.leadManager?.steerLead({
              type: 'task_failure',
              taskId: task.id,
              error: `Task failed after ${maxRetries} retries. Agent session ended without submission.`,
            });
            // Also notify Planner about exhausted failures
            this.notifyPlannerIfNeeded(task.id, 'failed');
            this.webhookNotifier?.notify(
              taskFailedEvent(this.config.name, task.title, `Failed after ${maxRetries} retries`),
            );
          }

          this.store.updateAgentStatus(task.assignedAgent, 'offline');
          this.webhookNotifier?.notify(
            agentStallEvent(this.config.name, task.assignedAgent as string, task.title),
          );
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
              this.store.updateAgentStatus(staleTask.assignedAgent, 'offline');
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
    const usedAgentIds = new Set<string>();
    let assigned = 0;
    const maxWorkers = this.config.maxConcurrentWorkers ?? 30;

    for (const task of readyTasks) {
      // Check governance gate
      if (this.governance.shouldGateTaskStart(task.state, task.role)) {
        try {
          this.dag.gateTask(task.id);
        } catch { /* may not be valid transition */ }
        continue;
      }

      const agent = agents.find(a => a.role === task.role && !usedAgentIds.has(a.id));
      if (agent) {
        // Assign to idle agent
        try {
          this.dag.claimTask(task.id, agent.id);
          this.store.updateAgentStatus(agent.id, 'busy');
          usedAgentIds.add(agent.id);
          assigned++;

          if (this.agentManager && agent.acpSessionId) {
            const ts = new Date().toISOString().slice(0, 19) + 'Z';
            void this.agentManager.sendToAgent(agent.id as AgentId,
              `[${ts}] [SYSTEM] Task assigned: "${task.title}" (ID: ${task.id})${task.description ? '\n\nDescription: ' + task.description : ''}\n\nSubmit results with flightdeck_task_submit. If blocked, use flightdeck_escalate.`
            ).catch(() => { /* best effort */ });
          }
        } catch { /* Skip */ }
      } else if (this.agentManager) {
        // No idle agent — auto-spawn if under cap
        const activeWorkers = this.store.listAgents().filter(
          a => (a.status === 'busy' || a.status === 'idle') && a.role === task.role
        ).length;
        if (activeWorkers < maxWorkers) {
          void this.agentManager.spawnAgent({
            role: task.role as any,
            cwd: this.config.cwd ?? process.cwd(),
            projectName: this.config.name,
            taskContext: `Task assigned: "${task.title}" (ID: ${task.id})${task.description ? '\n\nDescription: ' + task.description : ''}\n\nSubmit results with flightdeck_task_submit. If blocked, use flightdeck_escalate.`,
          }).then(agent => {
            try {
              this.dag.claimTask(task.id, agent.id);
            } catch { /* task may have been claimed by another path */ }
          }).catch(err => {
            console.error(`[${this.config.name}] Auto-spawn failed for ${task.role}:`, err instanceof Error ? err.message : String(err));
          });
          assigned++; // Optimistic — spawn is async
        }
      }
    }

    return assigned;
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
        threadId: null,
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
   * Write .flightdeck/status.md and per-task context files to the project cwd.
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

      // Write per-task context files for tasks that changed recently
      TaskContextWriter.writeAll(cwd, tasks, agents);
    } catch {
      // Status file writing is best-effort — don't crash the orchestrator
    }
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalHandle) return;
    // Recover orphaned running tasks from previous daemon session
    this.recoverOrphanedTasks();
    this.intervalHandle = setInterval(() => { void this.tick(); }, intervalMs);

    // Subscribe to task state changes for event-driven reactivity
    this.boundReactHandler = () => this.scheduleReactiveTick();
    this.store.on('task-state-changed', this.boundReactHandler);
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
          const newStatus = agentRecord?.acpSessionId ? 'hibernated' : 'offline';
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
          const newStatus = agent.acpSessionId ? 'hibernated' : 'offline';
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
      void this.reactiveTick();
    }, Orchestrator.REACT_DEBOUNCE_MS);
  }

  /**
   * Lightweight tick triggered by state change events.
   * Only promotes blocked/pending → ready and assigns ready tasks to idle agents.
   */
  private async reactiveTick(): Promise<void> {
    if (this._paused) return;
    let stateChanged = false;

    const promoted = this.promoteReadyTasks();
    if (promoted > 0) stateChanged = true;

    await this.spawnMissingReviewers();

    const assigned = this.autoAssignReadyTasks();
    if (assigned > 0) stateChanged = true;

    if (stateChanged) {
      this.broadcastStateChange();
      this.writeStatusFiles();
    }
  }

  /* ── Reactive Planner notifications ─────────────────────────── */

  private specMilestonesSent = new Map<string, Set<number>>();

  private notifyPlannerIfNeeded(taskId: TaskId, eventType: 'completed' | 'failed' | 'escalated'): void {
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

          this.leadManager.steerPlannerEvent({
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
        this.leadManager.steerPlannerEvent({
          type: 'task_failed',
          taskId: taskId as string,
          error: `Task "${task.title}" failed`,
          retriesLeft: (this.governanceConfig.maxRetries ?? 3) - (this.retryCount.get(taskId) ?? 0),
        });
        break;
      }
      case 'escalated': {
        this.leadManager.steerPlannerEvent({
          type: 'worker_escalation',
          taskId: taskId as string,
          agentId: (task.assignedAgent as string) ?? 'unknown',
          reason: 'Worker escalated',
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
        this.leadManager.steerPlannerEvent({
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

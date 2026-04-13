import type { TaskId, SideEffect, ProjectConfig } from '@flightdeck-ai/shared';
import { type TaskDAG } from '../dag/TaskDAG.js';
import { type SqliteStore } from '../storage/SqliteStore.js';
import { type GovernanceEngine } from '../governance/GovernanceEngine.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';
import type { WorkflowEngine, StepAction } from '../workflow/WorkflowEngine.js';
import type { AgentManager } from '../agents/AgentManager.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { MessageStore } from '../comms/MessageStore.js';
import type { WebSocketServer } from '../api/WebSocketServer.js';
import type { SessionManager } from '../agents/SessionManager.js';
import type { DecisionLog } from '../storage/DecisionLog.js';
import { StatusFileWriter, type StatusData } from '../status/StatusFileWriter.js';
import { TaskContextWriter } from '../status/TaskContextWriter.js';

export interface GovernanceConfig {
  costThresholdPerDay?: number;
  maxRetries?: number;
  /** Hours after completion before a task gets compacted. Default: 24 */
  compactionTtlHours?: number;
}

export interface TickResult {
  readyTasksAssigned: number;
  stallsDetected: number;
  completionsProcessed: number;
  errorsHandled: number;
  tasksCompacted: number;
  retrospectivesTriggered: number;
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
        if (!this.agentManager) break;
        const task = this.dag.getTask(effect.taskId);
        if (!task) break;
        this.agentManager.spawnAgent({
          role: 'reviewer',
          taskId: effect.taskId as string,
          cwd: process.cwd(),
        }).catch(() => {
          // If reviewer spawn fails, Lead can retry
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

  async tick(): Promise<TickResult> {
    const result: TickResult = {
      readyTasksAssigned: 0,
      stallsDetected: 0,
      completionsProcessed: 0,
      errorsHandled: 0,
      tasksCompacted: 0,
      retrospectivesTriggered: 0,
    };

    // When paused, skip the entire tick — let in-progress tasks finish naturally
    // but don't promote, assign, or process anything new.
    if (this._paused) return result;

    let stateChanged = false;

    // 1. Promote ready tasks — pending tasks whose deps are all done
    const promoted = this.promoteReadyTasks();
    if (promoted > 0) stateChanged = true;

    // 2. Process completions — tasks in in_review that passed → done
    const completions = this.processCompletions();
    result.completionsProcessed = completions;
    if (completions > 0) stateChanged = true;

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
   * Promote pending tasks to ready when all dependencies are done.
   */
  private promoteReadyTasks(): number {
    const allTasks = this.dag.listTasks();
    let promoted = 0;

    for (const task of allTasks) {
      if (task.state !== 'pending') continue;

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
  private processCompletions(): number {
    const verificationEnabled = this.governance.governanceConfig.verification.enabled;
    if (verificationEnabled) {
      // Reviewer agents handle completion directly via MCP tools
      return 0;
    }

    // Auto-approve: verification disabled, complete all in_review tasks
    const allTasks = this.dag.listTasks();
    let completed = 0;

    for (const task of allTasks) {
      if (task.state !== 'in_review') continue;
      try {
        this.dag.completeTask(task.id);
        completed++;

        // If workflow engine is present, advance the pipeline
        // (e.g., trigger post-review steps like deploy, notify, etc.)
        if (this.workflowEngine) {
          const action = this.workflowEngine.advanceTask(task.id);
          this.handleWorkflowAction(task.id, action);
        }
      } catch {
        // Task may have already transitioned
      }
    }

    return completed;
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
          // Active session — do not disturb
          continue;
        }

        if (meta.status === 'idle') {
          // Idle session, task not submitted — light ping
          await this.adapter.steer(task.acpSessionId, {
            content: `Task ${task.id} ("${task.title}") is still assigned to you. Please submit progress or report if you're blocked.`,
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
          }

          this.store.updateAgentStatus(task.assignedAgent, 'offline');
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
    let assigned = 0;

    for (const task of readyTasks) {
      const agent = agents.find(a => a.role === task.role && a.status === 'idle');
      if (!agent) continue;

      // Check governance gate
      if (this.governance.shouldGateTaskStart(task.state, task.role)) {
        try {
          this.dag.gateTask(task.id);
        } catch { /* may not be valid transition */ }
        continue;
      }

      try {
        this.dag.claimTask(task.id, agent.id);
        this.store.updateAgentStatus(agent.id, 'busy');
        assigned++;
      } catch {
        // Skip
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
    }
  }

  /**
   * Check if all tasks in any spec are complete → notify Lead + trigger retrospective.
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
        // All tasks done — notify Lead (only once)
        if (!this.retrospectivesDone.has(specId)) {
          this.leadManager?.steerLead({
            type: 'spec_completed',
            specId,
            summary: `All ${counts.total} tasks complete.`,
          });
          this.leadManager?.recordTaskCompletion();
          this.retrospectivesDone.set(specId, Date.now());
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
    this.wsServer.broadcast({
      type: 'chat:message',
      message: {
        id: `system-${Date.now()}`,
        threadId: null,
        parentId: null,
        taskId: null,
        authorType: 'system',
        authorId: null,
        content: `[state update] ${JSON.stringify(stats)}`,
        metadata: JSON.stringify({ stats }),
        createdAt: new Date().toISOString(),
        updatedAt: null,
      },
    });
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
    this.intervalHandle = setInterval(() => { void this.tick(); }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}

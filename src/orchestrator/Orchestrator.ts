import type { TaskId, AgentId, ProjectConfig } from '../core/types.js';
import { TaskDAG } from '../dag/TaskDAG.js';
import { SqliteStore } from '../storage/SqliteStore.js';
import { GovernanceEngine } from '../governance/GovernanceEngine.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';

export interface TickResult {
  assignedTasks: TaskId[];
  pingedAgents: AgentId[];    // idle session, no submit — light ping sent
  restartedAgents: AgentId[]; // ended session, no submit — killed + re-spawned
  errors: string[];
}

/**
 * The orchestrator runs a periodic tick loop that:
 * 1. For each running task, checks agent ACP session state
 *    - active → skip (do not disturb)
 *    - idle + no submit → light ping via ACP steer
 *    - ended + no submit → kill + re-spawn on same task
 * 2. Finds ready tasks with no assigned agent → auto-assign
 *
 * NO time-based stall thresholds. An agent can run for hours
 * as long as its ACP session is active.
 */
export class Orchestrator {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private dag: TaskDAG,
    private store: SqliteStore,
    private governance: GovernanceEngine,
    private adapter: AgentAdapter,
    private config: ProjectConfig,
  ) {}

  async tick(): Promise<TickResult> {
    const result: TickResult = { assignedTasks: [], pingedAgents: [], restartedAgents: [], errors: [] };

    // 1. Check ACP session state for all running tasks
    const runningTasks = this.dag.listTasks().filter(t => t.state === 'running');
    for (const task of runningTasks) {
      if (!task.assignedAgent || !task.acpSessionId) continue;

      try {
        const meta = await this.adapter.getMetadata(task.acpSessionId);
        if (!meta) continue; // can't check, skip

        if (meta.status === 'running') {
          // Active session — do not disturb
          continue;
        }

        if (meta.status === 'idle') {
          // Idle session, task not submitted — light ping
          await this.adapter.steer(task.acpSessionId, {
            content: `Task ${task.id} ("${task.title}") is still assigned to you. Please submit progress or report if you're blocked.`,
          });
          result.pingedAgents.push(task.assignedAgent);
        }

        if (meta.status === 'ended') {
          // Session ended without submit — definite stall
          // Kill (cleanup) and re-spawn on same task
          await this.adapter.kill(task.acpSessionId);

          // Use state machine: running → failed, then failed → ready
          this.dag.failTask(task.id);
          // Reset to ready for re-assignment via state machine
          this.dag.retryTask(task.id);
          this.store.updateAgentStatus(task.assignedAgent, 'offline');
          result.restartedAgents.push(task.assignedAgent);
        }
      } catch (err) {
        result.errors.push(`Session check failed for ${task.id}: ${(err as Error).message}`);
      }
    }

    // 2. Find ready, unassigned tasks
    const readyTasks = this.dag.getReadyTasks().filter(t => !t.assignedAgent);

    // 3. Find idle agents
    const agents = this.store.listAgents().filter(a => a.status === 'idle');

    // 4. Match tasks to agents by role
    for (const task of readyTasks) {
      const agent = agents.find(a => a.role === task.role && a.status === 'idle');
      if (!agent) continue;

      // Check governance gate
      if (this.governance.shouldGateTaskStart(task.state, task.role)) {
        this.dag.gateTask(task.id);
        continue;
      }

      try {
        this.dag.claimTask(task.id, agent.id);
        this.store.updateAgentStatus(agent.id, 'busy');
        result.assignedTasks.push(task.id);
      } catch (err) {
        result.errors.push(`Failed to assign ${task.id}: ${(err as Error).message}`);
      }
    }

    return result;
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

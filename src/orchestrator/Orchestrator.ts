import type { TaskId, AgentId, ProjectConfig } from '../core/types.js';
import { TaskDAG } from '../dag/TaskDAG.js';
import { SqliteStore } from '../storage/SqliteStore.js';
import { GovernanceEngine } from '../governance/GovernanceEngine.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';

export interface TickResult {
  assignedTasks: TaskId[];
  stalledAgents: AgentId[];
  errors: string[];
}

/**
 * The orchestrator runs a periodic tick loop that:
 * 1. Finds ready tasks and assigns them to available agents
 * 2. Detects stalled agents (silence timeout, task overtime)
 * 3. Promotes pending tasks whose dependencies are met
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
    const result: TickResult = { assignedTasks: [], stalledAgents: [], errors: [] };

    // 1. Find ready, unassigned tasks
    const readyTasks = this.dag.getReadyTasks().filter(t => !t.assignedAgent);

    // 2. Find idle agents
    const agents = this.store.listAgents().filter(a => a.status === 'idle');

    // 3. Match tasks to agents by role
    for (const task of readyTasks) {
      const agent = agents.find(a => a.role === task.role && a.status === 'idle');
      if (!agent) continue;

      // Check governance gate
      if (this.governance.shouldGateTaskStart(task.state)) {
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

    // 4. Detect stalled agents
    const stallTimeout = (this.config.stallDetection?.agentSilenceTimeoutMin ?? 30) * 60 * 1000;
    const now = Date.now();
    for (const agent of this.store.listAgents()) {
      if (agent.status !== 'busy' || !agent.lastHeartbeat) continue;
      const lastBeat = new Date(agent.lastHeartbeat).getTime();
      if (now - lastBeat > stallTimeout) {
        result.stalledAgents.push(agent.id);
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

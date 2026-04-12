import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Task, TaskId, AgentId, SpecId, Agent, ProjectConfig, Decision, Message } from '@flightdeck-ai/shared';
import type { AgentRole } from '@flightdeck-ai/shared';
import { ProjectStore } from './storage/ProjectStore.js';
import { SqliteStore } from './storage/SqliteStore.js';
import { SpecStore, type SpecFile } from './storage/SpecStore.js';
import { DecisionLog } from './storage/DecisionLog.js';
import { MemoryStore } from './storage/MemoryStore.js';
import { MessageLog } from './storage/MessageLog.js';
import { ReportStore } from './storage/ReportStore.js';
import { TaskDAG } from './dag/TaskDAG.js';
import { GovernanceEngine } from './governance/GovernanceEngine.js';
import { Orchestrator } from './orchestrator/Orchestrator.js';
import { AcpAdapter } from './agents/AcpAdapter.js';
import { WorkflowStore, type WorkflowConfig } from './storage/WorkflowStore.js';
import { WorkflowEngine, type StepAction } from './workflow/WorkflowEngine.js';
import { RoleRegistry } from './roles/RoleRegistry.js';
import { LearningsStore, type LearningCategory } from './storage/LearningsStore.js';
import { TimerManager, type TimerCallback } from './orchestrator/TimerManager.js';
import { AgentManager } from './agents/AgentManager.js';
import { MessageStore } from './comms/MessageStore.js';

/**
 * High-level facade wrapping all Flightdeck subsystems.
 * One Facade instance per project.
 */
export class Flightdeck {
  readonly project: ProjectStore;
  readonly sqlite: SqliteStore;
  readonly specs: SpecStore;
  readonly decisions: DecisionLog;
  readonly memory: MemoryStore;
  readonly messages: MessageLog;
  readonly reports: ReportStore;
  readonly dag: TaskDAG;
  readonly governance: GovernanceEngine;
  readonly orchestrator: Orchestrator;
  readonly workflowStore: WorkflowStore;
  readonly workflow: WorkflowEngine;
  readonly roles: RoleRegistry;
  readonly learnings: LearningsStore;
  readonly timers: TimerManager;
  readonly agentManager: AgentManager;
  readonly chatMessages: MessageStore | null;

  constructor(projectName: string) {
    this.project = new ProjectStore(projectName);
    if (!this.project.exists()) {
      this.project.init(projectName);
    }
    this.project.ensureDirs();

    this.sqlite = new SqliteStore(this.project.subpath('state.sqlite'));
    this.specs = new SpecStore(this.project.subpath('specs'));
    this.decisions = new DecisionLog(this.project.subpath('decisions'));
    this.memory = new MemoryStore(this.project.subpath('memory'), this.project.subpath('state.sqlite'));
    this.messages = new MessageLog(this.project.subpath('messages'));
    this.reports = new ReportStore(this.project.subpath('reports'));
    this.dag = new TaskDAG(this.sqlite);
    const config = this.project.getConfig();
    this.governance = new GovernanceEngine(config);
    this.orchestrator = new Orchestrator(this.dag, this.sqlite, this.governance, new AcpAdapter(), config);
    this.workflowStore = new WorkflowStore(this.project.subpath('.'));
    this.workflow = new WorkflowEngine(this.workflowStore.load());
    this.roles = new RoleRegistry(projectName);
    this.learnings = new LearningsStore(this.project.subpath('.'));
    this.timers = new TimerManager((_agentId, _message) => {
      // Default callback — messages can be wired to agent queues later
    });
    const acpAdapter = new AcpAdapter();
    this.agentManager = new AgentManager(acpAdapter, this.sqlite, this.roles, projectName);

    // Initialize chat MessageStore (SQLite-backed)
    try {
      this.chatMessages = new MessageStore(this.sqlite.db);
    } catch {
      this.chatMessages = null;
    }
  }

  // ── Task operations ──

  addTask(opts: { title: string; description?: string; specId?: SpecId; role?: AgentRole; dependsOn?: TaskId[]; priority?: number }): Task {
    return this.dag.addTask(opts);
  }

  claimTask(taskId: TaskId, agentId: AgentId): Task {
    return this.dag.claimTask(taskId, agentId);
  }

  submitTask(taskId: TaskId, claim?: string): Task {
    return this.dag.submitTask(taskId, claim);
  }

  completeTask(taskId: TaskId): Task {
    return this.dag.completeTask(taskId);
  }

  failTask(taskId: TaskId): Task {
    return this.dag.failTask(taskId);
  }

  cancelTask(taskId: TaskId): Task {
    return this.dag.cancelTask(taskId);
  }

  pauseTask(taskId: TaskId): Task {
    return this.dag.pauseTask(taskId);
  }

  resumeTask(taskId: TaskId): Task {
    return this.dag.resumeTask(taskId);
  }

  skipTask(taskId: TaskId): Task {
    return this.dag.skipTask(taskId);
  }

  reopenTask(taskId: TaskId): Task {
    return this.dag.reopenTask(taskId);
  }

  retryTask(taskId: TaskId): Task {
    return this.dag.retryTask(taskId);
  }

  declareTasks(tasks: Parameters<TaskDAG['declareTasks']>[0]): Task[] {
    return this.dag.declareTasks(tasks);
  }

  listTasks(specId?: SpecId): Task[] {
    return this.dag.listTasks(specId);
  }

  getTaskStats(): Record<string, number> {
    return this.dag.getStats();
  }

  // ── Spec operations ──

  listSpecs(): SpecFile[] {
    return this.specs.list();
  }

  createSpec(title: string, content: string): SpecFile {
    const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md';
    return this.specs.write(filename, `# ${title}\n\n${content}`);
  }

  // ── Agent operations ──

  registerAgent(agent: Agent): void {
    this.sqlite.insertAgent(agent);
  }

  listAgents(): Agent[] {
    return this.sqlite.listAgents();
  }

  // ── Communication ──

  sendMessage(message: Message, channel?: string): void {
    if (channel) {
      this.messages.append(message, channel);
    } else {
      this.messages.append(message, 'dm');
    }
  }

  readMessages(channel: string, since?: string): Message[] {
    return this.messages.read(channel, since);
  }

  // ── Memory ──

  searchMemory(query: string, limit?: number) {
    return this.memory.search(query, limit);
  }

  writeMemory(filename: string, content: string): void {
    this.memory.write(filename, content);
  }

  // ── Status ──

  status(): { config: ProjectConfig; taskStats: Record<string, number>; agentCount: number; totalCost: number } {
    return {
      config: this.project.getConfig(),
      taskStats: this.getTaskStats(),
      agentCount: this.listAgents().length,
      totalCost: this.sqlite.getTotalCost(),
    };
  }

  // ── Workflow ──

  advanceTask(taskId: TaskId): StepAction {
    return this.workflow.advanceTask(taskId);
  }

  getWorkflow(): WorkflowConfig {
    return this.workflow.getConfig();
  }

  setWorkflow(config: WorkflowConfig): void {
    this.workflow.setConfig(config);
    this.workflowStore.save(config);
  }

  // ── Lifecycle ──

  close(): void {
    this.orchestrator.stop();
    this.timers.clearAll();
    this.sqlite.close();
  }
}

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Task, TaskId, AgentId, SpecId, Agent, ProjectConfig, Decision, Message } from './core/types.js';
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
import type { AgentRole } from './core/types.js';
import { WorkflowStore, type WorkflowConfig } from './storage/WorkflowStore.js';
import { WorkflowEngine, type StepAction } from './workflow/WorkflowEngine.js';

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

  constructor(projectName: string) {
    this.project = new ProjectStore(projectName);
    if (!this.project.exists()) {
      this.project.init(projectName);
    }
    this.project.ensureDirs();

    this.sqlite = new SqliteStore(this.project.subpath('state.sqlite'));
    this.specs = new SpecStore(this.project.subpath('specs'));
    this.decisions = new DecisionLog(this.project.subpath('decisions'));
    this.memory = new MemoryStore(this.project.subpath('memory'));
    this.messages = new MessageLog(this.project.subpath('messages'));
    this.reports = new ReportStore(this.project.subpath('reports'));
    this.dag = new TaskDAG(this.sqlite);
    const config = this.project.getConfig();
    this.governance = new GovernanceEngine(config);
    this.orchestrator = new Orchestrator(this.dag, this.sqlite, this.governance, new AcpAdapter(), config);
    this.workflowStore = new WorkflowStore(this.project.subpath('.'));
    this.workflow = new WorkflowEngine(this.workflowStore.load());
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

  searchMemory(query: string) {
    return this.memory.search(query);
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
    this.sqlite.close();
  }
}

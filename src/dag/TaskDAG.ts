import type { Task, TaskId, TaskState, AgentId, SpecId, AgentRole, SideEffect } from '../core/types.js';
import { transition } from '../core/types.js';
import { taskId } from '../core/ids.js';
import { SqliteStore } from '../storage/SqliteStore.js';

export class TaskDAG {
  private adjacency = new Map<TaskId, Set<TaskId>>(); // parent -> children (dependents)
  private reverseAdj = new Map<TaskId, Set<TaskId>>(); // child -> parents (dependencies)

  constructor(private store: SqliteStore) {
    this.rebuild();
  }

  private rebuild(): void {
    this.adjacency.clear();
    this.reverseAdj.clear();
    const tasks = this.store.listTasks();
    for (const task of tasks) {
      if (!this.adjacency.has(task.id)) this.adjacency.set(task.id, new Set());
      if (!this.reverseAdj.has(task.id)) this.reverseAdj.set(task.id, new Set());
      for (const dep of task.dependsOn) {
        // dep -> task (task depends on dep)
        if (!this.adjacency.has(dep)) this.adjacency.set(dep, new Set());
        this.adjacency.get(dep)!.add(task.id);
        this.reverseAdj.get(task.id)!.add(dep);
      }
    }
  }

  addTask(opts: {
    title: string;
    description?: string;
    specId?: SpecId;
    role?: AgentRole;
    dependsOn?: TaskId[];
    priority?: number;
  }): Task {
    const now = new Date().toISOString();
    const deps = opts.dependsOn ?? [];
    const id = taskId(opts.title, now);
    const task: Task = {
      id,
      specId: opts.specId ?? null,
      title: opts.title,
      description: opts.description ?? '',
      state: deps.length === 0 ? 'ready' : 'pending',
      role: opts.role ?? 'worker',
      dependsOn: deps,
      priority: opts.priority ?? 0,
      assignedAgent: null,
      acpSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertTask(task);

    // Update adjacency
    this.adjacency.set(id, new Set());
    this.reverseAdj.set(id, new Set());
    for (const dep of deps) {
      if (!this.adjacency.has(dep)) this.adjacency.set(dep, new Set());
      this.adjacency.get(dep)!.add(id);
      this.reverseAdj.get(id)!.add(dep);
    }

    return task;
  }

  claimTask(taskId: TaskId, agentId: AgentId): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.state !== 'ready') throw new Error(`Task ${taskId} is not ready (state: ${task.state})`);
    const result = transition(task.state, 'running', { taskId, agentId });
    this.store.updateTaskState(taskId, 'running', agentId);
    this.processEffects(result.effects);
    return { ...task, state: 'running', assignedAgent: agentId };
  }

  submitTask(taskId: TaskId, claim?: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.state !== 'running') throw new Error(`Task ${taskId} is not running (state: ${task.state})`);
    const result = transition(task.state, 'in_review', { taskId });
    this.store.updateTaskState(taskId, 'in_review');
    if (claim) {
      this.store.updateTaskClaim(taskId, claim);
    }
    this.processEffects(result.effects);
    return { ...task, state: 'in_review' };
  }

  completeTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'done', { taskId: id });
    this.store.updateTaskState(id, 'done');
    this.processEffects(result.effects);
    return { ...task, state: 'done' };
  }

  failTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'failed', { taskId: id });
    this.store.updateTaskState(id, 'failed');
    this.processEffects(result.effects);
    return { ...task, state: 'failed' };
  }

  retryTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'ready', { taskId: id });
    this.store.updateTaskState(id, 'ready', null);
    this.processEffects(result.effects);
    return { ...task, state: 'ready', assignedAgent: null };
  }

  cancelTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'cancelled', { taskId: id });
    this.store.updateTaskState(id, 'cancelled', null);
    this.processEffects(result.effects);
    return { ...task, state: 'cancelled', assignedAgent: null };
  }

  pauseTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'paused', { taskId: id });
    this.store.updateTaskState(id, 'paused');
    this.processEffects(result.effects);
    return { ...task, state: 'paused' };
  }

  skipTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'skipped', { taskId: id });
    this.store.updateTaskState(id, 'skipped');
    this.processEffects(result.effects);
    return { ...task, state: 'skipped' };
  }

  reopenTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'ready', { taskId: id });
    this.store.updateTaskState(id, 'ready', null);
    this.processEffects(result.effects);
    return { ...task, state: 'ready', assignedAgent: null };
  }

  declareTasks(tasks: Array<{
    title: string;
    description?: string;
    specId?: SpecId;
    role?: AgentRole;
    dependsOn?: string[];
    priority?: number;
  }>): Task[] {
    // First pass: create all tasks, mapping temp keys to real IDs
    const idMap = new Map<string, TaskId>();
    const results: Task[] = [];
    for (const t of tasks) {
      const task = this.addTask({
        title: t.title,
        description: t.description,
        specId: t.specId as SpecId | undefined,
        role: t.role,
        priority: t.priority,
      });
      idMap.set(t.title, task.id);
      results.push(task);
    }
    // Second pass: wire up dependencies
    for (let i = 0; i < tasks.length; i++) {
      const deps = tasks[i].dependsOn;
      if (deps && deps.length > 0) {
        const resolvedDeps = deps.map(d => idMap.get(d) ?? d as TaskId);
        // Update in store
        this.store.updateTaskDependsOn(results[i].id, resolvedDeps);
        results[i] = { ...results[i], dependsOn: resolvedDeps };
        // Check if should be pending
        const allDone = resolvedDeps.every(d => {
          const t = this.store.getTask(d);
          return t?.state === 'done';
        });
        if (!allDone) {
          this.store.updateTaskState(results[i].id, 'pending');
          results[i] = { ...results[i], state: 'pending' };
        }
        // Update adjacency
        for (const dep of resolvedDeps) {
          if (!this.adjacency.has(dep)) this.adjacency.set(dep, new Set());
          this.adjacency.get(dep)!.add(results[i].id);
          if (!this.reverseAdj.has(results[i].id)) this.reverseAdj.set(results[i].id, new Set());
          this.reverseAdj.get(results[i].id)!.add(dep);
        }
      }
    }
    return results;
  }

  gateTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    transition(task.state, 'gated', { taskId: id });
    this.store.updateTaskState(id, 'gated');
    return { ...task, state: 'gated' };
  }

  /** Process side effects emitted by state transitions */
  private processEffects(effects: SideEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'resolve_dependents':
          this.resolveReady(effect.taskId);
          break;
        case 'block_dependents': {
          const dependents = this.adjacency.get(effect.taskId) ?? new Set();
          for (const depId of dependents) {
            const depTask = this.store.getTask(depId);
            if (depTask && depTask.state === 'pending') {
              this.store.updateTaskState(depId, 'blocked');
            }
          }
          break;
        }
        case 'clear_assignment':
          this.store.clearTaskAssignment(effect.taskId);
          break;
        case 'set_timestamp':
          // Timestamps are already updated by updateTaskState
          break;
        case 'spawn_reviewer':
          // For now, no-op — real reviewer spawning comes in Phase 2
          break;
        case 'escalate':
          // For now, no-op — real escalation comes in Phase 2
          break;
        case 'notify_agent':
        case 'update_dag':
        case 'log_decision':
          // No-ops for now
          break;
      }
    }
  }

  /** After a task completes, check if its dependents are now ready */
  resolveReady(completedTaskId: TaskId): TaskId[] {
    const promoted: TaskId[] = [];
    const dependents = this.adjacency.get(completedTaskId) ?? new Set();
    for (const depId of dependents) {
      const depTask = this.store.getTask(depId);
      if (!depTask || depTask.state !== 'pending') continue;
      // Check if ALL dependencies are done or skipped
      const allDone = depTask.dependsOn.every(d => {
        const t = this.store.getTask(d);
        return t?.state === 'done' || t?.state === 'skipped';
      });
      if (allDone) {
        this.store.updateTaskState(depId, 'ready');
        promoted.push(depId);
      }
    }
    return promoted;
  }

  topoSort(): TaskId[] {
    const tasks = this.store.listTasks();
    const inDegree = new Map<TaskId, number>();
    for (const t of tasks) {
      inDegree.set(t.id, t.dependsOn.length);
    }
    const queue: TaskId[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    const sorted: TaskId[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(id);
      for (const dep of this.adjacency.get(id) ?? []) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }
    if (sorted.length !== tasks.length) {
      throw new Error(`Cycle detected in task DAG: sorted ${sorted.length} of ${tasks.length} tasks`);
    }
    return sorted;
  }

  getStats(): Record<string, number> {
    return this.store.getTaskStats();
  }

  getTask(id: TaskId): Task | null {
    return this.store.getTask(id);
  }

  listTasks(specId?: SpecId): Task[] {
    return this.store.listTasks(specId);
  }

  getReadyTasks(): Task[] {
    return this.store.getTasksByState('ready');
  }
}

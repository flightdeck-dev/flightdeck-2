import type { Task, TaskId, TaskState, AgentId, SpecId, AgentRole } from '../core/types.js';
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
    transition(task.state, 'running', { taskId, agentId });
    this.store.updateTaskState(taskId, 'running', agentId);
    return { ...task, state: 'running', assignedAgent: agentId };
  }

  submitTask(taskId: TaskId): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.state !== 'running') throw new Error(`Task ${taskId} is not running (state: ${task.state})`);
    transition(task.state, 'in_review', { taskId });
    this.store.updateTaskState(taskId, 'in_review');
    return { ...task, state: 'in_review' };
  }

  completeTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    transition(task.state, 'done', { taskId: id });
    this.store.updateTaskState(id, 'done');
    // Promote dependents
    this.resolveReady(id);
    return { ...task, state: 'done' };
  }

  failTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    transition(task.state, 'failed', { taskId: id });
    this.store.updateTaskState(id, 'failed');
    return { ...task, state: 'failed' };
  }

  gateTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    transition(task.state, 'gated', { taskId: id });
    this.store.updateTaskState(id, 'gated');
    return { ...task, state: 'gated' };
  }

  /** After a task completes, check if its dependents are now ready */
  resolveReady(completedTaskId: TaskId): TaskId[] {
    const promoted: TaskId[] = [];
    const dependents = this.adjacency.get(completedTaskId) ?? new Set();
    for (const depId of dependents) {
      const depTask = this.store.getTask(depId);
      if (!depTask || depTask.state !== 'pending') continue;
      // Check if ALL dependencies are done
      const allDone = depTask.dependsOn.every(d => {
        const t = this.store.getTask(d);
        return t?.state === 'done';
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

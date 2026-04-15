import type { Task, TaskId, AgentId, SpecId, AgentRole, SideEffect, TaskState } from '@flightdeck-ai/shared';
import { transition } from '@flightdeck-ai/shared';
import { taskId } from '@flightdeck-ai/shared';
import { type SqliteStore } from '../storage/SqliteStore.js';

export type EffectHandler = (effect: SideEffect) => void;

export class TaskDAG {
  private adjacency = new Map<TaskId, Set<TaskId>>(); // parent -> children (dependents)
  private reverseAdj = new Map<TaskId, Set<TaskId>>(); // child -> parents (dependencies)
  private effectHandler: EffectHandler | null = null;

  constructor(private store: SqliteStore) {
    this.rebuild();
  }

  /** Register a handler for effects that TaskDAG can't process internally */
  setEffectHandler(handler: EffectHandler): void {
    this.effectHandler = handler;
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
    source?: Task['source'];
    parentTaskId?: TaskId;
    needsReview?: boolean;
  }): Task {
    const now = new Date().toISOString();
    const deps = opts.dependsOn ?? [];
    const id = taskId(opts.title, now);
    const task: Task = {
      id,
      specId: opts.specId ?? null,
      parentTaskId: opts.parentTaskId ?? null,
      title: opts.title,
      description: opts.description ?? '',
      state: deps.length === 0 ? 'ready' : 'pending',
      role: opts.role ?? 'worker',
      dependsOn: deps,
      priority: opts.priority ?? 0,
      assignedAgent: null,
      acpSessionId: null,
      source: opts.source ?? 'planned',
      stale: false,
      needsReview: opts.needsReview !== false,
      compactedAt: null,
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
    // Skip review if needsReview is false — go straight to done
    const targetState = task.needsReview === false ? 'done' : 'in_review';
    const result = transition(task.state, targetState, { taskId });
    this.store.updateTaskState(taskId, targetState);
    if (claim) {
      this.store.updateTaskClaim(taskId, claim);
    }
    this.processEffects(result.effects);
    if (targetState === 'done') {
      this.propagateEpicState(taskId);
    }
    return { ...task, state: targetState };
  }

  completeTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'done', { taskId: id });
    this.store.updateTaskState(id, 'done');
    this.processEffects(result.effects);
    // Auto-propagate epic state
    this.propagateEpicState(id);
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

  resumeTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'running', { taskId: id });
    this.store.updateTaskState(id, 'running');
    this.processEffects(result.effects);
    return { ...task, state: 'running' };
  }

  skipTask(id: TaskId): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const result = transition(task.state, 'skipped', { taskId: id });
    this.store.updateTaskState(id, 'skipped');
    this.processEffects(result.effects);
    // Auto-propagate epic state
    this.propagateEpicState(id);
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
    needsReview?: boolean;
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
        needsReview: t.needsReview,
      });
      idMap.set(t.title, task.id);
      results.push(task);
    }
    // Second pass: resolve dependency references
    // Dependencies can reference other tasks by:
    //   - title: "Implement CLI calculator core logic"
    //   - index: "#0", "#1", etc. (0-based index within this batch)
    //   - existing task ID: "task-abc123"
    const resolvedDepsMap = new Map<number, TaskId[]>();
    for (let i = 0; i < tasks.length; i++) {
      const deps = tasks[i].dependsOn;
      if (deps && deps.length > 0) {
        const resolvedDeps = deps.map(d => {
          if (d.startsWith('#') && /^#\d+$/.test(d)) {
            const idx = parseInt(d.slice(1), 10);
            if (idx >= 0 && idx < results.length) return results[idx].id;
            return d as TaskId;
          }
          return idMap.get(d) ?? d as TaskId;
        });
        resolvedDepsMap.set(i, resolvedDeps);
      }
    }

    // Cycle detection: build adjacency within this batch and check for cycles
    const batchIds = new Set(results.map(r => r.id));
    const batchAdj = new Map<TaskId, TaskId[]>();
    for (const [i, deps] of resolvedDepsMap) {
      batchAdj.set(results[i].id, deps.filter(d => batchIds.has(d)));
    }
    if (batchIds.size > 0) {
      const visited = new Set<TaskId>();
      const inStack = new Set<TaskId>();
      const hasCycle = (node: TaskId): boolean => {
        if (inStack.has(node)) return true;
        if (visited.has(node)) return false;
        visited.add(node);
        inStack.add(node);
        for (const dep of (batchAdj.get(node) ?? [])) {
          if (hasCycle(dep)) return true;
        }
        inStack.delete(node);
        return false;
      };
      for (const id of batchIds) {
        if (hasCycle(id)) {
          // Rollback: delete all created tasks
          for (const r of results) {
            try { this.store.deleteTask(r.id); } catch { /* best effort */ }
          }
          throw new Error('Circular dependency detected in task batch. No tasks were created.');
        }
      }
    }

    // Third pass: commit dependencies to store
    for (const [i, resolvedDeps] of resolvedDepsMap) {
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
        case 'unblock_dependents': {
          // Unblock dependents: blocked → pending (parent task is being retried)
          const deps = this.adjacency.get(effect.taskId) ?? new Set();
          for (const depId of deps) {
            const depTask = this.store.getTask(depId);
            if (depTask && depTask.state === 'blocked') {
              this.store.updateTaskState(depId, 'pending');
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
        case 'escalate':
        case 'notify_agent':
        case 'update_dag':
        case 'log_decision':
          // Delegate to external handler (Orchestrator) which has AgentManager, MessageStore, etc.
          if (this.effectHandler) {
            this.effectHandler(effect);
          }
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

  /**
   * Compact a completed task by replacing its description with a short summary.
   * FR-015: Task compaction.
   */
  compactTask(taskId: TaskId, summary?: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.state !== 'done' && task.state !== 'skipped' && task.state !== 'cancelled' && task.state !== 'failed') {
      throw new Error(`Task ${taskId} is not in a terminal state (state: ${task.state})`);
    }
    const compactSummary = summary ?? `[Compacted] ${task.title}: ${task.state}`;
    this.store.compactTask(taskId, compactSummary);
    return { ...task, description: compactSummary, compactedAt: new Date().toISOString() };
  }

  /**
   * Declare sub-tasks under a parent task (FR-017: Hierarchical DAGs).
   * Sub-tasks inherit parent's specId. Parent becomes blocked until all sub-tasks complete.
   */
  declareSubTasks(parentId: TaskId, subTasks: Array<{
    title: string;
    description?: string;
    role?: AgentRole;
    dependsOn?: string[];
    priority?: number;
    needsReview?: boolean;
  }>): Task[] {
    const parent = this.store.getTask(parentId);
    if (!parent) throw new Error(`Parent task not found: ${parentId}`);

    // Create sub-tasks with parentTaskId set
    const idMap = new Map<string, TaskId>();
    const results: Task[] = [];

    for (const st of subTasks) {
      const task = this.addTask({
        title: st.title,
        description: st.description,
        specId: parent.specId as SpecId | undefined,
        role: st.role,
        priority: st.priority,
        needsReview: st.needsReview,
        parentTaskId: parentId,
      });
      idMap.set(st.title, task.id);
      results.push(task);
    }

    // Wire up inter-subtask dependencies
    for (let i = 0; i < subTasks.length; i++) {
      const deps = subTasks[i].dependsOn;
      if (deps && deps.length > 0) {
        const resolvedDeps = deps.map(d => {
          // Support #N index references (0-based)
          if (d.startsWith('#') && /^#\d+$/.test(d)) {
            const idx = parseInt(d.slice(1), 10);
            if (idx >= 0 && idx < results.length) return results[idx].id;
            return d as TaskId;
          }
          return idMap.get(d) ?? d as TaskId;
        });
        this.store.updateTaskDependsOn(results[i].id, resolvedDeps);
        results[i] = { ...results[i], dependsOn: resolvedDeps };
        const allDone = resolvedDeps.every(d => {
          const t = this.store.getTask(d);
          return t?.state === 'done';
        });
        if (!allDone) {
          this.store.updateTaskState(results[i].id, 'pending');
          results[i] = { ...results[i], state: 'pending' };
        }
        for (const dep of resolvedDeps) {
          if (!this.adjacency.has(dep)) this.adjacency.set(dep, new Set());
          this.adjacency.get(dep)!.add(results[i].id);
          if (!this.reverseAdj.has(results[i].id)) this.reverseAdj.set(results[i].id, new Set());
          this.reverseAdj.get(results[i].id)!.add(dep);
        }
      }
    }

    // Make parent depend on all sub-tasks (parent blocked until all done)
    const parentDeps = [...parent.dependsOn, ...results.map(r => r.id)];
    this.store.updateTaskDependsOn(parentId, parentDeps);
    // If parent is ready/running, set to pending so it waits for sub-tasks
    if (parent.state === 'ready') {
      this.store.updateTaskState(parentId, 'pending');
    }
    // Update adjacency: sub-tasks -> parent
    for (const r of results) {
      if (!this.adjacency.has(r.id)) this.adjacency.set(r.id, new Set());
      this.adjacency.get(r.id)!.add(parentId);
      if (!this.reverseAdj.has(parentId)) this.reverseAdj.set(parentId, new Set());
      this.reverseAdj.get(parentId)!.add(r.id);
    }

    return results;
  }

  /**
   * Get sub-tasks of a parent task.
   */
  getSubTasks(parentId: TaskId): Task[] {
    return this.store.getSubTasks(parentId);
  }

  /**
   * Check if a task is an epic (has sub-tasks).
   */
  isEpic(taskId: TaskId): boolean {
    return this.store.getSubTasks(taskId).length > 0;
  }

  /**
   * Get all top-level tasks that have children (epics).
   */
  getEpics(): Task[] {
    const allTasks = this.store.listTasks();
    return allTasks.filter(t => t.parentTaskId === null && this.isEpic(t.id));
  }

  /**
   * Derive epic state from children states.
   * Returns: done (all done/skipped), failed (any failed), running (any running), ready (any ready), pending otherwise.
   */
  deriveEpicState(epicId: TaskId): TaskState {
    const children = this.store.getSubTasks(epicId);
    if (children.length === 0) return 'pending';
    const states = children.map(c => c.state);
    if (states.every(s => s === 'done' || s === 'skipped')) return 'done';
    if (states.some(s => s === 'failed')) return 'failed';
    if (states.some(s => s === 'running' || s === 'in_review')) return 'running';
    if (states.some(s => s === 'ready')) return 'ready';
    return 'pending';
  }

  /**
   * Propagate epic state after a sub-task state change.
   * Call this after completing/failing a sub-task that has a parentTaskId.
   */
  propagateEpicState(childTaskId: TaskId): void {
    const child = this.store.getTask(childTaskId);
    if (!child?.parentTaskId) return;
    const epic = this.store.getTask(child.parentTaskId);
    if (!epic) return;

    const derivedState = this.deriveEpicState(child.parentTaskId);
    // Auto-complete epic when all children are done/skipped
    if (derivedState === 'done' && epic.state !== 'done') {
      // Epic auto-completion bypasses normal state machine since epics
      // don't go through running/in_review — they're containers
      this.store.updateTaskState(epic.id, 'done');
      // Resolve dependents of the epic
      this.resolveReady(epic.id);
    }
  }
}

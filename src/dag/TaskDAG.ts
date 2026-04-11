// Task DAG Engine
// Inspired by: Flightdeck 1.0 TaskDAG (adjacency list, file conflict detection),
// beads (hash-based IDs, compaction), sudocode (topo-sort execution)

import {
  type Task, type TaskId, type TaskState, type TaskAction, type SideEffect,
  type TransitionResult, type TransitionError, type Gate, type GateId, type GateType,
  type PlanId, type RoleId,
  taskId, gateId, transition, isTransitionError,
} from '../core/types.js';

export interface TaskInput {
  title: string;
  description: string;
  role: RoleId;
  files?: string[];
  dependsOn?: TaskId[];
  priority?: number;
  specRequirementId?: string;
  planId?: PlanId;
  model?: string;
}

export interface FileConflict {
  file: string;
  tasks: TaskId[];
}

export interface DagStats {
  total: number;
  byState: Record<TaskState, number>;
  ready: number;
  blocked: number;
}

export class TaskDAG {
  private tasks: Map<TaskId, Task> = new Map();
  // Adjacency: dependents[taskId] = tasks that depend ON taskId
  private dependents: Map<TaskId, Set<TaskId>> = new Map();
  // Reverse: dependencies[taskId] = tasks that taskId depends on
  private dependencies: Map<TaskId, Set<TaskId>> = new Map();
  // File ownership tracking
  private fileOwners: Map<string, Set<TaskId>> = new Map();

  // Compaction config
  private compactionTTL: number = 5 * 60 * 1000; // 5 min default

  addTask(input: TaskInput): Task | { error: string } {
    const id = taskId();

    // Check file conflicts: tasks sharing files must have explicit dependency
    if (input.files?.length) {
      const conflicts = this.detectFileConflicts(id, input.files, input.dependsOn ?? []);
      if (conflicts.length > 0) {
        return {
          error: `File conflict: ${conflicts.map(c => `${c.file} shared with [${c.tasks.join(', ')}]`).join('; ')}. Add explicit dependencies.`,
        };
      }
    }

    // Validate dependencies exist
    for (const dep of input.dependsOn ?? []) {
      if (!this.tasks.has(dep)) {
        return { error: `Dependency '${dep}' not found` };
      }
    }

    const now = new Date();
    const state: TaskState = (input.dependsOn?.length ?? 0) > 0 ? 'pending' : 'ready';

    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      state,
      role: input.role,
      files: input.files ?? [],
      dependsOn: input.dependsOn ?? [],
      priority: input.priority ?? 0,
      specRequirementId: input.specRequirementId,
      planId: input.planId,
      model: input.model,
      stale: false,
      compacted: false,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);

    // Register in adjacency lists
    this.dependents.set(id, new Set());
    this.dependencies.set(id, new Set(input.dependsOn ?? []));

    for (const dep of input.dependsOn ?? []) {
      this.dependents.get(dep)?.add(id);
    }

    // Track file ownership
    for (const file of task.files) {
      if (!this.fileOwners.has(file)) {
        this.fileOwners.set(file, new Set());
      }
      this.fileOwners.get(file)!.add(id);
    }

    return task;
  }

  getTask(id: TaskId): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Apply an action to a task, returning side effects or error.
   * This is the ONLY way to change task state.
   */
  applyAction(taskId: TaskId, action: TaskAction): SideEffect[] | TransitionError {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { taskId, currentState: 'pending' as TaskState, action, reason: 'Task not found' };
    }

    const result = transition(taskId, task.state, action);
    if (isTransitionError(result)) {
      return result;
    }

    const oldState = task.state;
    task.state = result.newState;
    task.updatedAt = new Date();

    // Process side effects inline
    for (const effect of result.sideEffects) {
      this.processSideEffect(effect);
    }

    return result.sideEffects;
  }

  private processSideEffect(effect: SideEffect): void {
    switch (effect.type) {
      case 'resolve_dependents':
        this.resolveDependents(effect.taskId);
        break;
      case 'block_dependents':
        this.blockDependents(effect.taskId);
        break;
      case 'compact':
        // Schedule compaction (in real impl would use timer)
        break;
    }
  }

  /**
   * When a task completes, check if any dependent tasks can become ready.
   * Only checks DIRECT dependents (not full-table scan — key Flightdeck 1.0 lesson).
   */
  private resolveDependents(completedId: TaskId): void {
    const deps = this.dependents.get(completedId);
    if (!deps) return;

    for (const depId of deps) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.state !== 'pending') continue;

      // Check if ALL dependencies are done
      const allDeps = this.dependencies.get(depId);
      if (!allDeps) continue;

      const allDone = [...allDeps].every(d => {
        const t = this.tasks.get(d);
        return t && (t.state === 'done' || t.state === 'skipped');
      });

      if (allDone) {
        depTask.state = 'ready';
        depTask.updatedAt = new Date();
      }
    }
  }

  private blockDependents(failedId: TaskId): void {
    const deps = this.dependents.get(failedId);
    if (!deps) return;

    for (const depId of deps) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.state === 'done' || depTask.state === 'running') continue;
      depTask.state = 'blocked';
      depTask.updatedAt = new Date();
    }
  }

  /**
   * File conflict detection: tasks sharing files must have explicit dependency chain.
   */
  private detectFileConflicts(newTaskId: TaskId, files: string[], explicitDeps: TaskId[]): FileConflict[] {
    const conflicts: FileConflict[] = [];
    const depSet = new Set(explicitDeps);

    for (const file of files) {
      const owners = this.fileOwners.get(file);
      if (!owners) continue;

      const conflicting = [...owners].filter(ownerId => {
        if (depSet.has(ownerId)) return false; // Explicit dep = OK
        // Check if there's a transitive dependency
        return !this.hasPath(ownerId, newTaskId) && !this.hasPath(newTaskId, ownerId);
      });

      if (conflicting.length > 0) {
        conflicts.push({ file, tasks: conflicting });
      }
    }

    return conflicts;
  }

  /** BFS to check if there's a path from `from` to `to` in the dependency graph */
  private hasPath(from: TaskId, to: TaskId): boolean {
    const visited = new Set<TaskId>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = this.dependents.get(current);
      if (deps) {
        for (const d of deps) queue.push(d);
      }
    }
    return false;
  }

  /** Cycle detection via DFS */
  hasCycle(): boolean {
    const visited = new Set<TaskId>();
    const inStack = new Set<TaskId>();

    const dfs = (id: TaskId): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const deps = this.dependents.get(id);
      if (deps) {
        for (const dep of deps) {
          if (dfs(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };

    for (const id of this.tasks.keys()) {
      if (dfs(id)) return true;
    }
    return false;
  }

  /** Topological sort for execution order (Kahn's algorithm) */
  topoSort(): TaskId[] | { error: 'cycle_detected' } {
    const inDegree = new Map<TaskId, number>();
    for (const [id] of this.tasks) {
      inDegree.set(id, this.dependencies.get(id)?.size ?? 0);
    }

    const queue: TaskId[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    // Sort queue by priority (higher priority first)
    queue.sort((a, b) => (this.tasks.get(b)?.priority ?? 0) - (this.tasks.get(a)?.priority ?? 0));

    const result: TaskId[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);

      const deps = this.dependents.get(id);
      if (deps) {
        for (const dep of deps) {
          const deg = (inDegree.get(dep) ?? 1) - 1;
          inDegree.set(dep, deg);
          if (deg === 0) queue.push(dep);
        }
      }
    }

    if (result.length !== this.tasks.size) {
      return { error: 'cycle_detected' };
    }

    return result;
  }

  /** Get tasks that are ready to execute, sorted by priority */
  getReadyTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter(t => t.state === 'ready')
      .sort((a, b) => b.priority - a.priority);
  }

  /** Add a gate to a task (from beads: async coordination primitives) */
  addGate(taskIdVal: TaskId, awaitType: GateType, awaitId: string, timeout?: number): Gate | { error: string } {
    const task = this.tasks.get(taskIdVal);
    if (!task) return { error: 'Task not found' };

    const gate: Gate = {
      id: gateId(),
      taskId: taskIdVal,
      awaitType,
      awaitId,
      timeout,
      cleared: false,
      createdAt: new Date(),
    };

    task.gate = gate;

    // Transition task to gated state
    const result = this.applyAction(taskIdVal, 'gate');
    if ('reason' in result) {
      // If can't gate from current state, just attach the gate without state change
      task.gate = gate;
    }

    return gate;
  }

  /** Clear a gate, potentially unblocking the task */
  clearGate(taskIdVal: TaskId): SideEffect[] | { error: string } {
    const task = this.tasks.get(taskIdVal);
    if (!task) return { error: 'Task not found' };
    if (!task.gate) return { error: 'Task has no gate' };

    task.gate.cleared = true;
    task.gate.clearedAt = new Date();

    if (task.state === 'gated') {
      const result = this.applyAction(taskIdVal, 'clear_gate');
      if ('reason' in result) return { error: result.reason };
      return result;
    }

    return [];
  }

  /** Compact completed tasks after TTL (from beads: memory decay) */
  compactCompleted(summary: (task: Task) => string): number {
    const cutoff = new Date(Date.now() - this.compactionTTL);
    let count = 0;

    for (const task of this.tasks.values()) {
      if (task.state === 'done' && !task.compacted && task.updatedAt <= cutoff) {
        task.compacted = true;
        task.compactedSummary = summary(task);
        // Clear heavy fields
        task.description = '[compacted]';
        count++;
      }
    }

    return count;
  }

  setCompactionTTL(ms: number): void {
    this.compactionTTL = ms;
  }

  /** Mark tasks linked to a spec requirement as stale */
  markStaleByRequirement(requirementId: string): TaskId[] {
    const stale: TaskId[] = [];
    for (const task of this.tasks.values()) {
      if (task.specRequirementId === requirementId && task.state !== 'done') {
        task.stale = true;
        stale.push(task.id);
      }
    }
    return stale;
  }

  stats(): DagStats {
    const byState = {} as Record<TaskState, number>;
    for (const s of ['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'blocked', 'paused', 'skipped', 'gated'] as const) {
      byState[s] = 0;
    }
    for (const t of this.tasks.values()) {
      byState[t.state]++;
    }
    return {
      total: this.tasks.size,
      byState,
      ready: byState.ready,
      blocked: byState.blocked,
    };
  }
}

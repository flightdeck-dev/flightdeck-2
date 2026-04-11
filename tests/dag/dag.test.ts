import { describe, it, expect } from 'vitest';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { type RoleId, type TaskId } from '../../src/core/types.js';

const role = 'role-dev' as RoleId;

describe('TaskDAG', () => {
  it('adds a task and returns it', () => {
    const dag = new TaskDAG();
    const task = dag.addTask({ title: 'Test', description: 'Desc', role });
    expect('error' in task).toBe(false);
    if (!('error' in task)) {
      expect(task.state).toBe('ready'); // No deps → ready
      expect(task.id.startsWith('tk-')).toBe(true);
    }
  });

  it('task with dependencies starts as pending', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role });
    if ('error' in t1) throw new Error(t1.error);

    const t2 = dag.addTask({ title: 'B', description: '', role, dependsOn: [t1.id] });
    if ('error' in t2) throw new Error(t2.error);
    expect(t2.state).toBe('pending');
  });

  it('completing a dependency resolves dependents', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role });
    if ('error' in t1) throw new Error(t1.error);
    const t2 = dag.addTask({ title: 'B', description: '', role, dependsOn: [t1.id] });
    if ('error' in t2) throw new Error(t2.error);

    // Start t1
    dag.applyAction(t1.id, 'start');
    // Complete t1
    dag.applyAction(t1.id, 'complete');

    const updated = dag.getTask(t2.id);
    expect(updated?.state).toBe('ready');
  });

  it('failing a task blocks dependents', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role });
    if ('error' in t1) throw new Error(t1.error);
    const t2 = dag.addTask({ title: 'B', description: '', role, dependsOn: [t1.id] });
    if ('error' in t2) throw new Error(t2.error);

    dag.applyAction(t1.id, 'start');
    dag.applyAction(t1.id, 'fail');

    expect(dag.getTask(t2.id)?.state).toBe('blocked');
  });

  it('detects file conflicts', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role, files: ['src/index.ts'] });
    if ('error' in t1) throw new Error(t1.error);

    // No explicit dependency on t1 but shares file → conflict
    const t2 = dag.addTask({ title: 'B', description: '', role, files: ['src/index.ts'] });
    expect('error' in t2).toBe(true);
  });

  it('allows shared files with explicit dependency', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role, files: ['src/index.ts'] });
    if ('error' in t1) throw new Error(t1.error);

    const t2 = dag.addTask({ title: 'B', description: '', role, files: ['src/index.ts'], dependsOn: [t1.id] });
    expect('error' in t2).toBe(false);
  });

  it('topological sort returns correct order', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'A', description: '', role });
    if ('error' in t1) throw new Error(t1.error);
    const t2 = dag.addTask({ title: 'B', description: '', role, dependsOn: [t1.id] });
    if ('error' in t2) throw new Error(t2.error);
    const t3 = dag.addTask({ title: 'C', description: '', role, dependsOn: [t2.id] });
    if ('error' in t3) throw new Error(t3.error);

    const order = dag.topoSort();
    expect(Array.isArray(order)).toBe(true);
    if (Array.isArray(order)) {
      const idx1 = order.indexOf(t1.id);
      const idx2 = order.indexOf(t2.id);
      const idx3 = order.indexOf(t3.id);
      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
    }
  });

  it('getReadyTasks returns only ready tasks sorted by priority', () => {
    const dag = new TaskDAG();
    dag.addTask({ title: 'Low', description: '', role, priority: 1 });
    dag.addTask({ title: 'High', description: '', role, priority: 10 });
    dag.addTask({ title: 'Med', description: '', role, priority: 5 });

    const ready = dag.getReadyTasks();
    expect(ready.length).toBe(3);
    expect(ready[0].priority).toBe(10);
    expect(ready[2].priority).toBe(1);
  });

  it('gate lifecycle: add gate, task becomes gated, clear gate', () => {
    const dag = new TaskDAG();
    const t1 = dag.addTask({ title: 'Gated', description: '', role });
    if ('error' in t1) throw new Error(t1.error);

    const gate = dag.addGate(t1.id, 'ci_check', 'run-123');
    expect('error' in gate).toBe(false);
    expect(dag.getTask(t1.id)?.state).toBe('gated');

    dag.clearGate(t1.id);
    expect(dag.getTask(t1.id)?.state).toBe('ready');
  });

  it('compaction summarizes completed tasks', () => {
    const dag = new TaskDAG();
    dag.setCompactionTTL(0); // Immediate compaction
    const t1 = dag.addTask({ title: 'Done task', description: 'Long description here', role });
    if ('error' in t1) throw new Error(t1.error);

    dag.applyAction(t1.id, 'start');
    dag.applyAction(t1.id, 'complete');

    const count = dag.compactCompleted(t => `Completed: ${t.title}`);
    expect(count).toBe(1);

    const task = dag.getTask(t1.id);
    expect(task?.compacted).toBe(true);
    expect(task?.compactedSummary).toBe('Completed: Done task');
    expect(task?.description).toBe('[compacted]');
  });

  it('stats returns correct counts', () => {
    const dag = new TaskDAG();
    dag.addTask({ title: 'A', description: '', role });
    const t1 = dag.addTask({ title: 'B', description: '', role });
    if (!('error' in t1)) {
      const t2 = dag.addTask({ title: 'C', description: '', role, dependsOn: [t1.id] });
    }

    const stats = dag.stats();
    expect(stats.total).toBe(3);
    expect(stats.ready).toBe(2);
    expect(stats.byState.pending).toBe(1);
  });

  it('rejects dependency on non-existent task', () => {
    const dag = new TaskDAG();
    const result = dag.addTask({ title: 'Bad', description: '', role, dependsOn: ['tk-nonexist' as TaskId] });
    expect('error' in result).toBe(true);
  });
});

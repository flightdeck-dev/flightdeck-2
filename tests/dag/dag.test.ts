import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { TaskId, AgentId } from '../../src/core/types.js';

describe('TaskDAG', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-dag-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds tasks with no dependencies as ready', () => {
    const task = dag.addTask({ title: 'Simple task' });
    expect(task.state).toBe('ready');
  });

  it('adds tasks with dependencies as pending', () => {
    const t1 = dag.addTask({ title: 'First' });
    const t2 = dag.addTask({ title: 'Second', dependsOn: [t1.id] });
    expect(t2.state).toBe('pending');
  });

  it('promotes dependents when task completes', () => {
    const t1 = dag.addTask({ title: 'First' });
    const t2 = dag.addTask({ title: 'Second', dependsOn: [t1.id] });

    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id);

    const updated = dag.getTask(t2.id);
    expect(updated!.state).toBe('ready');
  });

  it('does not promote when not all deps are done', () => {
    const t1 = dag.addTask({ title: 'First' });
    const t2 = dag.addTask({ title: 'Second' });
    const t3 = dag.addTask({ title: 'Third', dependsOn: [t1.id, t2.id] });

    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id);

    // t3 should still be pending because t2 isn't done
    const updated = dag.getTask(t3.id);
    expect(updated!.state).toBe('pending');
  });

  it('claims a ready task', () => {
    const t1 = dag.addTask({ title: 'Task' });
    const claimed = dag.claimTask(t1.id, 'agent-1' as AgentId);
    expect(claimed.state).toBe('running');
    expect(claimed.assignedAgent).toBe('agent-1');
  });

  it('rejects claiming non-ready task', () => {
    const t1 = dag.addTask({ title: 'First' });
    const t2 = dag.addTask({ title: 'Second', dependsOn: [t1.id] });
    expect(() => dag.claimTask(t2.id, 'agent-1' as AgentId)).toThrow('not ready');
  });

  it('topological sort respects dependencies', () => {
    const t1 = dag.addTask({ title: 'A' });
    const t2 = dag.addTask({ title: 'B', dependsOn: [t1.id] });
    const t3 = dag.addTask({ title: 'C', dependsOn: [t2.id] });

    const sorted = dag.topoSort();
    expect(sorted.indexOf(t1.id)).toBeLessThan(sorted.indexOf(t2.id));
    expect(sorted.indexOf(t2.id)).toBeLessThan(sorted.indexOf(t3.id));
  });

  it('gets stats by state', () => {
    dag.addTask({ title: 'A' });
    dag.addTask({ title: 'B' });
    const t1 = dag.addTask({ title: 'C' });
    dag.claimTask(t1.id, 'agent-1' as AgentId);

    const stats = dag.getStats();
    expect(stats.ready).toBe(2);
    expect(stats.running).toBe(1);
  });

  it('fails a task', () => {
    const t = dag.addTask({ title: 'Fail me' });
    dag.claimTask(t.id, 'agent-1' as AgentId);
    const failed = dag.failTask(t.id);
    expect(failed.state).toBe('failed');
  });

  it('retries a failed task via retryTask', () => {
    const t = dag.addTask({ title: 'Retry me' });
    dag.claimTask(t.id, 'agent-1' as AgentId);
    dag.failTask(t.id);
    const retried = dag.retryTask(t.id);
    expect(retried.state).toBe('ready');
    expect(retried.assignedAgent).toBeNull();
    // Verify in store
    const fromStore = dag.getTask(t.id);
    expect(fromStore?.state).toBe('ready');
    expect(fromStore?.assignedAgent).toBeNull();
  });

  it('retryTask throws on non-failed task', () => {
    const t = dag.addTask({ title: 'Not failed' });
    expect(() => dag.retryTask(t.id)).toThrow('Invalid state transition');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { TaskId, AgentId, SpecId } from '@flightdeck-ai/shared';

describe('Hierarchical DAGs / Sub-tasks (FR-017)', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-subtask-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates sub-tasks under a parent', () => {
    const parent = dag.addTask({ title: 'Epic', specId: 'spec-1' as SpecId });
    const subs = dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);

    expect(subs).toHaveLength(2);
    expect(subs[0].parentTaskId).toBe(parent.id);
    expect(subs[1].parentTaskId).toBe(parent.id);
  });

  it('sub-tasks inherit parent specId', () => {
    const parent = dag.addTask({ title: 'Epic', specId: 'spec-1' as SpecId });
    const subs = dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
    ]);

    expect(subs[0].specId).toBe('spec-1');
  });

  it('parent becomes pending when sub-tasks are declared', () => {
    const parent = dag.addTask({ title: 'Epic' });
    expect(parent.state).toBe('ready');

    dag.declareSubTasks(parent.id, [{ title: 'Sub 1' }]);

    const updated = dag.getTask(parent.id);
    expect(updated!.state).toBe('pending');
  });

  it('parent depends on all sub-tasks', () => {
    const parent = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);

    const updated = dag.getTask(parent.id);
    expect(updated!.dependsOn).toContain(subs[0].id);
    expect(updated!.dependsOn).toContain(subs[1].id);
  });

  it('inter-subtask dependencies work', () => {
    const parent = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2', dependsOn: ['Sub 1'] },
    ]);

    expect(subs[0].state).toBe('ready');
    expect(subs[1].state).toBe('pending');
  });

  it('getSubTasks returns sub-tasks of a parent', () => {
    const parent = dag.addTask({ title: 'Epic' });
    dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);

    const subs = dag.getSubTasks(parent.id);
    expect(subs).toHaveLength(2);
  });

  it('throws when parent not found', () => {
    expect(() => dag.declareSubTasks('nonexistent' as TaskId, [{ title: 'X' }]))
      .toThrow('Parent task not found');
  });

  it('parent becomes ready when all sub-tasks complete', () => {
    const parent = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(parent.id, [
      { title: 'Sub 1' },
    ]);

    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.submitTask(subs[0].id);
    // completeTask internally calls resolveReady which should promote parent
    dag.completeTask(subs[0].id);

    const updated = dag.getTask(parent.id);
    expect(updated!.state).toBe('ready');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { TaskId, AgentId, SpecId } from '@flightdeck-ai/shared';

describe('Epic lifecycle (hierarchical DAGs)', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-epic-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isEpic returns false for tasks without children', () => {
    const task = dag.addTask({ title: 'Plain task' });
    expect(dag.isEpic(task.id)).toBe(false);
  });

  it('isEpic returns true after declaring sub-tasks', () => {
    const epic = dag.addTask({ title: 'Auth System', specId: 'spec-1' as SpecId });
    dag.declareSubTasks(epic.id, [
      { title: 'Login API' },
      { title: 'Token refresh' },
    ]);
    expect(dag.isEpic(epic.id)).toBe(true);
  });

  it('getEpics returns only top-level tasks with children', () => {
    const epic = dag.addTask({ title: 'Auth System' });
    dag.addTask({ title: 'Standalone task' });
    dag.declareSubTasks(epic.id, [{ title: 'Sub 1' }]);
    const epics = dag.getEpics();
    expect(epics).toHaveLength(1);
    expect(epics[0].id).toBe(epic.id);
  });

  it('getSubTasks returns children of an epic', () => {
    const epic = dag.addTask({ title: 'Auth System' });
    dag.declareSubTasks(epic.id, [
      { title: 'Login' },
      { title: 'Logout' },
    ]);
    const subs = dag.getSubTasks(epic.id);
    expect(subs).toHaveLength(2);
    expect(subs.map(s => s.title).sort()).toEqual(['Login', 'Logout']);
  });

  it('deriveEpicState returns done when all children done/skipped', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    // Claim and complete sub-tasks
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.submitTask(subs[0].id);
    dag.completeTask(subs[0].id);
    dag.skipTask(subs[1].id);
    expect(dag.deriveEpicState(epic.id)).toBe('done');
  });

  it('deriveEpicState returns running when any child running', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    expect(dag.deriveEpicState(epic.id)).toBe('running');
  });

  it('deriveEpicState returns failed when any child failed', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.failTask(subs[0].id);
    expect(dag.deriveEpicState(epic.id)).toBe('failed');
  });

  it('auto-completes epic when last sub-task completes', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    // Complete both sub-tasks
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.submitTask(subs[0].id);
    dag.completeTask(subs[0].id);

    dag.claimTask(subs[1].id, 'agent-2' as AgentId);
    dag.submitTask(subs[1].id);
    dag.completeTask(subs[1].id);

    // Epic should auto-complete
    const updatedEpic = dag.getTask(epic.id)!;
    expect(updatedEpic.state).toBe('done');
  });

  it('epic stays pending when only some sub-tasks are done', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.submitTask(subs[0].id);
    dag.completeTask(subs[0].id);

    const updatedEpic = dag.getTask(epic.id)!;
    expect(updatedEpic.state).not.toBe('done');
  });

  it('skip all sub-tasks auto-completes epic', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Sub 1' },
      { title: 'Sub 2' },
    ]);
    dag.skipTask(subs[0].id);
    dag.skipTask(subs[1].id);

    const updatedEpic = dag.getTask(epic.id)!;
    expect(updatedEpic.state).toBe('done');
  });

  it('sub-tasks with dependencies work within epic', () => {
    const epic = dag.addTask({ title: 'Epic' });
    const subs = dag.declareSubTasks(epic.id, [
      { title: 'Setup DB' },
      { title: 'Build API', dependsOn: ['Setup DB'] },
    ]);
    expect(subs[0].state).toBe('ready');
    expect(subs[1].state).toBe('pending');

    // Complete first, second should become ready
    dag.claimTask(subs[0].id, 'agent-1' as AgentId);
    dag.submitTask(subs[0].id);
    dag.completeTask(subs[0].id);

    const sub2 = dag.getTask(subs[1].id)!;
    expect(sub2.state).toBe('ready');
  });
});

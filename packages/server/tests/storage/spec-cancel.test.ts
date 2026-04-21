import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { AgentId, SpecId } from '@flightdeck-ai/shared';

describe('cancelTasksBySpec', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-speccancel-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cancels all non-done tasks for a spec', () => {
    const specId = 'spec-1' as SpecId;
    const t1 = dag.addTask({ title: 'Task 1', specId });
    const t2 = dag.addTask({ title: 'Task 2', specId });

    const count = store.cancelTasksBySpec(specId);
    expect(count).toBe(2);
    expect(store.getTask(t1.id)!.state).toBe('cancelled');
    expect(store.getTask(t2.id)!.state).toBe('cancelled');
  });

  it('does not affect done or skipped tasks', () => {
    const specId = 'spec-2' as SpecId;
    const t1 = dag.addTask({ title: 'Done task', specId, needsReview: false });
    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id); // goes straight to done since needsReview: false
    const t2 = dag.addTask({ title: 'Ready task', specId });

    const count = store.cancelTasksBySpec(specId);
    expect(count).toBe(1); // only t2
    expect(store.getTask(t1.id)!.state).toBe('done');
    expect(store.getTask(t2.id)!.state).toBe('cancelled');
  });
});

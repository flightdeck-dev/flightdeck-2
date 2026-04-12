import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { TaskId, AgentId } from '@flightdeck-ai/shared';

describe('Task Compaction (FR-015)', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-compact-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compacts a completed task', () => {
    const task = dag.addTask({ title: 'Build feature', description: 'Long description here with many details' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    dag.completeTask(task.id);

    const compacted = dag.compactTask(task.id, 'Built feature successfully');
    expect(compacted.description).toBe('Built feature successfully');
    expect(compacted.compactedAt).toBeTruthy();
  });

  it('uses default summary when none provided', () => {
    const task = dag.addTask({ title: 'My Task' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    dag.completeTask(task.id);

    const compacted = dag.compactTask(task.id);
    expect(compacted.description).toContain('[Compacted]');
    expect(compacted.description).toContain('My Task');
  });

  it('refuses to compact non-terminal tasks', () => {
    const task = dag.addTask({ title: 'Running task' });
    dag.claimTask(task.id, 'agent-1' as AgentId);

    expect(() => dag.compactTask(task.id)).toThrow('not in a terminal state');
  });

  it('compacts failed tasks', () => {
    const task = dag.addTask({ title: 'Failed task' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.failTask(task.id);

    const compacted = dag.compactTask(task.id);
    expect(compacted.compactedAt).toBeTruthy();
  });

  it('persists compactedAt in store', () => {
    const task = dag.addTask({ title: 'Persist test' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    dag.completeTask(task.id);
    dag.compactTask(task.id, 'done');

    const fromStore = store.getTask(task.id);
    expect(fromStore!.compactedAt).toBeTruthy();
    expect(fromStore!.description).toBe('done');
  });
});

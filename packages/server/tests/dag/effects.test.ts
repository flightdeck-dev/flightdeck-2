import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { TaskId, AgentId } from '@flightdeck-ai/shared';

describe('TaskDAG effect processing', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-fx-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('running→done is no longer valid (must go through in_review)', () => {
    const t = dag.addTask({ title: 'Test' });
    dag.claimTask(t.id, 'agent-1' as AgentId);
    // Cannot jump from running to done directly
    expect(() => dag.completeTask(t.id)).toThrow('Invalid state transition');
  });

  it('running→in_review→done is the valid path', () => {
    const t = dag.addTask({ title: 'Test' });
    dag.claimTask(t.id, 'agent-1' as AgentId);
    const submitted = dag.submitTask(t.id);
    expect(submitted.state).toBe('in_review');
    const completed = dag.completeTask(t.id);
    expect(completed.state).toBe('done');
  });

  it('resolve_dependents effect promotes pending tasks on completion', () => {
    const t1 = dag.addTask({ title: 'First' });
    const t2 = dag.addTask({ title: 'Second', dependsOn: [t1.id] });

    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id); // This should trigger resolve_dependents via effect

    const updated = dag.getTask(t2.id);
    expect(updated!.state).toBe('ready');
  });

  it('claim is stored when submitTask is called with claim text', () => {
    const t = dag.addTask({ title: 'Claimable' });
    dag.claimTask(t.id, 'agent-1' as AgentId);
    dag.submitTask(t.id, 'I implemented the OAuth2 PKCE flow');

    // Verify claim is stored in DB
    const row = store['db'].$client.prepare('SELECT claim FROM tasks WHERE id = ?').get(t.id) as { claim: string };
    expect(row.claim).toBe('I implemented the OAuth2 PKCE flow');
  });

  it('topoSort detects cycles', () => {
    // We can't create real cycles through addTask (deps must exist),
    // but we can manually insert tasks with circular deps
    const now = new Date().toISOString();
    store.insertTask({
      id: 'task-a' as TaskId, specId: null, title: 'A', description: '',
      state: 'pending', role: 'worker', dependsOn: ['task-b' as TaskId],
      priority: 0, assignedAgent: null, acpSessionId: null, createdAt: now, updatedAt: now,
    });
    store.insertTask({
      id: 'task-b' as TaskId, specId: null, title: 'B', description: '',
      state: 'pending', role: 'worker', dependsOn: ['task-a' as TaskId],
      priority: 0, assignedAgent: null, acpSessionId: null, createdAt: now, updatedAt: now,
    });

    const dag2 = new TaskDAG(store);
    expect(() => dag2.topoSort()).toThrow('Cycle detected');
  });
});

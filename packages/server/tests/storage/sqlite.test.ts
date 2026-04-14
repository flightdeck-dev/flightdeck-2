import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import type { Task, Agent, CostEntry, TaskId, AgentId, SpecId } from '@flightdeck-ai/shared';

describe('SqliteStore', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-test-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts and retrieves tasks', () => {
    const task: Task = {
      id: 'task-abc123' as TaskId,
      specId: null,
      title: 'Test task',
      description: 'A test',
      state: 'ready',
      role: 'worker',
      dependsOn: [],
      priority: 1,
      assignedAgent: null,
      acpSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.insertTask(task);
    const retrieved = store.getTask('task-abc123' as TaskId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Test task');
    expect(retrieved!.state).toBe('ready');
  });

  it('updates task state', () => {
    const task: Task = {
      id: 'task-xyz' as TaskId,
      specId: null,
      title: 'Update test',
      description: '',
      state: 'ready',
      role: 'worker',
      dependsOn: [],
      priority: 0,
      assignedAgent: null,
      acpSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.insertTask(task);
    store.updateTaskState('task-xyz' as TaskId, 'running', 'agent-1' as AgentId);
    const updated = store.getTask('task-xyz' as TaskId);
    expect(updated!.state).toBe('running');
    expect(updated!.assignedAgent).toBe('agent-1');
  });

  it('lists tasks by state', () => {
    for (let i = 0; i < 3; i++) {
      store.insertTask({
        id: `task-${i}` as TaskId,
        specId: null, title: `Task ${i}`, description: '',
        state: i === 0 ? 'ready' : 'pending',
        role: 'worker', dependsOn: [], priority: 0,
        assignedAgent: null, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
    expect(store.getTasksByState('ready')).toHaveLength(1);
    expect(store.getTasksByState('pending')).toHaveLength(2);
  });

  it('manages agents', () => {
    const agent: Agent = {
      id: 'agent-test' as AgentId,
      role: 'worker',
      runtime: 'acp',
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };
    store.insertAgent(agent);
    expect(store.listAgents()).toHaveLength(1);
    store.updateAgentStatus('agent-test' as AgentId, 'busy');
    expect(store.getAgent('agent-test' as AgentId)!.status).toBe('busy');
  });

  it('tracks costs', () => {
    const entry: CostEntry = {
      agentId: 'agent-1' as AgentId,
      specId: null,
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.05,
      timestamp: new Date().toISOString(),
    };
    store.insertCostEntry(entry);
    store.insertCostEntry({ ...entry, costUsd: 0.10 });
    expect(store.getTotalCost()).toBeCloseTo(0.15);
  });

  describe('resetOrphanedTasks', () => {
    it('resets running tasks assigned to non-existent agents', () => {
      // Insert an agent and a task assigned to it
      store.insertAgent({
        id: 'agent-alive' as AgentId, role: 'worker', runtime: 'acp',
        acpSessionId: 'acp-1', status: 'busy', currentSpecId: null,
        costAccumulated: 0, lastHeartbeat: null,
      });
      store.insertTask({
        id: 'task-orphan' as TaskId, specId: null, title: 'Orphan',
        description: '', state: 'running', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-dead' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      store.insertTask({
        id: 'task-alive' as TaskId, specId: null, title: 'Alive',
        description: '', state: 'running', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-alive' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const reset = store.resetOrphanedTasks();
      expect(reset).toBe(1);

      const orphan = store.getTask('task-orphan' as TaskId)!;
      expect(orphan.state).toBe('ready');
      expect(orphan.assignedAgent).toBeNull();

      // Task with alive agent should be untouched
      const alive = store.getTask('task-alive' as TaskId)!;
      expect(alive.state).toBe('running');
      expect(alive.assignedAgent).toBe('agent-alive');
    });

    it('resets in_review and claimed tasks too', () => {
      store.insertTask({
        id: 'task-review' as TaskId, specId: null, title: 'In Review',
        description: '', state: 'in_review', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-gone' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const reset = store.resetOrphanedTasks();
      expect(reset).toBe(1);
      expect(store.getTask('task-review' as TaskId)!.state).toBe('ready');
    });

    it('does not reset done or failed tasks', () => {
      store.insertTask({
        id: 'task-done' as TaskId, specId: null, title: 'Done',
        description: '', state: 'done', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-gone' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      store.insertTask({
        id: 'task-fail' as TaskId, specId: null, title: 'Failed',
        description: '', state: 'failed', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-gone' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const reset = store.resetOrphanedTasks();
      expect(reset).toBe(0);
    });

    it('returns 0 when no tasks are orphaned', () => {
      store.insertAgent({
        id: 'agent-ok' as AgentId, role: 'worker', runtime: 'acp',
        acpSessionId: 'acp-1', status: 'busy', currentSpecId: null,
        costAccumulated: 0, lastHeartbeat: null,
      });
      store.insertTask({
        id: 'task-ok' as TaskId, specId: null, title: 'OK',
        description: '', state: 'running', role: 'worker', dependsOn: [],
        priority: 0, assignedAgent: 'agent-ok' as AgentId, acpSessionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      expect(store.resetOrphanedTasks()).toBe(0);
    });
  });
});

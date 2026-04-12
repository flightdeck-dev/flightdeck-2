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
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import type { AgentId, TaskId, Agent } from '../../src/core/types.js';

describe('TaskDAG new operations', () => {
  let fd: Flightdeck;
  const projectName = `test-dag-ops-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
  });

  afterEach(() => {
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('cancels a running task', () => {
    const worker: Agent = { id: 'w1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    const task = fd.addTask({ title: 'cancel me' });
    fd.claimTask(task.id, 'w1' as AgentId);
    const cancelled = fd.cancelTask(task.id);
    expect(cancelled.state).toBe('cancelled');
  });

  it('cancels a ready task', () => {
    const task = fd.addTask({ title: 'cancel ready' });
    const cancelled = fd.cancelTask(task.id);
    expect(cancelled.state).toBe('cancelled');
  });

  it('pauses a running task', () => {
    const worker: Agent = { id: 'w1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    const task = fd.addTask({ title: 'pause me' });
    fd.claimTask(task.id, 'w1' as AgentId);
    const paused = fd.pauseTask(task.id);
    expect(paused.state).toBe('paused');
  });

  it('skips a pending task and unblocks dependents', () => {
    const t1 = fd.addTask({ title: 'skip me' });
    // Create dependent manually
    const t2 = fd.addTask({ title: 'depends on skip', dependsOn: [t1.id] });
    expect(t2.state).toBe('pending');
    fd.skipTask(t1.id);
    // Check dependent is now ready
    const updated = fd.dag.getTask(t2.id);
    expect(updated?.state).toBe('ready');
  });

  it('reopens a done task', () => {
    const worker: Agent = { id: 'w1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    const task = fd.addTask({ title: 'reopen me' });
    fd.claimTask(task.id, 'w1' as AgentId);
    fd.submitTask(task.id);
    fd.completeTask(task.id);
    const reopened = fd.reopenTask(task.id);
    expect(reopened.state).toBe('ready');
    expect(reopened.assignedAgent).toBeNull();
  });

  it('retries a failed task', () => {
    const worker: Agent = { id: 'w1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    const task = fd.addTask({ title: 'retry me' });
    fd.claimTask(task.id, 'w1' as AgentId);
    fd.failTask(task.id);
    const retried = fd.retryTask(task.id);
    expect(retried.state).toBe('ready');
  });

  it('declares batch tasks with dependencies', () => {
    const tasks = fd.declareTasks([
      { title: 'first task' },
      { title: 'second task', dependsOn: ['first task'] },
      { title: 'third task', dependsOn: ['first task', 'second task'] },
    ]);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].state).toBe('ready');
    expect(tasks[1].state).toBe('pending');
    expect(tasks[2].state).toBe('pending');
    expect(tasks[1].dependsOn).toContain(tasks[0].id);
    expect(tasks[2].dependsOn).toContain(tasks[0].id);
    expect(tasks[2].dependsOn).toContain(tasks[1].id);
  });
});

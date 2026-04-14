import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import type { AgentId, Agent } from '@flightdeck-ai/shared';

describe('SqliteStore agent CRUD and cost', () => {
  let fd: Flightdeck;
  const projectName = `test-sqlite-ext-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
  });

  afterEach(() => {
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('inserts and deletes agents', () => {
    const agent: Agent = { id: 'a1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.sqlite.insertAgent(agent);
    expect(fd.sqlite.getAgent('a1' as AgentId)).not.toBeNull();
    expect(fd.sqlite.deleteAgent('a1' as AgentId)).toBe(true);
    expect(fd.sqlite.getAgent('a1' as AgentId)).toBeNull();
  });

  it('counts active agents', () => {
    fd.sqlite.insertAgent({ id: 'a1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null });
    fd.sqlite.insertAgent({ id: 'a2' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null });
    fd.sqlite.insertAgent({ id: 'a3' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'offline', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null });
    expect(fd.sqlite.getActiveAgentCount()).toBe(2);
  });

  it('records and retrieves cost by agent', () => {
    fd.sqlite.insertAgent({ id: 'a1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null });
    fd.sqlite.recordCost('a1' as AgentId, 1.50);
    fd.sqlite.recordCost('a1' as AgentId, 0.50);
    const costs = fd.sqlite.getCostByAgent();
    const a1 = costs.find(c => c.agentId === 'a1');
    expect(a1?.cost).toBe(2.0);
  });

  it('records task cost', () => {
    const task = fd.addTask({ title: 'costly task' });
    fd.sqlite.recordTaskCost(task.id, 3.0);
    const costs = fd.sqlite.getCostByTask();
    const t = costs.find(c => c.taskId === task.id);
    expect(t?.cost).toBe(3.0);
  });
});

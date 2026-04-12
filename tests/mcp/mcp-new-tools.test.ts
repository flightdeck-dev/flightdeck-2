import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { AgentId, Agent } from '../../src/core/types.js';

async function callTool(server: any, name: string, params: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(params);
}

function getText(result: any): string {
  return result.content[0].text;
}

describe('MCP new tools', () => {
  let fd: Flightdeck;
  let server: any;
  const projectName = `test-mcp-new-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
    const lead: Agent = { id: 'lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const worker: Agent = { id: 'worker-1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const planner: Agent = { id: 'planner-1' as AgentId, role: 'planner', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const reviewer: Agent = { id: 'reviewer-1' as AgentId, role: 'reviewer', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(lead);
    fd.registerAgent(worker);
    fd.registerAgent(planner);
    fd.registerAgent(reviewer);
    server = createMcpServer(projectName);
  });

  afterEach(() => {
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('role_list returns all roles', async () => {
    const result = await callTool(server, 'flightdeck_role_list', {});
    const roles = JSON.parse(getText(result));
    expect(roles.length).toBeGreaterThanOrEqual(7);
    expect(roles.some((r: any) => r.id === 'lead')).toBe(true);
  });

  it('role_info returns details', async () => {
    const result = await callTool(server, 'flightdeck_role_info', { roleId: 'worker' });
    const role = JSON.parse(getText(result));
    expect(role.id).toBe('worker');
    expect(role.permissions.task_claim).toBe(true);
    expect(role.specialists).toEqual([]);
  });

  it('task_cancel works for lead', async () => {
    const task = fd.addTask({ title: 'cancel via mcp' });
    const result = await callTool(server, 'flightdeck_task_cancel', { taskId: task.id, agentId: 'lead-1' });
    const data = JSON.parse(getText(result));
    expect(data.state).toBe('cancelled');
  });

  it('task_cancel works for worker', async () => {
    const task = fd.addTask({ title: 'worker cancel' });
    const result = await callTool(server, 'flightdeck_task_cancel', { taskId: task.id, agentId: 'worker-1' });
    const data = JSON.parse(getText(result));
    expect(data.state).toBe('cancelled');
  });

  it('task_pause rejects worker', async () => {
    const task = fd.addTask({ title: 'pause me' });
    const result = await callTool(server, 'flightdeck_task_pause', { taskId: task.id, agentId: 'worker-1' });
    expect(getText(result)).toContain('Error');
  });

  it('task_skip works for planner', async () => {
    const task = fd.addTask({ title: 'skip me' });
    const result = await callTool(server, 'flightdeck_task_skip', { taskId: task.id, agentId: 'planner-1' });
    const data = JSON.parse(getText(result));
    expect(data.state).toBe('skipped');
  });

  it('task_complete works for reviewer', async () => {
    const task = fd.addTask({ title: 'complete me' });
    fd.claimTask(task.id, 'worker-1' as AgentId);
    fd.submitTask(task.id);
    const result = await callTool(server, 'flightdeck_task_complete', { taskId: task.id, agentId: 'reviewer-1' });
    const data = JSON.parse(getText(result));
    expect(data.state).toBe('done');
  });

  it('task_reopen works for lead', async () => {
    const task = fd.addTask({ title: 'reopen me' });
    fd.claimTask(task.id, 'worker-1' as AgentId);
    fd.submitTask(task.id);
    fd.completeTask(task.id);
    const result = await callTool(server, 'flightdeck_task_reopen', { taskId: task.id, agentId: 'lead-1' });
    const data = JSON.parse(getText(result));
    expect(data.state).toBe('ready');
  });

  it('declare_tasks creates batch', async () => {
    const result = await callTool(server, 'flightdeck_declare_tasks', {
      tasks: [
        { title: 'batch-1' },
        { title: 'batch-2', dependsOn: ['batch-1'] },
      ],
      agentId: 'planner-1',
    });
    const tasks = JSON.parse(getText(result));
    expect(tasks).toHaveLength(2);
  });

  it('agent_spawn creates agent and enforces budget', async () => {
    const result = await callTool(server, 'flightdeck_agent_spawn', {
      role: 'worker', agentId: 'lead-1',
    });
    const agent = JSON.parse(getText(result));
    expect(agent.role).toBe('worker');
    expect(agent.status).toBe('idle');
  });

  it('agent_spawn rejected for non-lead', async () => {
    const result = await callTool(server, 'flightdeck_agent_spawn', {
      role: 'worker', agentId: 'worker-1',
    });
    expect(getText(result)).toContain('Error');
  });

  it('agent_terminate works', async () => {
    const result = await callTool(server, 'flightdeck_agent_terminate', {
      targetAgentId: 'worker-1', agentId: 'lead-1',
    });
    const data = JSON.parse(getText(result));
    expect(data.status).toBe('terminated');
  });

  it('agent_list returns all agents', async () => {
    const result = await callTool(server, 'flightdeck_agent_list', {});
    const agents = JSON.parse(getText(result));
    expect(agents.length).toBeGreaterThanOrEqual(4);
  });

  it('learning_add and learning_search', async () => {
    await callTool(server, 'flightdeck_learning_add', {
      category: 'pattern', content: 'Always use branded types', tags: ['typescript'], agentId: 'worker-1',
    });
    const result = await callTool(server, 'flightdeck_learning_search', { query: 'branded' });
    const learnings = JSON.parse(getText(result));
    expect(learnings).toHaveLength(1);
    expect(learnings[0].content).toContain('branded');
  });

  it('cost_report works for lead', async () => {
    const result = await callTool(server, 'flightdeck_cost_report', { agentId: 'lead-1' });
    const data = JSON.parse(getText(result));
    expect(data).toHaveProperty('totalCost');
    expect(data).toHaveProperty('byAgent');
    expect(data).toHaveProperty('byTask');
  });

  it('cost_report rejected for worker', async () => {
    const result = await callTool(server, 'flightdeck_cost_report', { agentId: 'worker-1' });
    expect(getText(result)).toContain('Error');
  });

  it('timer_set and timer_list', async () => {
    await callTool(server, 'flightdeck_timer_set', {
      label: 'test-timer', delayMs: 60000, message: 'check status', agentId: 'worker-1',
    });
    const result = await callTool(server, 'flightdeck_timer_list', { agentId: 'worker-1' });
    const timers = JSON.parse(getText(result));
    expect(timers).toHaveLength(1);
    expect(timers[0].label).toBe('test-timer');
  });

  it('timer_cancel works', async () => {
    await callTool(server, 'flightdeck_timer_set', {
      label: 'cancel-me', delayMs: 60000, message: 'nope', agentId: 'worker-1',
    });
    const result = await callTool(server, 'flightdeck_timer_cancel', {
      label: 'cancel-me', agentId: 'worker-1',
    });
    const data = JSON.parse(getText(result));
    expect(data.cancelled).toBe(true);
  });
});

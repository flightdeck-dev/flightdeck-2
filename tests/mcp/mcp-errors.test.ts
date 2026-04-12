import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { AgentId, Agent } from '../../src/core/types.js';

// Helper to call an MCP tool directly
async function callTool(server: any, name: string, params: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(params);
}

describe('MCP Server Error Messages', () => {
  let fd: Flightdeck;
  const projectName = `test-mcp-errors-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
    // Register test agents
    const worker: Agent = { id: 'agent-worker-1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const lead: Agent = { id: 'agent-lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const planner: Agent = { id: 'agent-planner-1' as AgentId, role: 'planner', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    fd.registerAgent(lead);
    fd.registerAgent(planner);
  });

  afterEach(() => {
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('task_add rejects worker role with helpful message', async () => {
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_add', {
      title: 'test', agentId: 'agent-worker-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('agent-worker-1');
    expect(text).toContain('worker');
    expect(text).toContain('lead/planner');
    expect(text).toContain('flightdeck_escalate');
  });

  it('task_claim rejects non-worker with helpful message', async () => {
    const server = createMcpServer(projectName);
    const task = fd.addTask({ title: 'claimable' });
    const result = await callTool(server, 'flightdeck_task_claim', {
      taskId: task.id, agentId: 'agent-lead-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('agent-lead-1');
    expect(text).toContain('lead');
    expect(text).toContain('worker');
  });

  it('task_claim on non-existent task gives helpful message', async () => {
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_claim', {
      taskId: 'nonexistent-task', agentId: 'agent-worker-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('nonexistent-task');
    expect(text).toContain('not found');
    expect(text).toContain('flightdeck_task_list');
  });

  it('task_submit on wrong state gives helpful message', async () => {
    const server = createMcpServer(projectName);
    const task = fd.addTask({ title: 'not running' });
    const result = await callTool(server, 'flightdeck_task_submit', {
      taskId: task.id, agentId: 'agent-worker-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('ready');
    expect(text).toContain('running');
    expect(text).toContain('flightdeck_task_claim');
  });

  it('unknown agentId gives helpful message', async () => {
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_add', {
      title: 'test', agentId: 'ghost-agent',
    });
    const text = result.content[0].text;
    expect(text).toContain('ghost-agent');
    expect(text).toContain('not found');
    expect(text).toContain('flightdeck_status');
  });

  it('discuss rejects worker with helpful message', async () => {
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_discuss', {
      topic: 'test topic', agentId: 'agent-worker-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('worker');
    expect(text).toContain('lead/planner');
    expect(text).toContain('flightdeck_escalate');
  });

  it('msg_send rejects impersonation', async () => {
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_msg_send', {
      from: 'agent-lead-1', to: 'agent-worker-1', content: 'hi', agentId: 'agent-worker-1',
    });
    const text = result.content[0].text;
    expect(text).toContain('agent-worker-1');
    expect(text).toContain('agent-lead-1');
    expect(text).toContain('must match');
  });
});

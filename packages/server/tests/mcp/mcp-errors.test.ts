import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startTestGateway } from './test-gateway.js';
import type { AgentId, Agent } from '@flightdeck-ai/shared';

// Helper to call an MCP tool directly
async function callTool(server: any, name: string, params: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(params);
}

/** Set the env var that MCP server uses to identify the caller */
function setCallerAgent(agentId: string) {
  process.env.FLIGHTDECK_AGENT_ID = agentId;
}

describe('MCP Server Error Messages', () => {
  let fd: Flightdeck;
  let gateway: { port: number; close: () => void };
  const projectName = `test-mcp-errors-${Date.now()}`;
  const savedEnv = process.env.FLIGHTDECK_AGENT_ID;
  const savedUrl = process.env.FLIGHTDECK_URL;
  const savedProject = process.env.FLIGHTDECK_PROJECT;

  beforeEach(async () => {
    fd = new Flightdeck(projectName);
    // Register test agents
    const worker: Agent = { id: 'agent-worker-1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const lead: Agent = { id: 'agent-lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const planner: Agent = { id: 'agent-planner-1' as AgentId, role: 'planner', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    fd.registerAgent(lead);
    fd.registerAgent(planner);
    gateway = await startTestGateway(fd, projectName);
    process.env.FLIGHTDECK_URL = `http://127.0.0.1:${gateway.port}`;
    process.env.FLIGHTDECK_PROJECT = projectName;
  });

  afterEach(() => {
    gateway?.close();
    fd.close();
    // Restore env
    if (savedEnv) process.env.FLIGHTDECK_AGENT_ID = savedEnv;
    else delete process.env.FLIGHTDECK_AGENT_ID;
    if (savedUrl) process.env.FLIGHTDECK_URL = savedUrl;
    else delete process.env.FLIGHTDECK_URL;
    if (savedProject) process.env.FLIGHTDECK_PROJECT = savedProject;
    else delete process.env.FLIGHTDECK_PROJECT;
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('task_add rejects worker role with helpful message', async () => {
    setCallerAgent('agent-worker-1');
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_add', {
      title: 'test',
    });
    const text = result.content[0].text;
    expect(text).toContain('agent-worker-1');
    expect(text).toContain('worker');
    expect(text).toContain('lead/planner');
    expect(text).toContain('flightdeck_escalate');
  });

  it('task_claim rejects non-worker with helpful message', async () => {
    setCallerAgent('agent-lead-1');
    const server = createMcpServer(projectName);
    const task = fd.addTask({ title: 'claimable' });
    const result = await callTool(server, 'flightdeck_task_claim', {
      taskId: task.id,
    });
    const text = result.content[0].text;
    expect(text).toContain('agent-lead-1');
    expect(text).toContain('lead');
    expect(text).toContain('worker');
  });

  it('task_claim on non-existent task gives helpful message', async () => {
    setCallerAgent('agent-worker-1');
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_claim', {
      taskId: 'nonexistent-task',
    });
    const text = result.content[0].text;
    expect(text).toContain('nonexistent-task');
    expect(text).toContain('not found');
    expect(text).toContain('flightdeck_task_list');
  });

  it('task_submit on wrong state gives helpful message', async () => {
    setCallerAgent('agent-worker-1');
    const server = createMcpServer(projectName);
    const task = fd.addTask({ title: 'not running' });
    const result = await callTool(server, 'flightdeck_task_submit', {
      taskId: task.id,
    });
    const text = result.content[0].text;
    expect(text).toContain('ready');
    expect(text).toContain('running');
    expect(text).toContain('flightdeck_task_claim');
  });

  it('unknown agentId gives helpful message', async () => {
    setCallerAgent('ghost-agent');
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_task_add', {
      title: 'test',
    });
    const text = result.content[0].text;
    expect(text).toContain('ghost-agent');
    expect(text).toContain('not found');
    expect(text).toContain('flightdeck_status');
  });

  it('discuss rejects worker with helpful message', async () => {
    setCallerAgent('agent-worker-1');
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_discuss', {
      topic: 'test topic',
    });
    const text = result.content[0].text;
    expect(text).toContain('worker');
    expect(text).toContain('lead/planner');
    expect(text).toContain('flightdeck_escalate');
  });

  it('send rejects when no FLIGHTDECK_AGENT_ID set', async () => {
    delete process.env.FLIGHTDECK_AGENT_ID;
    const server = createMcpServer(projectName);
    const result = await callTool(server, 'flightdeck_send', {
      to: 'agent-worker-1', content: 'hi',
    });
    const text = result.content[0].text;
    expect(text).toContain('FLIGHTDECK_AGENT_ID');
  });

  it('send ignores from field and uses env identity', async () => {
    setCallerAgent('agent-worker-1');
    const server = createMcpServer(projectName);
    // Even if 'from' is passed, it's ignored — sender is always from env
    const result = await callTool(server, 'flightdeck_send', {
      from: 'agent-lead-1', to: 'agent-lead-1', content: 'hi',
    });
    const text = result.content[0].text;
    // Should succeed as agent-worker-1 (env identity), not reject
    expect(text).toContain('sent');
  });
});

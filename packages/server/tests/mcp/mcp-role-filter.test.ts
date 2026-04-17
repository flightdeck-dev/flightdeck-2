import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startTestGateway } from './test-gateway.js';
import { getToolsForRole, ROLE_TOOLS } from '../../src/mcp/toolPermissions.js';
import type { AgentId, Agent } from '@flightdeck-ai/shared';

// Helper to get registered tool names
function getToolNames(server: any): string[] {
  return Object.keys((server as any)._registeredTools ?? {});
}

// Helper to call an MCP tool directly
async function callTool(server: any, name: string, params: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(params);
}

describe('toolPermissions', () => {
  it('returns correct tools for each role', () => {
    expect(getToolsForRole('lead')).toContain('flightdeck_plan_review');
    expect(getToolsForRole('lead')).toContain('flightdeck_task_list');
    expect(getToolsForRole('worker')).toContain('flightdeck_task_claim');
    expect(getToolsForRole('worker')).not.toContain('flightdeck_agent_spawn');
    expect(getToolsForRole('planner')).toContain('flightdeck_declare_tasks');
    expect(getToolsForRole('planner')).toContain('flightdeck_agent_spawn');
    expect(getToolsForRole('reviewer')).toContain('flightdeck_task_complete');
    expect(getToolsForRole('reviewer')).not.toContain('flightdeck_task_claim');
  });

  it('unknown role gets worker-level access', () => {
    const unknown = getToolsForRole('unknown-role');
    const worker = getToolsForRole('worker');
    expect(unknown).toEqual(worker);
  });

  it('all roles have flightdeck_status and flightdeck_tools_available', () => {
    for (const role of Object.keys(ROLE_TOOLS)) {
      const tools = getToolsForRole(role);
      expect(tools, `${role} missing flightdeck_status`).toContain('flightdeck_status');
      expect(tools, `${role} missing flightdeck_tools_available`).toContain('flightdeck_tools_available');
    }
  });
});

describe('MCP Server role-based tool filtering', () => {
  const projectName = `test-mcp-role-filter-${Date.now()}`;
  let fd: Flightdeck;
  let gateway: { port: number; close: () => void };
  const savedUrl = process.env.FLIGHTDECK_URL;
  const savedProject = process.env.FLIGHTDECK_PROJECT;

  beforeEach(async () => {
    fd = new Flightdeck(projectName);
    const worker: Agent = { id: 'agent-worker-1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const lead: Agent = { id: 'agent-lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(worker);
    fd.registerAgent(lead);
    gateway = await startTestGateway(fd, projectName);
    process.env.FLIGHTDECK_URL = `http://127.0.0.1:${gateway.port}`;
    process.env.FLIGHTDECK_PROJECT = projectName;
  });

  afterEach(() => {
    gateway?.close();
    fd.close();
    if (savedUrl) process.env.FLIGHTDECK_URL = savedUrl;
    else delete process.env.FLIGHTDECK_URL;
    if (savedProject) process.env.FLIGHTDECK_PROJECT = savedProject;
    else delete process.env.FLIGHTDECK_PROJECT;
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('worker role only sees worker tools', () => {
    const server = createMcpServer({ projectName, agentRole: 'worker' });
    const tools = getToolNames(server);
    expect(tools).toContain('flightdeck_task_claim');
    expect(tools).toContain('flightdeck_task_submit');
    expect(tools).toContain('flightdeck_status');
    expect(tools).not.toContain('flightdeck_agent_spawn');
    expect(tools).not.toContain('flightdeck_agent_terminate');
    expect(tools).not.toContain('flightdeck_model_set');
  });

  it('lead role sees management tools', () => {
    const server = createMcpServer({ projectName, agentRole: 'lead' });
    const tools = getToolNames(server);
    expect(tools).toContain('flightdeck_plan_review');
    expect(tools).toContain('flightdeck_task_list');
    expect(tools).toContain('flightdeck_model_set');
    expect(tools).toContain('flightdeck_report');
  });

  it('reviewer only sees review-related tools', () => {
    const server = createMcpServer({ projectName, agentRole: 'reviewer' });
    const tools = getToolNames(server);
    expect(tools).toContain('flightdeck_task_complete');
    expect(tools).toContain('flightdeck_task_fail');
    expect(tools).not.toContain('flightdeck_task_claim');
    expect(tools).not.toContain('flightdeck_agent_spawn');
  });

  it('no role = all tools visible', () => {
    const server = createMcpServer({ projectName });
    const tools = getToolNames(server);
    // Should have all registered tools
    expect(tools).toContain('flightdeck_agent_spawn');
    expect(tools).toContain('flightdeck_task_claim');
    expect(tools).toContain('flightdeck_task_complete');
    expect(tools.length).toBeGreaterThan(30);
  });

  it('flightdeck_tools_available returns role tools', async () => {
    const server = createMcpServer({ projectName, agentRole: 'worker' });
    const result = await callTool(server, 'flightdeck_tools_available', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.role).toBe('worker');
    expect(data.tools).toContain('flightdeck_task_claim');
    expect(data.tools).not.toContain('flightdeck_agent_spawn');
  });

  it('worker cannot access agent_spawn (tool not registered)', () => {
    const server = createMcpServer({ projectName, agentRole: 'worker' });
    const tools = getToolNames(server);
    expect(tools).not.toContain('flightdeck_agent_spawn');
    // Calling it directly should fail
    const tool = (server as any)._registeredTools['flightdeck_agent_spawn'];
    expect(tool).toBeUndefined();
  });
});

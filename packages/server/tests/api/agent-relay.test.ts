import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpServer } from '../../src/api/HttpServer.js';
import type { ProjectManager } from '../../src/projects/ProjectManager.js';
import type { AgentManager } from '../../src/agents/AgentManager.js';
import type { AgentId, AgentRole, Agent } from '@flightdeck-ai/shared';
import http from 'node:http';

function makeProjectManager(fd: any): ProjectManager {
  return {
    list: () => ['test'],
    get: (name: string) => name === 'test' ? fd : null,
    create: () => {},
    delete: () => true,
    closeAll: () => {},
  } as unknown as ProjectManager;
}

function makeFd(agentManager: AgentManager | null) {
  return {
    project: { subpath: (p: string) => `/tmp/${p}` },
    agentManager,
    listAgents: () => [],
    status: () => ({ config: { name: 'test', governance: 'standard' } }),
    chatMessages: null,
    orchestrator: { pause: () => {}, resume: () => {}, paused: false, isRunning: () => false, getWebhookNotifier: () => null },
    sqlite: { listAgents: () => [] },
    listTasks: () => [],
    decisions: { readAll: () => [] },
    addTask: () => ({}),
  } as any;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as any).port);
    });
  });
}

async function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Agent relay HTTP endpoints', () => {
  let server: http.Server;
  let port: number;
  let mockAm: AgentManager;

  beforeEach(async () => {
    const mockAgent: Agent = {
      id: 'agent-worker-1' as AgentId,
      role: 'worker' as AgentRole,
      runtime: 'acp',
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };

    mockAm = {
      spawnAgent: vi.fn().mockResolvedValue(mockAgent),
      terminateAgent: vi.fn().mockResolvedValue(undefined),
      restartAgent: vi.fn().mockResolvedValue(mockAgent),
      interruptAgent: vi.fn().mockResolvedValue(undefined),
      sendToAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;

    const fd = makeFd(mockAm);
    const pm = makeProjectManager(fd);

    server = createHttpServer({
      projectManager: pm,
      leadManagers: new Map(),
      port: 0,
      corsOrigin: '*',
      wsServers: new Map(),
    });
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
  });

  it('POST /agents/spawn calls agentManager.spawnAgent', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/spawn', { role: 'worker' });
    expect(status).toBe(201);
    expect(data.id).toBe('agent-worker-1');
    expect(mockAm.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker' }));
  });

  it('POST /agents/spawn returns 400 without role', async () => {
    const { status } = await req(port, 'POST', '/api/projects/test/agents/spawn', {});
    expect(status).toBe(400);
  });

  it('POST /agents/:id/terminate calls agentManager.terminateAgent', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/agent-1/terminate');
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockAm.terminateAgent).toHaveBeenCalledWith('agent-1');
  });

  it('POST /agents/:id/restart calls agentManager.restartAgent', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/agent-1/restart');
    expect(status).toBe(200);
    expect(mockAm.restartAgent).toHaveBeenCalledWith('agent-1');
  });

  it('POST /agents/:id/interrupt calls agentManager.interruptAgent', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/agent-1/interrupt', { message: 'stop' });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockAm.interruptAgent).toHaveBeenCalledWith('agent-1', 'stop');
  });

  it('POST /agents/:id/interrupt returns 400 without message', async () => {
    const { status } = await req(port, 'POST', '/api/projects/test/agents/agent-1/interrupt', {});
    expect(status).toBe(400);
  });

  it('POST /agents/:id/send calls agentManager.sendToAgent', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/agent-1/send', { message: 'hello' });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockAm.sendToAgent).toHaveBeenCalledWith('agent-1', 'hello');
  });

  it('POST /agents/:id/send returns 400 without message', async () => {
    const { status } = await req(port, 'POST', '/api/projects/test/agents/agent-1/send', {});
    expect(status).toBe(400);
  });

  it('spawn returns 500 when agentManager throws', async () => {
    (mockAm.spawnAgent as any).mockRejectedValue(new Error('spawn failed'));
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/spawn', { role: 'worker' });
    expect(status).toBe(500);
    expect(data.error).toContain('spawn failed');
  });

  it('returns 404 for unknown project', async () => {
    const { status } = await req(port, 'POST', '/api/projects/nonexistent/agents/spawn', { role: 'worker' });
    expect(status).toBe(404);
  });
});

describe('Agent relay endpoints without AgentManager', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const fd = makeFd(null);
    // fd.agentManager is null — but the facade always has one. Let's simulate no manager.
    fd.agentManager = null;
    const pm = makeProjectManager(fd);

    server = createHttpServer({
      projectManager: pm,
      leadManagers: new Map(),
      port: 0,
      corsOrigin: '*',
      wsServers: new Map(),
    });
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
  });

  it('returns 500 when no AgentManager available', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/agents/spawn', { role: 'worker' });
    expect(status).toBe(500);
    expect(data.error).toContain('No AgentManager');
  });
});

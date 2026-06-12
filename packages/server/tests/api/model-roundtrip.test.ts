import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHttpServer } from '../../src/api/HttpServer.js';
import { Flightdeck } from '../../src/facade.js';
import type { ProjectManager } from '../../src/projects/ProjectManager.js';
import type { AgentId } from '@flightdeck-ai/shared';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

/**
 * Full HTTP-level regression for the "model selection doesn't display" bug:
 * PUT /agents/:id/model must be visible in the next GET /agents response.
 * (The model column used to be written via raw SQL but missing from the
 * drizzle schema, so the GET never returned it and the UI looked unsaved.)
 */
describe('Agent model HTTP roundtrip', () => {
  const projectName = `test-model-rt-${Date.now()}`;
  let fd: Flightdeck;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    fd = new Flightdeck(projectName);
    const projectManager = {
      list: () => [projectName],
      get: (name: string) => (name === projectName ? fd : null),
      create: () => {},
      delete: () => true,
      closeAll: () => {},
    } as unknown as ProjectManager;
    server = createHttpServer({
      projectManager,
      leadManagers: new Map(),
      agentManagers: new Map([[projectName, fd.agentManager]]),
      wsServers: new Map(),
      webhookNotifiers: new Map(),
      cronStores: new Map(),
      port: 0,
      corsOrigin: '*',
    } as any);
    port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });
  });

  afterEach(() => {
    server.close();
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectName}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  it('PUT /agents/:id/model is reflected in GET /agents', async () => {
    fd.registerAgent({
      id: 'worker-rt-1' as AgentId,
      role: 'worker',
      runtime: 'acp',
      runtimeName: 'copilot',
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    });

    const put = await req('PUT', '/agents/worker-rt-1/model', { model: 'claude-sonnet-4.6', runtime: 'copilot' });
    expect(put.status).toBe(200);

    const get = await req('GET', '/agents?include_retired=true');
    expect(get.status).toBe(200);
    const agent = (get.data as any[]).find(a => a.id === 'worker-rt-1');
    expect(agent).toBeDefined();
    expect(agent.model).toBe('claude-sonnet-4.6');
    expect(agent.runtimeName).toBe('copilot');
  });
});

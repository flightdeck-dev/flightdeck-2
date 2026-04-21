import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpServer } from '../../src/api/HttpServer.js';
import type { ProjectManager } from '../../src/projects/ProjectManager.js';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { MessageStore } from '../../src/comms/MessageStore.js';

function makeProjectManager(fd: any): ProjectManager {
  return {
    list: () => ['test'],
    get: (name: string) => (name === 'test' ? fd : null),
    create: () => {},
    delete: () => true,
    closeAll: () => {},
  } as unknown as ProjectManager;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
  });
}

async function req(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('DM routing via /messages/send', () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let sqlStore: SqliteStore;
  let msgStore: MessageStore;
  let steerPlannerFn: ReturnType<typeof vi.fn>;
  let steerLeadFn: ReturnType<typeof vi.fn>;
  let sendToAgentFn: ReturnType<typeof vi.fn>;
  let broadcastFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-dm-route-'));
    sqlStore = new SqliteStore(join(tmpDir, 'test.sqlite'));
    msgStore = new MessageStore(sqlStore.db);

    steerPlannerFn = vi.fn().mockResolvedValue(undefined);
    steerLeadFn = vi.fn().mockResolvedValue(undefined);
    sendToAgentFn = vi.fn().mockResolvedValue(undefined);
    broadcastFn = vi.fn();

    const fd = {
      project: { subpath: (p: string) => join(tmpDir, p) },
      agentManager: { sendToAgent: sendToAgentFn },
      listAgents: () => [],
      status: () => ({ config: { name: 'test', governance: 'standard' } }),
      chatMessages: null,
      messages: msgStore,
      orchestrator: { pause: () => {}, resume: () => {}, paused: false, isRunning: () => false, getWebhookNotifier: () => null },
      sqlite: { listAgents: () => [], getAgent: (id: string) => id.startsWith('worker') ? { role: 'worker', acpSessionId: 'sess-1' } : null },
      listTasks: () => [],
      decisions: { readAll: () => [] },
      addTask: () => ({}),
      sendMessage: vi.fn(),
      readMessages: () => [],
      getUnreadDMs: () => [],
      markDMsRead: () => {},
      learnings: { append: vi.fn(), search: vi.fn().mockReturnValue([]) },
    } as any;

    const pm = makeProjectManager(fd);
    const leadManager = { steerPlanner: steerPlannerFn, steerLead: steerLeadFn } as any;
    const wsServer = { broadcast: broadcastFn } as any;

    server = createHttpServer({
      projectManager: pm,
      leadManagers: new Map([['test', leadManager]]),
      agentManagers: new Map([['test', fd.agentManager]]),
      port: 0,
      corsOrigin: '*',
      wsServers: new Map([['test', wsServer]]),
    });
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
    sqlStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes DM to planner via leadManager.steerPlanner()', async () => {
    const { status, data } = await req(port, 'POST', '/api/projects/test/messages/send', { to: 'planner-abc', content: 'plan this' }, { 'x-agent-id': 'worker-1' });
    expect(status).toBe(200);
    expect(data.status).toBe('sent');
    expect(steerPlannerFn).toHaveBeenCalledOnce();
    expect(steerPlannerFn.mock.calls[0][0]).toContain('plan this');
  });

  it('routes DM to lead via leadManager.steerLead() with agent_message type', async () => {
    const { status } = await req(port, 'POST', '/api/projects/test/messages/send', { to: 'lead-main', content: 'need help' }, { 'x-agent-id': 'worker-2' });
    expect(status).toBe(200);
    expect(steerLeadFn).toHaveBeenCalledOnce();
    expect(steerLeadFn.mock.calls[0][0]).toEqual(expect.objectContaining({ type: 'agent_message', message: 'need help' }));
  });

  it('routes DM to worker via agentManager.sendToAgent()', async () => {
    const { status } = await req(port, 'POST', '/api/projects/test/messages/send', { to: 'worker-5', content: 'do stuff' }, { 'x-agent-id': 'lead-main' });
    expect(status).toBe(200);
    expect(sendToAgentFn).toHaveBeenCalledWith('worker-5', 'do stuff');
  });

  it('stores DM in MessageStore with dm:{to} channel', async () => {
    await req(port, 'POST', '/api/projects/test/messages/send', { to: 'planner-abc', content: 'stored msg' }, { 'x-agent-id': 'worker-1' });
    const dms = msgStore.listChannelMessages('dm:planner-abc');
    expect(dms.length).toBe(1);
    expect(dms[0].content).toBe('stored msg');
    expect(dms[0].authorId).toBe('worker-1');
  });

  it('broadcasts DM via WebSocket as dm:message event', async () => {
    await req(port, 'POST', '/api/projects/test/messages/send', { to: 'lead-main', content: 'ws test' }, { 'x-agent-id': 'worker-3' });
    expect(broadcastFn).toHaveBeenCalled();
    const call = broadcastFn.mock.calls.find((c: any) => c[0]?.type === 'dm:message');
    expect(call).toBeDefined();
    expect(call![0].message.content).toBe('ws test');
  });
});

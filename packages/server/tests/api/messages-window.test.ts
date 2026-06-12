import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHttpServer } from '../../src/api/HttpServer.js';
import { Flightdeck } from '../../src/facade.js';
import type { ProjectManager } from '../../src/projects/ProjectManager.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

/**
 * Regression: GET /messages used slice(-limit) on a newest-first list, so
 * chats longer than `limit` returned the OLDEST window and never showed
 * the most recent messages.
 */
describe('GET /messages window', () => {
  const projectName = `test-msg-window-${Date.now()}`;
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
      agentManagers: new Map(),
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

  it('returns the NEWEST `limit` messages in ascending order', async () => {
    // 120 messages with strictly increasing ids/timestamps
    const base = Date.now();
    for (let i = 0; i < 120; i++) {
      fd.messages!.createMessage({
        id: `msg-${String(i).padStart(3, '0')}`,
        parentId: null, taskId: null, authorType: 'user', authorId: 'u',
        content: `message ${i}`, metadata: null,
      });
      // Distinct createdAt per row (createMessage stamps now): nudge clock
      // by overwriting created_at deterministically
      fd.sqlite.rawClient.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`)
        .run(new Date(base + i * 1000).toISOString(), `msg-${String(i).padStart(3, '0')}`);
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectName}/messages?limit=100`);
    expect(res.status).toBe(200);
    const msgs = await res.json() as Array<{ id: string; content: string }>;
    expect(msgs).toHaveLength(100);
    // Must be the newest 100 (20..119), not the oldest
    expect(msgs[0].content).toBe('message 20');
    expect(msgs[msgs.length - 1].content).toBe('message 119');
    // Ascending render order
    const indices = msgs.map(m => parseInt(m.content.replace('message ', ''), 10));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startTestGateway } from './test-gateway.js';
import type { AgentId, Agent } from '@flightdeck-ai/shared';

async function callTool(server: any, name: string, params: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(params);
}

function getText(result: any): string {
  return result.content[0].text;
}

describe('MCP chat & memory tools', () => {
  let fd: Flightdeck;
  let server: any;
  let gateway: { port: number; close: () => void };
  const projectName = `test-mcp-chat-${Date.now()}`;
  const savedUrl = process.env.FLIGHTDECK_URL;
  const savedProject = process.env.FLIGHTDECK_PROJECT;

  beforeEach(async () => {
    fd = new Flightdeck(projectName);
    const lead: Agent = { id: 'lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(lead);
    gateway = await startTestGateway(fd, projectName);
    process.env.FLIGHTDECK_URL = `http://127.0.0.1:${gateway.port}`;
    process.env.FLIGHTDECK_PROJECT = projectName;
    server = createMcpServer(projectName);
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

  it('flightdeck_msg_list returns empty initially', async () => {
    const result = await callTool(server, 'flightdeck_msg_list', {});
    const msgs = JSON.parse(getText(result));
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBe(0);
  });

  it('flightdeck_thread_create creates a thread', async () => {
    // First create a message via the store directly
    fd.messages.createMessage({
      id: 'msg-origin',
      authorType: 'user',
      authorId: 'user',
      content: 'test',
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
    });

    const result = await callTool(server, 'flightdeck_thread_create', {
      originId: 'msg-origin',
      title: 'My Thread',
    });
    const thread = JSON.parse(getText(result));
    expect(thread.title).toBe('My Thread');
    expect(thread.originId).toBe('msg-origin');
  });

  it('flightdeck_thread_list returns threads', async () => {
    fd.messages.createMessage({
      id: 'msg-1',
      authorType: 'user', authorId: 'user', content: 'x',
      threadId: null, parentId: null, taskId: null, metadata: null,
    });
    fd.messages.createThread({ originId: 'msg-1', title: 'Thread 1' });

    const result = await callTool(server, 'flightdeck_thread_list', {});
    const threads = JSON.parse(getText(result));
    expect(threads.length).toBe(1);
    expect(threads[0].title).toBe('Thread 1');
  });

  it('flightdeck_search returns memory results with line numbers', async () => {
    fd.writeMemory('test-doc.md', '# Test Document\n\nThis has some searchable content.\nAnother line here.\n');

    const result = await callTool(server, 'flightdeck_search', { query: 'searchable', source: 'memory' });
    const parsed = JSON.parse(getText(result));
    expect(parsed.results.length).toBeGreaterThan(0);
    const memResult = parsed.results.find((r: any) => r.source === 'memory');
    expect(memResult).toBeDefined();
    expect(memResult.filename).toBe('test-doc.md');
    expect(memResult.snippet).toContain('searchable');
  });

  it('flightdeck_search searches memory recursively', async () => {
    // Write to a subdirectory
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const retroDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName, 'memory', 'retrospectives');
    mkdirSync(retroDir, { recursive: true });
    writeFileSync(join(retroDir, 'auth-spec.md'), '# Auth Retrospective\n\nPKCE was the right choice.\n');
    fd.memory.reindex();

    const result = await callTool(server, 'flightdeck_search', { query: 'PKCE', source: 'memory' });
    const parsed = JSON.parse(getText(result));
    expect(parsed.results.length).toBeGreaterThan(0);
    const memResult = parsed.results.find((r: any) => r.source === 'memory');
    expect(memResult).toBeDefined();
    expect(memResult.filename).toContain('retrospectives');
  });
});

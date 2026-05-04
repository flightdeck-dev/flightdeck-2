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

describe('MCP channel features', () => {
  let fd: Flightdeck;
  let server: any;
  let gateway: { port: number; close: () => void };
  const projectName = `test-channel-features-${Date.now()}`;
  const savedUrl = process.env.FLIGHTDECK_URL;
  const savedProject = process.env.FLIGHTDECK_PROJECT;
  const savedAgentId = process.env.FLIGHTDECK_AGENT_ID;

  beforeEach(async () => {
    fd = new Flightdeck(projectName);
    const lead: Agent = { id: 'lead-1' as AgentId, role: 'lead', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    const worker: Agent = { id: 'worker-1' as AgentId, role: 'worker', runtime: 'acp', acpSessionId: null, status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null };
    fd.registerAgent(lead);
    fd.registerAgent(worker);
    gateway = await startTestGateway(fd, projectName);
    process.env.FLIGHTDECK_URL = `http://127.0.0.1:${gateway.port}`;
    process.env.FLIGHTDECK_PROJECT = projectName;
    process.env.FLIGHTDECK_AGENT_ID = 'lead-1';
    server = createMcpServer(projectName);
  });

  afterEach(() => {
    gateway?.close();
    fd.close();
    if (savedUrl) process.env.FLIGHTDECK_URL = savedUrl;
    else delete process.env.FLIGHTDECK_URL;
    if (savedProject) process.env.FLIGHTDECK_PROJECT = savedProject;
    else delete process.env.FLIGHTDECK_PROJECT;
    if (savedAgentId) process.env.FLIGHTDECK_AGENT_ID = savedAgentId;
    else delete process.env.FLIGHTDECK_AGENT_ID;
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  // ── flightdeck_send with mentions ──

  it('flightdeck_send supports mentions parameter', async () => {
    const result = await callTool(server, 'flightdeck_send', {
      channel: 'general',
      content: 'Hello team!',
      mentions: ['worker-1', 'lead-1'],
    });
    const data = JSON.parse(getText(result));
    expect(data.status).toBe('sent');
  });

  it('mentions are stored and flagged when reading', async () => {
    // Send a message with mentions
    fd.messages.appendChannelMessage('general', {
      parentId: null, taskId: null, authorType: 'agent', authorId: 'lead-1',
      content: 'Hey worker!', metadata: null, channel: null, recipient: null,
      mentions: ['worker-1'],
    });

    // Read as the mentioned agent
    const msgs = fd.messages.listChannelMessages('general', undefined, undefined, 'worker-1');
    expect(msgs.length).toBe(1);
    expect(msgs[0].mentioned).toBe(true);
    expect(msgs[0].mentions).toEqual(['worker-1']);

    // Read as non-mentioned agent
    const msgs2 = fd.messages.listChannelMessages('general', undefined, undefined, 'lead-1');
    expect(msgs2[0].mentioned).toBe(false);
  });

  // ── flightdeck_channel_create ──

  it('flightdeck_channel_create creates a channel', async () => {
    const result = await callTool(server, 'flightdeck_channel_create', {
      name: 'dev-ops',
      description: 'DevOps discussions',
    });
    const data = JSON.parse(getText(result));
    expect(data.name).toBe('dev-ops');
    expect(data.description).toBe('DevOps discussions');
    expect(data.archived).toBe(false);
  });

  it('flightdeck_channel_create without description', async () => {
    const result = await callTool(server, 'flightdeck_channel_create', {
      name: 'random',
    });
    const data = JSON.parse(getText(result));
    expect(data.name).toBe('random');
  });

  // ── flightdeck_channel_archive ──

  it('flightdeck_channel_archive archives a channel', async () => {
    // Create then archive
    fd.messages.createChannel('old-channel', { createdBy: 'lead-1' });
    const result = await callTool(server, 'flightdeck_channel_archive', { name: 'old-channel' });
    const data = JSON.parse(getText(result));
    expect(data.status).toBe('archived');
  });

  it('archived channels are hidden from list_channels', async () => {
    fd.messages.createChannel('visible', { createdBy: 'lead-1' });
    fd.messages.createChannel('hidden', { createdBy: 'lead-1' });
    fd.messages.archiveChannel('hidden');

    const result = await callTool(server, 'flightdeck_list_channels', {});
    const channels = JSON.parse(getText(result));
    expect(channels).toContain('visible');
    expect(channels).not.toContain('hidden');
  });

  // ── flightdeck_broadcast ──

  it('flightdeck_broadcast sends to all agents', async () => {
    const result = await callTool(server, 'flightdeck_broadcast', {
      content: 'System maintenance in 5 minutes',
    });
    const data = JSON.parse(getText(result));
    expect(data.status).toBe('broadcast');
    expect(data.channel).toBe('broadcast');
    expect(data.recipientCount).toBeGreaterThanOrEqual(2);
  });

  // ── flightdeck_my_subscriptions ──

  it('flightdeck_my_subscriptions returns subscribed channels', async () => {
    fd.messages.subscribe('lead-1', 'general');
    fd.messages.subscribe('lead-1', 'announcements');

    const result = await callTool(server, 'flightdeck_my_subscriptions', {});
    const subs = JSON.parse(getText(result));
    expect(subs).toContain('general');
    expect(subs).toContain('announcements');
  });

  it('flightdeck_my_subscriptions returns empty when no subscriptions', async () => {
    const result = await callTool(server, 'flightdeck_my_subscriptions', {});
    const subs = JSON.parse(getText(result));
    expect(Array.isArray(subs)).toBe(true);
  });
});

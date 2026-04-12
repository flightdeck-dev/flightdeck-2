import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketServer, type WebSocketClient } from '../../src/api/WebSocketServer.js';
import { DEFAULT_DISPLAY, DISPLAY_PRESETS } from '@flightdeck-ai/shared';

// Minimal MessageStore stub
function createMockMessageStore() {
  return {
    createMessage: vi.fn((input: any) => ({
      id: 'msg-1',
      threadId: input.threadId,
      parentId: input.parentId,
      taskId: input.taskId,
      authorType: input.authorType,
      authorId: input.authorId,
      content: input.content,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    })),
    createThread: vi.fn((input: any) => ({
      id: 'thread-1',
      title: input.title ?? null,
      originId: input.originId,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    })),
    listMessages: vi.fn(() => []),
    listThreads: vi.fn(() => []),
  } as any;
}

function createMockClient(id: string): WebSocketClient & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    id,
    send: (data: string) => sentMessages.push(data),
    sentMessages,
  };
}

describe('WebSocketServer display:config', () => {
  let ws: WebSocketServer;

  beforeEach(() => {
    ws = new WebSocketServer(createMockMessageStore());
  });

  it('sends default display config on client connect', () => {
    const client = createMockClient('c1');
    ws.addClient(client);

    expect(client.sentMessages.length).toBe(1);
    const event = JSON.parse(client.sentMessages[0]);
    expect(event.type).toBe('display:config');
    expect(event.config.thinking).toBe(false);
    expect(event.config.toolCalls).toBe('summary');
    expect(event.config.flightdeckTools).toBe('off');
  });

  it('handles display:config update from client', () => {
    const client = createMockClient('c1');
    ws.addClient(client);
    client.sentMessages.length = 0; // clear initial sync

    ws.handleEvent('c1', {
      type: 'display:config',
      config: { thinking: true, toolCalls: 'detail' },
    });

    expect(client.sentMessages.length).toBe(1);
    const event = JSON.parse(client.sentMessages[0]);
    expect(event.type).toBe('display:config');
    expect(event.config.thinking).toBe(true);
    expect(event.config.toolCalls).toBe('detail');
    expect(event.config.flightdeckTools).toBe('off'); // unchanged
  });

  it('stores per-client display configs independently', () => {
    const c1 = createMockClient('c1');
    const c2 = createMockClient('c2');
    ws.addClient(c1);
    ws.addClient(c2);

    ws.handleEvent('c1', {
      type: 'display:config',
      config: { thinking: true },
    });

    const config1 = ws.getDisplayConfig('c1');
    const config2 = ws.getDisplayConfig('c2');
    expect(config1.thinking).toBe(true);
    expect(config2.thinking).toBe(false);
  });

  it('cleans up config on client disconnect', () => {
    const client = createMockClient('c1');
    ws.addClient(client);
    ws.removeClient('c1');

    // Should return default for unknown client
    const config = ws.getDisplayConfig('c1');
    expect(config).toEqual(expect.objectContaining(DEFAULT_DISPLAY));
  });

  it('emits display:config event', () => {
    const client = createMockClient('c1');
    ws.addClient(client);

    const handler = vi.fn();
    ws.on('display:config', handler);

    ws.handleEvent('c1', {
      type: 'display:config',
      config: { thinking: true },
    });

    expect(handler).toHaveBeenCalledWith({
      clientId: 'c1',
      config: expect.objectContaining({ thinking: true }),
    });
  });

  it('rejects invalid display config', () => {
    const client = createMockClient('c1');
    ws.addClient(client);
    client.sentMessages.length = 0;

    ws.handleEvent('c1', {
      type: 'display:config',
      config: { toolCalls: 'invalid' as any },
    });

    // Should not send an update for invalid config
    expect(client.sentMessages.length).toBe(0);
  });

  it('streamChunk includes content_type and tool_name', () => {
    const client = createMockClient('c1');
    ws.addClient(client);
    client.sentMessages.length = 0;

    ws.streamChunk('msg-1', 'thinking...', false, 'thinking');
    ws.streamChunk('msg-1', 'tool call', false, 'tool_call', 'shell');
    ws.streamChunk('msg-1', 'fd tool', false, 'flightdeck_tool_call', 'flightdeck_task_list');

    expect(client.sentMessages.length).toBe(3);

    const e1 = JSON.parse(client.sentMessages[0]);
    expect(e1.content_type).toBe('thinking');
    expect(e1.tool_name).toBeUndefined();

    const e2 = JSON.parse(client.sentMessages[1]);
    expect(e2.content_type).toBe('tool_call');
    expect(e2.tool_name).toBe('shell');

    const e3 = JSON.parse(client.sentMessages[2]);
    expect(e3.content_type).toBe('flightdeck_tool_call');
    expect(e3.tool_name).toBe('flightdeck_task_list');
  });
});

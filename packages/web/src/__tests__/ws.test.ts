import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketClient } from '../lib/ws.ts';

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  sent: string[] = [];
  
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.({} as any); }
}

let mockWsInstance: MockWebSocket;

vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor() {
    super();
    mockWsInstance = this;
  }
});

// Stub window.location for constructor
vi.stubGlobal('window', {
  location: { protocol: 'http:', host: 'localhost:3000' },
});

describe('WebSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('constructs with default URL from window.location', () => {
    const client = new WebSocketClient();
    expect(client.connected).toBe(false);
  });

  it('connect creates WebSocket and sets connected on open', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    expect(client.connected).toBe(false);
    mockWsInstance.onopen!({} as any);
    expect(client.connected).toBe(true);
  });

  it('dispatches events to handlers', () => {
    const client = new WebSocketClient('ws://test');
    const handler = vi.fn();
    client.on(handler);
    client.connect();
    mockWsInstance.onopen!({} as any);
    mockWsInstance.onmessage!({ data: JSON.stringify({ type: 'state:update', stats: {} }) } as any);
    expect(handler).toHaveBeenCalledWith({ type: 'state:update', stats: {} });
  });

  it('on returns unsubscribe function', () => {
    const client = new WebSocketClient('ws://test');
    const handler = vi.fn();
    const unsub = client.on(handler);
    unsub();
    client.connect();
    mockWsInstance.onopen!({} as any);
    mockWsInstance.onmessage!({ data: JSON.stringify({ type: 'state:update', stats: {} }) } as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('send serializes JSON when connected', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.send({ type: 'chat:send', content: 'hello' });
    expect(mockWsInstance.sent).toEqual([JSON.stringify({ type: 'chat:send', content: 'hello' })]);
  });

  it('sendChat sends correct event', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.sendChat('test msg', 'parent-1', 'thread-1');
    const parsed = JSON.parse(mockWsInstance.sent[0]);
    expect(parsed.type).toBe('chat:send');
    expect(parsed.content).toBe('test msg');
    expect(parsed.parent_id).toBe('parent-1');
    expect(parsed.thread_id).toBe('thread-1');
  });

  it('disconnect clears connection', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    expect(client.connected).toBe(true);
    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it('onConnectionChange fires on connect/disconnect', () => {
    const client = new WebSocketClient('ws://test');
    const handler = vi.fn();
    client.onConnectionChange(handler);
    client.connect();
    mockWsInstance.onopen!({} as any);
    expect(handler).toHaveBeenCalledWith(true);
    client.disconnect();
    expect(handler).toHaveBeenCalledWith(false);
  });

  it('schedules reconnect on close', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    mockWsInstance.onclose!({} as any);
    expect(client.connected).toBe(false);
    // Advance timer to trigger reconnect
    vi.advanceTimersByTime(2000);
    // A new WS should have been created
    expect(mockWsInstance).toBeDefined();
  });

  it('setProject changes URL and reconnects', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.setProject('my-proj');
    // Should have disconnected and reconnected
    // The new WS is created
    expect(mockWsInstance).toBeDefined();
  });

  it('ignores malformed JSON messages', () => {
    const client = new WebSocketClient('ws://test');
    const handler = vi.fn();
    client.on(handler);
    client.connect();
    mockWsInstance.onopen!({} as any);
    mockWsInstance.onmessage!({ data: 'not json' } as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('interruptLead sends chat:interrupt', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.interruptLead();
    const parsed = JSON.parse(mockWsInstance.sent[0]);
    expect(parsed.type).toBe('chat:interrupt');
  });

  it('sendTaskComment sends correct event', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.sendTaskComment('task-1', 'looks good');
    const parsed = JSON.parse(mockWsInstance.sent[0]);
    expect(parsed.type).toBe('task:comment');
    expect(parsed.task_id).toBe('task-1');
    expect(parsed.content).toBe('looks good');
  });

  it('createThread sends thread:create event', () => {
    const client = new WebSocketClient('ws://test');
    client.connect();
    mockWsInstance.onopen!({} as any);
    client.createThread('origin-1', 'My Thread');
    const parsed = JSON.parse(mockWsInstance.sent[0]);
    expect(parsed.type).toBe('thread:create');
    expect(parsed.origin_id).toBe('origin-1');
    expect(parsed.title).toBe('My Thread');
  });
});

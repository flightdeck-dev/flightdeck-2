import type { ChatMessage, Thread } from './types.ts';
import type { DisplayConfig, ContentType } from '@flightdeck-ai/shared/display';
import { WS_INITIAL_BACKOFF_MS, WS_MAX_BACKOFF_MS } from './constants.ts';

export type WsEvent =
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:stream'; message_id: string; delta: string; done: boolean; content_type?: ContentType; tool_name?: string }
  | { type: 'thread:created'; thread: Thread }
  | { type: 'task:comment'; task_id: string; message: ChatMessage }
  | { type: 'display:config'; config: DisplayConfig }
  | { type: 'state:update'; stats: Record<string, number> }
  | { type: 'agent:stream'; agentId: string; delta: string; contentType: 'text' | 'thinking' | 'tool_call' | 'tool_result'; toolName?: string };

type EventHandler = (event: WsEvent) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private connectionHandlers = new Set<(connected: boolean) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private url: string;
  private _connected = false;
  private backoffMs = WS_INITIAL_BACKOFF_MS;

  constructor(url?: string) {
    const loc = window.location;
    this.baseUrl = url ?? `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`;
    this.url = this.baseUrl;
  }

  setProject(projectName: string): void {
    this.url = `${this.baseUrl}/ws/${encodeURIComponent(projectName)}`;
    // Reconnect if already connected
    if (this.ws) {
      this.disconnect();
      this.connect();
    }
  }

  get connected() { return this._connected; }

  connect(): void {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this._connected = true;
        this.backoffMs = WS_INITIAL_BACKOFF_MS;
        for (const h of this.connectionHandlers) h(true);
      };
      this.ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WsEvent;
          for (const h of this.handlers) h(event);
        } catch { /* ignore malformed */ }
      };
      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
        for (const h of this.connectionHandlers) h(false);
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    for (const h of this.connectionHandlers) h(false);
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => { this.connectionHandlers.delete(handler); };
  }

  send(event: { type: string; [k: string]: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendChat(content: string, parentId?: string, threadId?: string): void {
    this.send({ type: 'chat:send', content, parent_id: parentId, thread_id: threadId });
  }

  sendTaskComment(taskId: string, content: string): void {
    this.send({ type: 'task:comment', task_id: taskId, content });
  }

  sendDisplayConfig(config: Partial<DisplayConfig>): void {
    this.send({ type: 'display:config', config });
  }

  createThread(originId: string, title?: string): void {
    this.send({ type: 'thread:create', origin_id: originId, title });
  }

  interruptLead(): void {
    this.send({ type: 'chat:interrupt' });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, WS_MAX_BACKOFF_MS);
  }
}

// Singleton
export const wsClient = new WebSocketClient();

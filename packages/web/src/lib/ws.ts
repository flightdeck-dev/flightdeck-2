import type { ChatMessage, Thread } from './types.ts';

export type WsEvent =
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:stream'; message_id: string; delta: string; done: boolean }
  | { type: 'thread:created'; thread: Thread }
  | { type: 'task:comment'; task_id: string; message: ChatMessage };

type EventHandler = (event: WsEvent) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private _connected = false;

  constructor(url?: string) {
    const loc = window.location;
    this.url = url ?? `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`;
  }

  get connected() { return this._connected; }

  connect(): void {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { this._connected = true; };
      this.ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WsEvent;
          for (const h of this.handlers) h(event);
        } catch { /* ignore malformed */ }
      };
      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
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
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
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

  createThread(originId: string, title?: string): void {
    this.send({ type: 'thread:create', origin_id: originId, title });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

// Singleton
export const wsClient = new WebSocketClient();

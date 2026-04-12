import { EventEmitter } from 'node:events';
import type { MessageStore, ChatMessage, Thread } from '../comms/MessageStore.js';
import { type DisplayConfig, DEFAULT_DISPLAY, mergeDisplayConfig, isValidDisplayConfig, shouldShow, type ContentType } from '@flightdeck-ai/shared';

/**
 * WebSocket event types flowing between UI and server.
 */

// UI → Server
export interface ChatSendEvent {
  type: 'chat:send';
  content: string;
  parent_id?: string;
  thread_id?: string;
}

export interface ThreadCreateEvent {
  type: 'thread:create';
  origin_id: string;
  title?: string;
}

export interface TaskCommentSendEvent {
  type: 'task:comment';
  task_id: string;
  content: string;
  parent_id?: string;
}

export interface DisplayConfigUpdateEvent {
  type: 'display:config';
  config: Partial<DisplayConfig>;
}

export type IncomingEvent = ChatSendEvent | ThreadCreateEvent | TaskCommentSendEvent | DisplayConfigUpdateEvent;

// Server → UI
export interface ChatMessageEvent {
  type: 'chat:message';
  message: ChatMessage;
}

export interface ChatStreamEvent {
  type: 'chat:stream';
  message_id: string;
  delta: string;
  done: boolean;
  /** Content classification for display filtering */
  content_type?: ContentType;
  /** Tool name when content_type is tool-related */
  tool_name?: string;
}

export interface DisplayConfigSyncEvent {
  type: 'display:config';
  config: DisplayConfig;
}

export interface ThreadCreatedEvent {
  type: 'thread:created';
  thread: Thread;
}

export interface TaskCommentReceivedEvent {
  type: 'task:comment';
  task_id: string;
  message: ChatMessage;
}

export type OutgoingEvent = ChatMessageEvent | ChatStreamEvent | ThreadCreatedEvent | TaskCommentReceivedEvent | DisplayConfigSyncEvent;

export interface WebSocketClient {
  id: string;
  send(data: string): void;
}

/**
 * WebSocket server that bridges the Web UI and the Flightdeck daemon.
 * 
 * This is transport-agnostic — it manages client connections and event routing.
 * The actual WebSocket transport (ws, uWebSockets, etc.) is injected by the caller.
 */
export class WebSocketServer extends EventEmitter {
  private clients = new Map<string, WebSocketClient>();
  private clientDisplayConfigs = new Map<string, DisplayConfig>();

  constructor(private messageStore: MessageStore) {
    super();
  }

  /** Register a connected client */
  addClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
    this.clientDisplayConfigs.set(client.id, { ...DEFAULT_DISPLAY });
    // Send current display config to new client
    this.sendTo(client.id, { type: 'display:config', config: this.clientDisplayConfigs.get(client.id)! });
  }

  /** Remove a disconnected client */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.clientDisplayConfigs.delete(clientId);
  }

  /** Handle an incoming event from a UI client */
  handleEvent(clientId: string, event: IncomingEvent): void {
    switch (event.type) {
      case 'chat:send':
        if (typeof event.content !== 'string') return;
        this.handleChatSend(event);
        break;
      case 'thread:create':
        if (!event.origin_id) return;
        this.handleThreadCreate(event);
        break;
      case 'task:comment':
        if (!event.task_id || typeof event.content !== 'string') return;
        this.handleTaskComment(event);
        break;
      case 'display:config':
        this.handleDisplayConfig(clientId, event);
        break;
    }
  }

  /** Get display config for a client */
  getDisplayConfig(clientId: string): DisplayConfig {
    return this.clientDisplayConfigs.get(clientId) ?? { ...DEFAULT_DISPLAY };
  }

  /** Set display config for a client */
  setDisplayConfig(clientId: string, config: DisplayConfig): void {
    this.clientDisplayConfigs.set(clientId, config);
  }

  /** Broadcast an event to all connected clients */
  broadcast(event: OutgoingEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients.values()) {
      client.send(data);
    }
  }

  /** Send an event to a specific client */
  sendTo(clientId: string, event: OutgoingEvent): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.send(JSON.stringify(event));
    }
  }

  /** Stream a Lead response chunk to clients, filtering per client display config */
  streamChunk(messageId: string, delta: string, done: boolean, contentType?: ContentType, toolName?: string): void {
    const event: ChatStreamEvent = {
      type: 'chat:stream',
      message_id: messageId,
      delta,
      done,
      content_type: contentType,
      tool_name: toolName,
    };
    // If no content type, broadcast to all (e.g. plain text chunks)
    if (!contentType) {
      this.broadcast(event);
      return;
    }
    const data = JSON.stringify(event);
    for (const [clientId, client] of this.clients.entries()) {
      const config = this.clientDisplayConfigs.get(clientId) ?? { ...DEFAULT_DISPLAY };
      if (shouldShow(config, contentType, toolName)) {
        client.send(data);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private handleChatSend(event: ChatSendEvent): void {
    const msg = this.messageStore.createMessage({
      threadId: event.thread_id ?? null,
      parentId: event.parent_id ?? null,
      taskId: null,
      authorType: 'user',
      authorId: 'user',
      content: event.content,
      metadata: null,
    });

    // Broadcast to all clients
    this.broadcast({ type: 'chat:message', message: msg });

    // Emit for daemon to route to Lead
    this.emit('user:message', msg);
  }

  private handleThreadCreate(event: ThreadCreateEvent): void {
    const thread = this.messageStore.createThread({
      originId: event.origin_id,
      title: event.title,
    });

    this.broadcast({ type: 'thread:created', thread });
    this.emit('thread:created', thread);
  }

  private handleDisplayConfig(clientId: string, event: DisplayConfigUpdateEvent): void {
    if (!isValidDisplayConfig(event.config)) return;
    const current = this.clientDisplayConfigs.get(clientId) ?? { ...DEFAULT_DISPLAY };
    const updated = mergeDisplayConfig(current, event.config);
    this.clientDisplayConfigs.set(clientId, updated);
    this.sendTo(clientId, { type: 'display:config', config: updated });
    this.emit('display:config', { clientId, config: updated });
  }

  private handleTaskComment(event: TaskCommentSendEvent): void {
    const msg = this.messageStore.createMessage({
      threadId: null,
      parentId: event.parent_id ?? null,
      taskId: event.task_id,
      authorType: 'user',
      authorId: 'user',
      content: event.content,
      metadata: null,
    });

    this.broadcast({
      type: 'task:comment',
      task_id: event.task_id,
      message: msg,
    });

    // Emit for daemon to route to Lead
    this.emit('task:comment', { taskId: event.task_id, message: msg });
  }
}

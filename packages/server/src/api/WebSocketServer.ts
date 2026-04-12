import { EventEmitter } from 'node:events';
import type { MessageStore, ChatMessage, Thread } from '../comms/MessageStore.js';

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

export type IncomingEvent = ChatSendEvent | ThreadCreateEvent | TaskCommentSendEvent;

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

export type OutgoingEvent = ChatMessageEvent | ChatStreamEvent | ThreadCreatedEvent | TaskCommentReceivedEvent;

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

  constructor(private messageStore: MessageStore) {
    super();
  }

  /** Register a connected client */
  addClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
  }

  /** Remove a disconnected client */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** Handle an incoming event from a UI client */
  handleEvent(clientId: string, event: IncomingEvent): void {
    switch (event.type) {
      case 'chat:send':
        this.handleChatSend(event);
        break;
      case 'thread:create':
        this.handleThreadCreate(event);
        break;
      case 'task:comment':
        this.handleTaskComment(event);
        break;
    }
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

  /** Stream a Lead response chunk to all clients */
  streamChunk(messageId: string, delta: string, done: boolean): void {
    this.broadcast({
      type: 'chat:stream',
      message_id: messageId,
      delta,
      done,
    });
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

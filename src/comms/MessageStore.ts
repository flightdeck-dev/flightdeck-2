// Unified Communication Module
// Inspired by: Flightdeck 1.0 comms (persistent messaging), beads (messaging-as-issue-type)
// Key principle: NO in-memory-only messages. Everything persists.

import {
  type Message, type MessageId, type MessageType, type MessagePriority,
  type DeliveryStatus, type AgentId,
  messageId,
} from '../core/types.js';

export interface SendMessageInput {
  type: MessageType;
  priority?: MessagePriority;
  from: AgentId;
  to: AgentId[];
  content: string;
  threadId?: MessageId;
  replyTo?: MessageId;
}

export interface MessageQuery {
  participantId?: AgentId;
  threadId?: MessageId;
  priority?: MessagePriority;
  type?: MessageType;
  since?: Date;
  limit?: number;
}

export class MessageStore {
  private messages: Map<MessageId, Message> = new Map();
  // Thread index: threadId → message IDs
  private threads: Map<MessageId, MessageId[]> = new Map();
  // Inbox index: agentId → message IDs (for fast lookup)
  private inbox: Map<string, MessageId[]> = new Map();

  send(input: SendMessageInput): Message {
    const id = messageId();
    const now = new Date();

    const msg: Message = {
      id,
      type: input.type,
      priority: input.priority ?? 'normal',
      from: input.from,
      to: input.to,
      content: input.content,
      threadId: input.threadId,
      replyTo: input.replyTo,
      deliveryStatus: 'sent',
      createdAt: now,
    };

    this.messages.set(id, msg);

    // Thread indexing
    const threadKey = input.threadId ?? id;
    if (!this.threads.has(threadKey)) {
      this.threads.set(threadKey, []);
    }
    this.threads.get(threadKey)!.push(id);

    // Inbox indexing
    for (const recipient of input.to) {
      const key = recipient as string;
      if (!this.inbox.has(key)) {
        this.inbox.set(key, []);
      }
      this.inbox.get(key)!.push(id);
    }

    return msg;
  }

  getMessage(id: MessageId): Message | undefined {
    return this.messages.get(id);
  }

  markDelivered(id: MessageId): void {
    const msg = this.messages.get(id);
    if (msg) msg.deliveryStatus = 'delivered';
  }

  markRead(id: MessageId): void {
    const msg = this.messages.get(id);
    if (msg) {
      msg.deliveryStatus = 'read';
      msg.readAt = new Date();
    }
  }

  getThread(threadId: MessageId): Message[] {
    const ids = this.threads.get(threadId) ?? [];
    return ids.map(id => this.messages.get(id)!).filter(Boolean)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  getInbox(agentId: AgentId, opts?: { unreadOnly?: boolean; priority?: MessagePriority }): Message[] {
    const ids = this.inbox.get(agentId as string) ?? [];
    let messages = ids.map(id => this.messages.get(id)!).filter(Boolean);

    if (opts?.unreadOnly) {
      messages = messages.filter(m => m.deliveryStatus !== 'read');
    }
    if (opts?.priority) {
      messages = messages.filter(m => m.priority === opts.priority);
    }

    return messages.sort((a, b) => {
      // Critical first, then by time
      const priorityOrder = { critical: 0, normal: 1, low: 2 };
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  }

  query(q: MessageQuery): Message[] {
    let results = Array.from(this.messages.values());

    if (q.participantId) {
      results = results.filter(m =>
        m.from === q.participantId || m.to.includes(q.participantId!),
      );
    }
    if (q.threadId) {
      results = results.filter(m => m.threadId === q.threadId);
    }
    if (q.priority) {
      results = results.filter(m => m.priority === q.priority);
    }
    if (q.type) {
      results = results.filter(m => m.type === q.type);
    }
    if (q.since) {
      results = results.filter(m => m.createdAt >= q.since!);
    }

    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (q.limit) {
      results = results.slice(0, q.limit);
    }

    return results;
  }

  /** Coalesce low-priority messages in a thread into a summary */
  coalesceLowPriority(threadId: MessageId): Message | null {
    const thread = this.getThread(threadId);
    const lowPri = thread.filter(m => m.priority === 'low' && m.deliveryStatus === 'sent');
    if (lowPri.length < 2) return null;

    const summary = this.send({
      type: 'system',
      priority: 'low',
      from: lowPri[0].from,
      to: lowPri[0].to,
      content: `[Coalesced ${lowPri.length} messages]: ${lowPri.map(m => m.content).join(' | ')}`,
      threadId,
    });

    // Mark originals as read
    for (const msg of lowPri) {
      this.markRead(msg.id);
    }

    return summary;
  }
}

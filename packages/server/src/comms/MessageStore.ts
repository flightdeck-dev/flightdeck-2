import { eq, desc, and, lt, isNull, isNotNull } from 'drizzle-orm';
import { messages, threads } from '../db/schema.js';
import type { FlightdeckDatabase } from '../db/database.js';
import { messageId } from '@flightdeck-ai/shared';

export interface ChatMessage {
  id: string;
  threadId: string | null;
  parentId: string | null;
  taskId: string | null;
  authorType: 'user' | 'lead' | 'agent' | 'system';
  authorId: string | null;
  content: string;
  metadata: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Thread {
  id: string;
  title: string | null;
  originId: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export class MessageStore {
  constructor(private db: FlightdeckDatabase) {}

  createMessage(msg: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ChatMessage {
    const now = new Date().toISOString();
    const id = msg.id ?? messageId(msg.authorId ?? 'anon', now, Math.random().toString());
    const record: ChatMessage = {
      id,
      threadId: msg.threadId ?? null,
      parentId: msg.parentId ?? null,
      taskId: msg.taskId ?? null,
      authorType: msg.authorType,
      authorId: msg.authorId ?? null,
      content: msg.content,
      metadata: msg.metadata ?? null,
      createdAt: now,
      updatedAt: null,
    };
    this.db.insert(messages).values(record).run();
    return record;
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    return (row as ChatMessage) ?? null;
  }

  listMessages(opts: { threadId?: string; taskId?: string; before?: string; limit?: number } = {}): ChatMessage[] {
    const conditions = [];
    if (opts.threadId !== undefined) {
      conditions.push(eq(messages.threadId, opts.threadId));
    }
    if (opts.taskId !== undefined) {
      conditions.push(eq(messages.taskId, opts.taskId));
    }
    if (opts.before) {
      conditions.push(lt(messages.createdAt, opts.before));
    }
    const limit = opts.limit ?? 50;
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();
    return rows as ChatMessage[];
  }

  createThread(opts: { originId: string; title?: string }): Thread {
    const now = new Date().toISOString();
    const id = messageId('thread', opts.originId, now);
    const record: Thread = {
      id,
      title: opts.title ?? null,
      originId: opts.originId,
      createdAt: now,
      archivedAt: null,
    };
    this.db.insert(threads).values(record).run();
    return record;
  }

  getThread(id: string): Thread | null {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    return (row as Thread) ?? null;
  }

  listThreads(opts: { archived?: boolean; limit?: number } = {}): Thread[] {
    const conditions = [];
    if (opts.archived === true) {
      conditions.push(isNotNull(threads.archivedAt));
    } else if (opts.archived === false) {
      conditions.push(isNull(threads.archivedAt));
    }
    const limit = opts.limit ?? 50;
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db
      .select()
      .from(threads)
      .where(where)
      .orderBy(desc(threads.createdAt))
      .limit(limit)
      .all();
    return rows as Thread[];
  }
}

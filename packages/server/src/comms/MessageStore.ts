import { eq, desc, and, lt, gt, isNull, isNotNull, sql } from 'drizzle-orm';
import { messages, threads, readState } from '../db/schema.js';
import type { FlightdeckDatabase } from '../db/database.js';
import { messageId } from '@flightdeck-ai/shared';

export interface ChatMessage {
  id: string;
  threadId: string | null;
  parentId: string | null;
  parentIds?: string[] | null;
  taskId: string | null;
  authorType: 'user' | 'lead' | 'agent' | 'system';
  authorId: string | null;
  content: string;
  metadata: string | null;
  channel: string | null;
  recipient: string | null;
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

  createMessage(msg: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt' | 'channel' | 'recipient'> & { id?: string; channel?: string | null; recipient?: string | null }): ChatMessage {
    const now = new Date().toISOString();
    const id = msg.id ?? messageId(msg.authorId ?? 'anon', now, Math.random().toString());
    const record: ChatMessage = {
      id,
      threadId: msg.threadId ?? null,
      parentId: msg.parentId ?? null,
      parentIds: msg.parentIds ?? null,
      taskId: msg.taskId ?? null,
      authorType: msg.authorType,
      authorId: msg.authorId ?? null,
      content: msg.content,
      metadata: msg.metadata ?? null,
      channel: (msg as any).channel ?? null,
      recipient: (msg as any).recipient ?? null,
      createdAt: now,
      updatedAt: null,
    };
    // Store parentIds as JSON string for SQLite
    const dbRecord = { ...record, parentIds: record.parentIds ? JSON.stringify(record.parentIds) : null } as any;
    this.db.insert(messages).values(dbRecord).run();
    // Index in FTS5 for full-text search
    try {
      this.db.run(sql`INSERT INTO messages_fts (id, author_type, author_id, content) VALUES (${id}, ${record.authorType}, ${record.authorId}, ${record.content})`);
    } catch { /* FTS table may not exist in test environments */ }
    return record;
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) return null;
    return this.hydrateMessage(row as any);
  }

  /** Parse parentIds from JSON string back to array */
  private hydrateMessage(row: any): ChatMessage {
    return {
      ...row,
      parentIds: row.parentIds ? JSON.parse(row.parentIds) : null,
    };
  }

  listMessages(opts: { threadId?: string; taskId?: string; before?: string; limit?: number; authorTypes?: string[] } = {}): ChatMessage[] {
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
    if (opts.authorTypes && opts.authorTypes.length > 0) {
      conditions.push(sql`${messages.authorType} IN (${sql.join(opts.authorTypes.map(t => sql`${t}`), sql`, `)})`);
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
    return rows.map(r => this.hydrateMessage(r as any));
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

  /**
   * Collect all messages from a thread and produce a summary string (FR-021b).
   * Returns the concatenated thread content for summarization.
   */
  collectThread(threadId: string): { thread: Thread | null; messages: ChatMessage[]; digest: string } {
    const thread = this.getThread(threadId);
    const msgs = this.listMessages({ threadId, limit: 1000 });
    // Reverse to chronological order
    msgs.reverse();
    const lines = msgs.map(m => `[${m.authorType}${m.authorId ? ':' + m.authorId : ''}] ${m.content}`);
    const digest = lines.join('\n');
    return { thread, messages: msgs, digest };
  }

  /**
   * Summarize a thread's discussion (FR-021b).
   * Returns a summary string from the thread content.
   * The caller should store this in the DecisionLog.
   */
  summarizeThread(threadId: string): { summary: string; messageCount: number } {
    const { thread, messages, digest } = this.collectThread(threadId);
    if (messages.length === 0) {
      return { summary: 'No messages in thread.', messageCount: 0 };
    }
    const title = thread?.title ?? 'Untitled thread';
    const participants = [...new Set(messages.map(m => m.authorId ?? m.authorType))];
    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    // Auto-generated summary (without LLM — structured extract)
    const summary = [
      `## Thread Summary: ${title}`,
      `Participants: ${participants.join(', ')}`,
      `Messages: ${messages.length}`,
      `Duration: ${firstMsg.createdAt} → ${lastMsg.createdAt}`,
      '',
      `### Key content`,
      digest.length > 2000 ? digest.slice(0, 2000) + '...' : digest,
    ].join('\n');
    return { summary, messageCount: messages.length };
  }

  /**
   * Full-text search across chat messages using FTS5.
   * Returns matching messages ranked by relevance.
   */
  searchMessages(query: string, opts: { authorType?: string; limit?: number } = {}): ChatMessage[] {
    const limit = opts.limit ?? 20;
    // Sanitize query for FTS5: wrap each term in quotes
    const sanitized = query
      .replace(/"/g, '""')
      .split(/\s+/)
      .filter(Boolean)
      .map(term => `"${term}"`)
      .join(' ');
    if (!sanitized) return [];

    try {
      // Use parameterized queries to prevent SQL injection
      let rows: Array<{ id: string }>;
      if (opts.authorType) {
        rows = this.db.all(
          sql`SELECT id FROM messages_fts WHERE content MATCH ${sanitized} AND author_type = ${opts.authorType} ORDER BY rank LIMIT ${limit}`,
        ) as Array<{ id: string }>;
      } else {
        rows = this.db.all(
          sql`SELECT id FROM messages_fts WHERE content MATCH ${sanitized} ORDER BY rank LIMIT ${limit}`,
        ) as Array<{ id: string }>;
      }
      if (rows.length === 0) return [];

      // Fetch full message records
      const results: ChatMessage[] = [];
      for (const row of rows) {
        const msg = this.getMessage(row.id);
        if (msg) results.push(msg);
      }
      return results;
    } catch {
      // FTS table may not exist; fall back to LIKE search
      const pattern = `%${query}%`;
      const rows = this.db
        .select()
        .from(messages)
        .where(sql`content LIKE ${pattern}`)
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .all();
      return rows.map(r => this.hydrateMessage(r as any));
    }
  }

  // ── Channel messages ─────────────────────────────────────────────────

  appendChannelMessage(channel: string, msg: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt'>): ChatMessage {
    return this.createMessage({ ...msg, channel, recipient: null });
  }

  listChannelMessages(channel: string, since?: string, limit?: number): ChatMessage[] {
    const conditions = [eq(messages.channel, channel)];
    if (since) conditions.push(gt(messages.createdAt, since));
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit ?? 100)
      .all();
    return rows.map(r => this.hydrateMessage(r as any));
  }

  listChannels(): string[] {
    const rows = this.db
      .selectDistinct({ channel: messages.channel })
      .from(messages)
      .where(isNotNull(messages.channel))
      .all();
    return rows.map(r => r.channel!).filter(Boolean);
  }

  // ── DM ────────────────────────────────────────────────────────────────

  appendDM(from: string, to: string, content: string): ChatMessage {
    return this.createMessage({
      threadId: null,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: from,
      content,
      metadata: null,
      channel: 'dm',
      recipient: to,
    });
  }

  getUnreadDMs(agentId: string): ChatMessage[] {
    const lastRead = this.getLastRead(agentId);
    const conditions = [
      eq(messages.recipient, agentId),
      eq(messages.channel, 'dm'),
    ];
    if (lastRead) conditions.push(gt(messages.createdAt, lastRead));
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(messages.createdAt)
      .all();
    return rows.map(r => this.hydrateMessage(r as any));
  }

  markRead(agentId: string): void {
    const now = new Date().toISOString();
    this.db.insert(readState)
      .values({ agentId, lastReadAt: now })
      .onConflictDoUpdate({ target: readState.agentId, set: { lastReadAt: now } })
      .run();
  }

  getLastRead(agentId: string): string | null {
    const row = this.db.select().from(readState).where(eq(readState.agentId, agentId)).get();
    return row?.lastReadAt ?? null;
  }
}

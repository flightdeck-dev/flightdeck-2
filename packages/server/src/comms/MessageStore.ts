import { eq, desc, and, or, lt, gt, isNotNull, sql } from 'drizzle-orm';
import { messages, readState, channelSubscriptions, channels } from '../db/schema.js';
import type { FlightdeckDatabase } from '../db/database.js';
import { messageId } from '@flightdeck-ai/shared';

export interface ChatMessage {
  id: string;
  parentId: string | null;
  parentIds?: string[] | null;
  taskId: string | null;
  authorType: 'user' | 'lead' | 'agent' | 'system';
  authorId: string | null;
  content: string;
  metadata: string | null;
  channel: string | null;
  recipient: string | null;
  source?: 'web' | 'discord' | 'slack' | 'telegram' | 'tui' | 'api' | null;
  senderId?: string | null;
  senderName?: string | null;
  replyToId?: string | null;
  replyPreview?: string | null;
  attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }> | null;
  channelId?: string | null;
  mentions?: string[] | null;
  mentioned?: boolean; // flag when reading: true if the reader is mentioned
  createdAt: string;
  updatedAt: string | null;
}

export class MessageStore {
  constructor(private db: FlightdeckDatabase) {}

  createMessage(msg: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt' | 'channel' | 'recipient' | 'replyPreview' | 'mentioned'> & { id?: string; channel?: string | null; recipient?: string | null; source?: string | null; senderId?: string | null; senderName?: string | null; replyToId?: string | null; attachments?: any[] | null; channelId?: string | null; mentions?: string[] | null }): ChatMessage {
    const now = new Date().toISOString();
    const id = msg.id ?? messageId(msg.authorId ?? 'anon', now, Math.random().toString());
    const record: ChatMessage = {
      id,
      parentId: msg.parentId ?? null,
      parentIds: msg.parentIds ?? null,
      taskId: msg.taskId ?? null,
      authorType: msg.authorType,
      authorId: msg.authorId ?? null,
      content: msg.content,
      metadata: msg.metadata ?? null,
      channel: (msg as any).channel ?? null,
      recipient: (msg as any).recipient ?? null,
      source: (msg as any).source ?? null,
      senderId: (msg as any).senderId ?? null,
      senderName: (msg as any).senderName ?? null,
      replyToId: (msg as any).replyToId ?? null,
      attachments: (msg as any).attachments ?? null,
      channelId: (msg as any).channelId ?? null,
      mentions: (msg as any).mentions ?? null,
      createdAt: now,
      updatedAt: null,
    };
    // Store parentIds, attachments, and mentions as JSON strings for SQLite
    const dbRecord = {
      ...record,
      parentIds: record.parentIds ? JSON.stringify(record.parentIds) : null,
      attachments: record.attachments ? JSON.stringify(record.attachments) : null,
      mentions: record.mentions ? JSON.stringify(record.mentions) : null,
    } as any;
    delete dbRecord.replyPreview;
    try {
      this.db.insert(messages).values(dbRecord).run();
    } catch (err: unknown) {
      // Retry once with a fresh ID on unique constraint collision
      if (err && typeof err === 'object' && 'code' in err && (err as any).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        const freshId = messageId(msg.authorId ?? 'anon', now, Math.random().toString(), Math.random().toString());
        record.id = freshId;
        dbRecord.id = freshId;
        this.db.insert(messages).values(dbRecord).run();
      } else {
        throw err;
      }
    }
    // Index in FTS5 for full-text search
    try {
      this.db.run(sql`INSERT INTO messages_fts (id, author_type, author_id, content) VALUES (${id}, ${record.authorType}, ${record.authorId}, ${record.content})`);
    } catch { /* FTS table may not exist in test environments */ }
    return record;
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) return null;
    const msg = this.hydrateMessage(row as any);
    if (msg.replyToId) {
      const referenced = this.db.select().from(messages).where(eq(messages.id, msg.replyToId)).get();
      if (referenced) {
        msg.replyPreview = (referenced as any).content.length > 200
          ? (referenced as any).content.slice(0, 200) + '…'
          : (referenced as any).content;
      }
    }
    return msg;
  }

  /** Parse parentIds, attachments, and mentions from JSON string back to array */
  private hydrateMessage(row: any, readerId?: string): ChatMessage {
    const mentions = row.mentions ? JSON.parse(row.mentions) : null;
    return {
      ...row,
      parentIds: row.parentIds ? JSON.parse(row.parentIds) : null,
      attachments: row.attachments ? JSON.parse(row.attachments) : null,
      mentions,
      mentioned: readerId && mentions ? mentions.includes(readerId) : undefined,
    };
  }

  /** Attach replyPreview to messages that have replyToId */
  private attachReplyPreviews(msgs: ChatMessage[]): ChatMessage[] {
    for (const msg of msgs) {
      if (msg.replyToId) {
        const referenced = this.getMessage(msg.replyToId);
        if (referenced) {
          msg.replyPreview = referenced.content.length > 200
            ? referenced.content.slice(0, 200) + '…'
            : referenced.content;
        }
      }
    }
    return msgs;
  }

  listMessages(opts: { taskId?: string; before?: string; limit?: number; authorTypes?: string[] } = {}): ChatMessage[] {
    const conditions = [];
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

  appendChannelMessage(channel: string, msg: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt' | 'replyPreview' | 'mentioned'>): ChatMessage {
    const result = this.createMessage({ ...msg, channel, recipient: null });
    // Auto-subscribe the sender
    if (msg.authorId) {
      this.subscribe(msg.authorId, channel);
    }
    return result;
  }

  listChannelMessages(channel: string, since?: string, limit?: number, readerId?: string): ChatMessage[] {
    const conditions = [eq(messages.channel, channel)];
    if (since) conditions.push(gt(messages.createdAt, since));
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit ?? 100)
      .all();
    return this.attachReplyPreviews(rows.map(r => this.hydrateMessage(r as any, readerId)));
  }

  listChannels(includeArchived = false): string[] {
    // Get channels from messages
    const msgRows = this.db
      .selectDistinct({ channel: messages.channel })
      .from(messages)
      .where(isNotNull(messages.channel))
      .all();
    const fromMessages = new Set(msgRows.map(r => r.channel!).filter(Boolean));

    // Get channels from registry
    const conditions = includeArchived ? undefined : eq(channels.archived, false);
    const registeredRows = this.db.select({ name: channels.name }).from(channels).where(conditions).all();
    for (const r of registeredRows) fromMessages.add(r.name);

    // Filter out archived channels (from registry) unless includeArchived
    if (!includeArchived) {
      const archivedRows = this.db.select({ name: channels.name }).from(channels).where(eq(channels.archived, true)).all();
      const archivedSet = new Set(archivedRows.map(r => r.name));
      for (const ch of archivedSet) fromMessages.delete(ch);
    }

    return [...fromMessages];
  }

  // ── Channel Registry ────────────────────────────────────────────

  createChannel(name: string, opts?: { description?: string; createdBy?: string }): { name: string; description: string | null; archived: boolean } {
    const now = new Date().toISOString();
    this.db.insert(channels)
      .values({ name, description: opts?.description ?? null, createdBy: opts?.createdBy ?? null, createdAt: now })
      .onConflictDoNothing()
      .run();
    return { name, description: opts?.description ?? null, archived: false };
  }

  archiveChannel(name: string): boolean {
    const result = this.db.update(channels)
      .set({ archived: true })
      .where(eq(channels.name, name))
      .run();
    return (result as any).changes > 0;
  }

  getChannel(name: string): { name: string; description: string | null; archived: boolean; createdBy: string | null } | null {
    const row = this.db.select().from(channels).where(eq(channels.name, name)).get();
    return row ?? null;
  }

  // ── Channel Subscriptions ─────────────────────────────────────────────

  subscribe(agentId: string, channel: string): void {
    const now = new Date().toISOString();
    try {
      this.db.insert(channelSubscriptions)
        .values({ agentId, channel, subscribedAt: now })
        .onConflictDoNothing()
        .run();
    } catch { /* already subscribed */ }
  }

  unsubscribe(agentId: string, channel: string): void {
    this.db.delete(channelSubscriptions)
      .where(and(eq(channelSubscriptions.agentId, agentId), eq(channelSubscriptions.channel, channel)))
      .run();
  }

  getSubscriptions(agentId: string): string[] {
    const rows = this.db.select({ channel: channelSubscriptions.channel })
      .from(channelSubscriptions)
      .where(eq(channelSubscriptions.agentId, agentId))
      .all();
    return rows.map(r => r.channel);
  }

  getSubscribers(channel: string): string[] {
    const rows = this.db.select({ agentId: channelSubscriptions.agentId })
      .from(channelSubscriptions)
      .where(eq(channelSubscriptions.channel, channel))
      .all();
    return rows.map(r => r.agentId);
  }

  getUnreadChannelMessages(agentId: string): ChatMessage[] {
    const subs = this.getSubscriptions(agentId);
    if (subs.length === 0) return [];
    const allMsgs: ChatMessage[] = [];
    for (const ch of subs) {
      const lastRead = this.getLastRead(agentId, ch);
      const conditions = [eq(messages.channel, ch)];
      if (lastRead) conditions.push(gt(messages.createdAt, lastRead));
      const rows = this.db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(messages.createdAt)
        .all();
      for (const r of rows) {
        const msg = this.hydrateMessage(r as any);
        // Exclude own messages
        if (msg.authorId !== agentId) {
          allMsgs.push(msg);
        }
      }
    }
    return this.attachReplyPreviews(allMsgs);
  }

  // ── DM ────────────────────────────────────────────────────────────────

  appendDM(from: string, to: string, content: string): ChatMessage {
    // Canonical DM format: channel 'dm:<recipient>' + recipient column.
    // (Bare channel 'dm' predates this and is migrated in SqliteStore.)
    return this.createMessage({
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: from,
      content,
      metadata: null,
      channel: `dm:${to}`,
      recipient: to,
    });
  }

  getUnreadDMs(agentId: string): ChatMessage[] {
    const lastRead = this.getLastRead(agentId, 'dm');
    const conditions = [
      // Match canonical 'dm:<id>' rows; recipient covers legacy bare-'dm' rows
      or(eq(messages.channel, `dm:${agentId}`), and(eq(messages.channel, 'dm'), eq(messages.recipient, agentId)))!,
    ];
    if (lastRead) conditions.push(gt(messages.createdAt, lastRead));
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(messages.createdAt)
      .all();
    return this.attachReplyPreviews(rows.map(r => this.hydrateMessage(r as any)));
  }

  markRead(agentId: string, channel: string = 'dm'): void {
    const now = new Date().toISOString();
    // Use raw SQL for upsert on composite key
    this.db.run(
      sql`INSERT INTO read_state (agent_id, channel, last_read_at) VALUES (${agentId}, ${channel}, ${now}) ON CONFLICT(agent_id, channel) DO UPDATE SET last_read_at = ${now}`
    );
  }

  markChannelRead(agentId: string, channel: string): void {
    this.markRead(agentId, channel);
  }

  getLastRead(agentId: string, channel: string = 'dm'): string | null {
    const row = this.db.select().from(readState)
      .where(and(eq(readState.agentId, agentId), eq(readState.channel, channel)))
      .get();
    return row?.lastReadAt ?? null;
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MessageStore } from '../../src/comms/MessageStore.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema.js';

describe('MessageStore', () => {
  let store: MessageStore;
  let tmpDir: string;
  let rawDb: InstanceType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-msgstore-'));
    rawDb = new Database(join(tmpDir, 'test.sqlite'));
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');
    // Apply schema
    const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../sql/schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf-8');
    for (const stmt of schemaSql.split(';').map(s => s.trim()).filter(Boolean)) {
      try { rawDb.exec(stmt); } catch { /* FTS virtual tables etc */ }
    }
    const db = drizzle(rawDb, { schema });
    store = new MessageStore(db);
  });

  afterEach(() => {
    rawDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and retrieves a message', () => {
    const msg = store.createMessage({
      authorType: 'user',
      authorId: 'user',
      content: 'Hello world',
      parentId: null,
      taskId: null,
      metadata: null,
    });
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBe('Hello world');

    const retrieved = store.getMessage(msg.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Hello world');
  });

  it('lists messages with filters', () => {
    store.createMessage({ authorType: 'user', authorId: 'user', content: 'msg1', parentId: null, taskId: null, metadata: null });
    store.createMessage({ authorType: 'lead', authorId: 'lead-1', content: 'msg2', parentId: null, taskId: 'task-1', metadata: null });
    store.createMessage({ authorType: 'agent', authorId: 'worker-1', content: 'msg3', parentId: null, taskId: 'task-1', metadata: null });

    const all = store.listMessages();
    expect(all.length).toBe(3);

    const taskMsgs = store.listMessages({ taskId: 'task-1' });
    expect(taskMsgs.length).toBe(2);

    const limited = store.listMessages({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  it('supports replies via parentId', () => {
    const parent = store.createMessage({ authorType: 'user', authorId: 'user', content: 'question', parentId: null, taskId: null, metadata: null });
    const reply = store.createMessage({ authorType: 'lead', authorId: 'lead-1', content: 'answer', parentId: parent.id, taskId: null, metadata: null });
    expect(reply.parentId).toBe(parent.id);
  });

  it('supports multi-parent replies via parentIds', () => {
    const msg1 = store.createMessage({ authorType: 'user', authorId: 'user', content: 'first', parentId: null, taskId: null, metadata: null });
    const msg2 = store.createMessage({ authorType: 'user', authorId: 'user', content: 'second', parentId: null, taskId: null, metadata: null });
    const msg3 = store.createMessage({ authorType: 'user', authorId: 'user', content: 'third', parentId: null, taskId: null, metadata: null });

    const reply = store.createMessage({
      authorType: 'lead', authorId: 'lead', content: 'merged reply',
      parentId: msg1.id, parentIds: [msg1.id, msg2.id, msg3.id], taskId: null, metadata: null,
    });

    expect(reply.parentId).toBe(msg1.id);
    expect(reply.parentIds).toEqual([msg1.id, msg2.id, msg3.id]);

    const retrieved = store.getMessage(reply.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.parentIds).toEqual([msg1.id, msg2.id, msg3.id]);

    const listed = store.listMessages();
    const found = listed.find(m => m.id === reply.id);
    expect(found?.parentIds).toEqual([msg1.id, msg2.id, msg3.id]);
  });

  it('returns null parentIds when not set', () => {
    const msg = store.createMessage({ authorType: 'user', authorId: 'user', content: 'no parents', parentId: null, taskId: null, metadata: null });
    expect(msg.parentIds).toBeNull();

    const retrieved = store.getMessage(msg.id);
    expect(retrieved!.parentIds).toBeNull();
  });

  // ── Channel tests ──

  it('appendChannelMessage stores and auto-subscribes sender', () => {
    const msg = store.appendChannelMessage('general', {
      parentId: null, taskId: null, authorType: 'agent', authorId: 'worker-1',
      content: 'hello channel', metadata: null, channel: null, recipient: null,
    });
    expect(msg.channel).toBe('general');
    const subs = store.getSubscribers('general');
    expect(subs).toContain('worker-1');
  });

  it('lists channels', () => {
    store.appendChannelMessage('general', { parentId: null, taskId: null, authorType: 'agent', authorId: 'a', content: 'x', metadata: null, channel: null, recipient: null });
    store.appendChannelMessage('dev', { parentId: null, taskId: null, authorType: 'agent', authorId: 'b', content: 'y', metadata: null, channel: null, recipient: null });
    const channels = store.listChannels();
    expect(channels).toContain('general');
    expect(channels).toContain('dev');
  });

  it('subscribe/unsubscribe and getSubscriptions', () => {
    store.subscribe('agent-1', 'general');
    store.subscribe('agent-1', 'dev');
    expect(store.getSubscriptions('agent-1')).toEqual(expect.arrayContaining(['general', 'dev']));
    store.unsubscribe('agent-1', 'dev');
    expect(store.getSubscriptions('agent-1')).toEqual(['general']);
  });

  it('getUnreadChannelMessages returns only unread, excludes own', () => {
    store.subscribe('agent-1', 'general');
    store.subscribe('agent-2', 'general');

    store.appendChannelMessage('general', { parentId: null, taskId: null, authorType: 'agent', authorId: 'agent-2', content: 'msg from 2', metadata: null, channel: null, recipient: null });

    const unread = store.getUnreadChannelMessages('agent-1');
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe('msg from 2');

    // Own messages excluded
    const ownUnread = store.getUnreadChannelMessages('agent-2');
    expect(ownUnread.length).toBe(0);

    // Mark read clears
    store.markChannelRead('agent-1', 'general');
    const afterRead = store.getUnreadChannelMessages('agent-1');
    expect(afterRead.length).toBe(0);
  });

  it('DM operations: appendDM, getUnreadDMs, markRead', () => {
    store.appendDM('lead', 'worker-1', 'do this task');
    const unread = store.getUnreadDMs('worker-1');
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe('do this task');

    store.markRead('worker-1', 'dm');
    const afterRead = store.getUnreadDMs('worker-1');
    expect(afterRead.length).toBe(0);
  });

  it('appendDM writes canonical dm:<recipient> channel with recipient set', () => {
    // Regression: bare channel 'dm' leaked into the main chat feed
    // (the dm: prefix filter missed it) and was invisible to the
    // per-agent DM panel (which queries channel 'dm:<id>')
    const msg = store.appendDM('lead', 'worker-9', 'hello');
    expect(msg.channel).toBe('dm:worker-9');
    expect(msg.recipient).toBe('worker-9');
  });

  it('getUnreadDMs finds both canonical and legacy bare-dm rows', () => {
    // Legacy row shape (pre-migration): channel 'dm' + recipient
    store.createMessage({
      parentId: null, taskId: null, authorType: 'agent', authorId: 'lead',
      content: 'legacy format', metadata: null, channel: 'dm', recipient: 'worker-2',
    });
    // Canonical row shape
    store.appendDM('director', 'worker-2', 'canonical format');

    const unread = store.getUnreadDMs('worker-2');
    expect(unread.map(m => m.content).sort()).toEqual(['canonical format', 'legacy format']);
  });
});

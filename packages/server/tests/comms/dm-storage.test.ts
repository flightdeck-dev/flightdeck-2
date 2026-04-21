import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { MessageStore } from '../../src/comms/MessageStore.js';

describe('Agent DM storage', () => {
  let sqlStore: SqliteStore;
  let msgStore: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-dm-'));
    sqlStore = new SqliteStore(join(tmpDir, 'test.sqlite'));
    msgStore = new MessageStore(sqlStore.db);
  });

  afterEach(() => {
    sqlStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves DMs by channel', () => {
    msgStore.appendChannelMessage('dm:agent-1', {
      role: 'user',
      authorType: 'user',
      authorId: null,
      content: 'Hello agent 1',
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
      recipient: null,
    });
    msgStore.appendChannelMessage('dm:agent-2', {
      role: 'user',
      authorType: 'user',
      authorId: null,
      content: 'Hello agent 2',
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
      recipient: null,
    });

    const msgs1 = msgStore.listChannelMessages('dm:agent-1');
    expect(msgs1.length).toBe(1);
    expect(msgs1[0].content).toBe('Hello agent 1');

    const msgs2 = msgStore.listChannelMessages('dm:agent-2');
    expect(msgs2.length).toBe(1);
    expect(msgs2[0].content).toBe('Hello agent 2');
  });

  it('filters messages by channel', () => {
    const base = {
      role: 'user' as const,
      authorType: 'user' as const,
      authorId: null,
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
      recipient: null,
    };

    msgStore.appendChannelMessage('dm:agent-1', { ...base, content: 'First' });
    msgStore.appendChannelMessage('dm:agent-1', { ...base, role: 'assistant' as any, authorType: 'agent', content: 'Second' });
    msgStore.appendChannelMessage('general', { ...base, content: 'General msg' });

    const dmMsgs = msgStore.listChannelMessages('dm:agent-1');
    expect(dmMsgs.length).toBe(2);

    const generalMsgs = msgStore.listChannelMessages('general');
    expect(generalMsgs.length).toBe(1);
  });
});

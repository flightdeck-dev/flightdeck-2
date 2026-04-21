import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { MessageStore } from '../../src/comms/MessageStore.js';

describe('DM filtering from main chat', () => {
  let sqlStore: SqliteStore;
  let msgStore: MessageStore;
  let tmpDir: string;

  const base = {
    threadId: null,
    parentId: null,
    taskId: null,
    metadata: null,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-dm-filter-'));
    sqlStore = new SqliteStore(join(tmpDir, 'test.sqlite'));
    msgStore = new MessageStore(sqlStore.db);
  });

  afterEach(() => {
    sqlStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listMessages returns both main chat and DM messages (no built-in filter)', () => {
    // Main chat message (channel: null)
    msgStore.createMessage({ ...base, authorType: 'user', authorId: 'user-1', content: 'hello main chat' });
    // DM message
    msgStore.createMessage({ ...base, authorType: 'agent', authorId: 'lead-1', content: 'dm to planner', channel: 'dm:planner-1' });

    const all = msgStore.listMessages({});
    expect(all.length).toBe(2);
  });

  it('listChannelMessages only returns messages for that specific DM channel', () => {
    msgStore.createMessage({ ...base, authorType: 'user', authorId: 'user-1', content: 'hello main chat' });
    msgStore.createMessage({ ...base, authorType: 'agent', authorId: 'lead-1', content: 'dm to planner', channel: 'dm:planner-1' });
    msgStore.createMessage({ ...base, authorType: 'agent', authorId: 'worker-1', content: 'dm to lead', channel: 'dm:lead-1' });

    const plannerDms = msgStore.listChannelMessages('dm:planner-1');
    expect(plannerDms.length).toBe(1);
    expect(plannerDms[0].content).toBe('dm to planner');

    const leadDms = msgStore.listChannelMessages('dm:lead-1');
    expect(leadDms.length).toBe(1);
    expect(leadDms[0].content).toBe('dm to lead');
  });

  it('main chat can be derived by filtering out dm: channels (as HttpServer does)', () => {
    msgStore.createMessage({ ...base, authorType: 'user', authorId: 'user-1', content: 'main msg 1' });
    msgStore.createMessage({ ...base, authorType: 'agent', authorId: 'lead-1', content: 'dm content', channel: 'dm:planner-1' });
    msgStore.createMessage({ ...base, authorType: 'user', authorId: 'user-1', content: 'main msg 2' });

    const all = msgStore.listMessages({});
    const mainChat = all.filter(m => !m.channel?.startsWith('dm:'));
    expect(mainChat.length).toBe(2);
    expect(mainChat.every(m => !m.channel?.startsWith('dm:'))).toBe(true);
  });

  it('appendChannelMessage stores with correct channel for retrieval', () => {
    msgStore.appendChannelMessage('dm:agent-1', {
      role: 'user',
      authorType: 'user',
      authorId: 'user-1',
      content: 'Hello via appendChannelMessage',
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
      recipient: null,
    });

    // Should appear in channel query
    const channelMsgs = msgStore.listChannelMessages('dm:agent-1');
    expect(channelMsgs.length).toBe(1);
    expect(channelMsgs[0].content).toBe('Hello via appendChannelMessage');

    // Should also appear in listMessages (unfiltered)
    const all = msgStore.listMessages({});
    expect(all.some(m => m.content === 'Hello via appendChannelMessage')).toBe(true);
  });
});

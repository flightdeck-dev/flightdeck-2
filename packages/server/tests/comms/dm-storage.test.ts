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
    msgStore = new MessageStore(sqlStore);
  });

  afterEach(() => {
    sqlStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves DMs by channel', () => {
    msgStore.appendChannelMessage('dm:agent-1', {
      role: 'user',
      content: 'Hello agent 1',
      recipient: null,
    });
    msgStore.appendChannelMessage('dm:agent-2', {
      role: 'user',
      content: 'Hello agent 2',
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
    msgStore.appendChannelMessage('dm:agent-1', {
      role: 'user',
      content: 'First',
      recipient: null,
    });
    msgStore.appendChannelMessage('dm:agent-1', {
      role: 'assistant',
      content: 'Second',
      recipient: null,
    });
    msgStore.appendChannelMessage('general', {
      role: 'user',
      content: 'General msg',
      recipient: null,
    });

    const dmMsgs = msgStore.listChannelMessages('dm:agent-1');
    expect(dmMsgs.length).toBe(2);

    const generalMsgs = msgStore.listChannelMessages('general');
    expect(generalMsgs.length).toBe(1);
  });
});

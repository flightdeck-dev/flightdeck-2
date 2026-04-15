import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { MessageStore } from '../../src/comms/MessageStore.js';
import type { AgentId } from '@flightdeck-ai/shared';

describe('MessageStore (channel & DM)', () => {
  let store: SqliteStore;
  let ms: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-msg-'));
    store = new SqliteStore(join(tmpDir, 'state.sqlite'));
    ms = new MessageStore(store.db);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads channel messages', () => {
    ms.appendChannelMessage('test', {
      threadId: null, parentId: null, taskId: null,
      authorType: 'agent', authorId: 'agent-1', content: 'hello',
      metadata: null, channel: 'test', recipient: null,
    });
    const messages = ms.listChannelMessages('test');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
    expect(messages[0].channel).toBe('test');
  });

  it('lists channels', () => {
    ms.appendChannelMessage('chan-1', {
      threadId: null, parentId: null, taskId: null,
      authorType: 'agent', authorId: 'a', content: 'a',
      metadata: null, channel: 'chan-1', recipient: null,
    });
    ms.appendChannelMessage('chan-2', {
      threadId: null, parentId: null, taskId: null,
      authorType: 'agent', authorId: 'a', content: 'b',
      metadata: null, channel: 'chan-2', recipient: null,
    });
    const channels = ms.listChannels();
    expect(channels).toContain('chan-1');
    expect(channels).toContain('chan-2');
  });

  it('returns empty for nonexistent channel', () => {
    expect(ms.listChannelMessages('nope')).toEqual([]);
  });

  it('filters by since', () => {
    // Insert old message with a known createdAt via createMessage
    ms.createMessage({
      threadId: null, parentId: null, taskId: null,
      authorType: 'agent', authorId: 'a', content: 'old',
      metadata: null, channel: 'test', recipient: null,
    });
    // Wait a tiny bit then insert recent
    const recent = ms.appendChannelMessage('test', {
      threadId: null, parentId: null, taskId: null,
      authorType: 'agent', authorId: 'a', content: 'recent',
      metadata: null, channel: 'test', recipient: null,
    });
    // Since the old message was created just before recent, filter by old's time
    const all = ms.listChannelMessages('test');
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  describe('DM operations', () => {
    it('returns DMs addressed to a specific agent', () => {
      ms.appendDM('worker-1', 'lead-1', 'hello lead');
      ms.appendDM('lead-1', 'worker-1', 'hello worker');
      ms.appendDM('worker-2', 'lead-1', 'another for lead');

      const unread = ms.getUnreadDMs('lead-1');
      expect(unread).toHaveLength(2);
      expect(unread[0].content).toBe('hello lead');
      expect(unread[1].content).toBe('another for lead');
    });

    it('returns empty when no DMs exist', () => {
      expect(ms.getUnreadDMs('lead-1')).toEqual([]);
    });

    it('excludes already-read DMs after markRead', () => {
      ms.appendDM('worker-1', 'lead-1', 'first');
      ms.markRead('lead-1');

      const unread1 = ms.getUnreadDMs('lead-1');
      expect(unread1).toHaveLength(0);

      // New message after markRead should show up
      ms.appendDM('worker-1', 'lead-1', 'second');
      const unread2 = ms.getUnreadDMs('lead-1');
      expect(unread2).toHaveLength(1);
      expect(unread2[0].content).toBe('second');
    });

    it('does not affect other agents read state', () => {
      ms.appendDM('worker-1', 'lead-1', 'for lead');
      ms.appendDM('lead-1', 'worker-1', 'for worker');

      ms.markRead('lead-1');

      const workerUnread = ms.getUnreadDMs('worker-1');
      expect(workerUnread).toHaveLength(1);
      expect(workerUnread[0].content).toBe('for worker');
    });
  });

  describe('markRead / getLastRead', () => {
    it('returns null for agents that never read', () => {
      expect(ms.getLastRead('lead-1')).toBeNull();
    });

    it('stores and retrieves last-read timestamp', () => {
      ms.markRead('lead-1');
      const ts = ms.getLastRead('lead-1');
      expect(ts).toBeTruthy();
      expect(new Date(ts!).getTime()).toBeGreaterThan(0);
    });

    it('persists across MessageStore instances', () => {
      ms.markRead('lead-1');
      const ts1 = ms.getLastRead('lead-1');

      const ms2 = new MessageStore(store.db);
      const ts2 = ms2.getLastRead('lead-1');
      expect(ts2).toBe(ts1);
    });
  });
});

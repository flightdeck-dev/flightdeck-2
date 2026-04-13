import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageLog } from '../../src/storage/MessageLog.js';
import type { Message, AgentId, MessageId } from '@flightdeck-ai/shared';

describe('MessageLog', () => {
  let log: MessageLog;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-msg-'));
    log = new MessageLog(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const msg = (content: string, opts?: { from?: string; to?: string | null; channel?: string }): Message => ({
    id: `msg-${Date.now()}-${Math.random()}` as MessageId,
    from: (opts?.from ?? 'agent-1') as AgentId,
    to: (opts?.to ?? null) as AgentId | null,
    channel: opts?.channel ?? null,
    content,
    timestamp: new Date().toISOString(),
  });

  it('appends and reads messages', () => {
    log.append(msg('hello'), 'test');
    const messages = log.read('test');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
  });

  it('lists channels', () => {
    log.append(msg('a'), 'chan-1');
    log.append(msg('b'), 'chan-2');
    const channels = log.channels();
    expect(channels).toContain('chan-1');
    expect(channels).toContain('chan-2');
  });

  it('returns empty for nonexistent channel', () => {
    expect(log.read('nope')).toEqual([]);
  });

  it('filters by since', () => {
    const old = msg('old');
    old.timestamp = '2020-01-01T00:00:00.000Z';
    log.append(old, 'test');
    const recent = msg('recent');
    recent.timestamp = '2026-01-01T00:00:00.000Z';
    log.append(recent, 'test');
    const filtered = log.read('test', '2025-01-01T00:00:00.000Z');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].content).toBe('recent');
  });

  describe('getUnreadDMs', () => {
    it('returns DMs addressed to a specific agent', () => {
      const dm1 = msg('hello lead', { from: 'worker-1', to: 'lead-1' });
      const dm2 = msg('hello worker', { from: 'lead-1', to: 'worker-1' });
      const dm3 = msg('another for lead', { from: 'worker-2', to: 'lead-1' });
      log.append(dm1, 'dm');
      log.append(dm2, 'dm');
      log.append(dm3, 'dm');

      const unread = log.getUnreadDMs('lead-1' as AgentId);
      expect(unread).toHaveLength(2);
      expect(unread[0].content).toBe('hello lead');
      expect(unread[1].content).toBe('another for lead');
    });

    it('returns empty when no DMs exist', () => {
      expect(log.getUnreadDMs('lead-1' as AgentId)).toEqual([]);
    });

    it('excludes already-read DMs after markRead', () => {
      const dm1 = msg('first', { from: 'worker-1', to: 'lead-1' });
      dm1.timestamp = '2026-01-01T00:00:00.000Z';
      log.append(dm1, 'dm');

      log.markRead('lead-1' as AgentId);

      // Old message should be filtered out
      const unread1 = log.getUnreadDMs('lead-1' as AgentId);
      expect(unread1).toHaveLength(0);

      // New message after markRead should show up
      const dm2 = msg('second', { from: 'worker-1', to: 'lead-1' });
      dm2.timestamp = '2026-06-01T00:00:00.000Z';
      log.append(dm2, 'dm');

      const unread2 = log.getUnreadDMs('lead-1' as AgentId);
      expect(unread2).toHaveLength(1);
      expect(unread2[0].content).toBe('second');
    });

    it('does not affect other agents read state', () => {
      const dm1 = msg('for lead', { from: 'worker-1', to: 'lead-1' });
      const dm2 = msg('for worker', { from: 'lead-1', to: 'worker-1' });
      log.append(dm1, 'dm');
      log.append(dm2, 'dm');

      log.markRead('lead-1' as AgentId);

      // Worker should still see their unread
      const workerUnread = log.getUnreadDMs('worker-1' as AgentId);
      expect(workerUnread).toHaveLength(1);
      expect(workerUnread[0].content).toBe('for worker');
    });
  });

  describe('markRead / getLastRead', () => {
    it('returns null for agents that never read', () => {
      expect(log.getLastRead('lead-1' as AgentId)).toBeNull();
    });

    it('stores and retrieves last-read timestamp', () => {
      log.markRead('lead-1' as AgentId);
      const ts = log.getLastRead('lead-1' as AgentId);
      expect(ts).toBeTruthy();
      expect(new Date(ts!).getTime()).toBeGreaterThan(0);
    });

    it('persists across MessageLog instances', () => {
      log.markRead('lead-1' as AgentId);
      const ts1 = log.getLastRead('lead-1' as AgentId);

      // Create a new instance pointing to the same dir
      const log2 = new MessageLog(tmpDir);
      const ts2 = log2.getLastRead('lead-1' as AgentId);
      expect(ts2).toBe(ts1);
    });
  });
});

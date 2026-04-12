import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageLog } from '../../src/storage/MessageLog.js';
import type { Message, AgentId, MessageId } from '../../src/core/types.js';

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

  const msg = (content: string, channel?: string): Message => ({
    id: `msg-${Date.now()}` as MessageId,
    from: 'agent-1' as AgentId,
    to: null,
    channel: channel ?? null,
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
});

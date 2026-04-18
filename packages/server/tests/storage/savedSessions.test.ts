import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';

describe('SqliteStore saved sessions', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-test-sessions-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and load sessions', () => {
    store.saveSession({
      agentId: 'lead-123',
      role: 'lead',
      sessionId: 'acp-abc',
      localSessionId: 'local-1',
      runtime: 'acp',
      cwd: '/tmp/test',
      model: 'claude-sonnet',
    });
    store.saveSession({
      agentId: 'planner-456',
      role: 'planner',
      sessionId: 'acp-def',
      cwd: '/tmp/test',
    });

    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].agentId).toBe('lead-123');
    expect(sessions[0].sessionId).toBe('acp-abc');
    expect(sessions[0].model).toBe('claude-sonnet');
    expect(sessions[1].agentId).toBe('planner-456');
    expect(sessions[1].model).toBeNull();
  });

  it('should upsert on duplicate agentId', () => {
    store.saveSession({ agentId: 'lead-1', role: 'lead', sessionId: 'old-session', cwd: '/tmp' });
    store.saveSession({ agentId: 'lead-1', role: 'lead', sessionId: 'new-session', cwd: '/tmp' });

    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('new-session');
  });

  it('should delete a specific session', () => {
    store.saveSession({ agentId: 'lead-1', role: 'lead', sessionId: 's1', cwd: '/tmp' });
    store.saveSession({ agentId: 'planner-1', role: 'planner', sessionId: 's2', cwd: '/tmp' });

    store.deleteSession('lead-1');
    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe('planner-1');
  });

  it('should clear all sessions', () => {
    store.saveSession({ agentId: 'lead-1', role: 'lead', sessionId: 's1', cwd: '/tmp' });
    store.saveSession({ agentId: 'planner-1', role: 'planner', sessionId: 's2', cwd: '/tmp' });

    store.clearSessions();
    expect(store.loadSessions()).toHaveLength(0);
  });

  it('should return empty array when no sessions', () => {
    expect(store.loadSessions()).toHaveLength(0);
  });
});

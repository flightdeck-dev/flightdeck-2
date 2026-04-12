import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpAdapter, type AcpSession, type QueuedPrompt } from '../../src/agents/AcpAdapter.js';
import type { RuntimeConfig } from '../../src/agents/SessionManager.js';

const TEST_RUNTIMES: Record<string, RuntimeConfig> = {
  codex: { command: 'echo', args: ['{prompt}'], adapter: 'acp' },
};

describe('AcpAdapter prompt queue', () => {
  let adapter: AcpAdapter;

  beforeEach(() => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');
  });

  afterEach(() => adapter?.clear());

  it('queues messages when session is not yet initialized (no acpSessionId)', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    // Manually set acpSessionId to null to simulate pre-initialization state
    session.acpSessionId = null;

    const result = await adapter.steer(meta.sessionId, { content: 'hello' });
    expect(result).toBe('');
    expect(session.promptQueue).toHaveLength(1);
    expect(session.promptQueue[0].content).toBe('hello');
    expect(session.promptQueue[0].priority).toBe(false);
  });

  it('queues messages when session is currently prompting', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    // Simulate an active session that is currently prompting
    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;

    const result = await adapter.steer(meta.sessionId, { content: 'queued message' });
    expect(result).toBe('');
    expect(session.promptQueue).toHaveLength(1);
    expect(session.promptQueue[0].content).toBe('queued message');
  });

  it('priority messages jump to front of queue', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;

    // Queue normal messages
    await adapter.steer(meta.sessionId, { content: 'normal 1' });
    await adapter.steer(meta.sessionId, { content: 'normal 2' });

    // Queue an urgent message — should go to front
    await adapter.steer(meta.sessionId, { content: 'urgent!', urgent: true });

    expect(session.promptQueue).toHaveLength(3);
    // Priority item should be first
    expect(session.promptQueue[0].content).toBe('[URGENT] urgent!');
    expect(session.promptQueue[0].priority).toBe(true);
    expect(session.promptQueue[1].content).toBe('normal 1');
    expect(session.promptQueue[2].content).toBe('normal 2');
  });

  it('multiple priority messages maintain order among themselves', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;

    await adapter.steer(meta.sessionId, { content: 'normal' });
    await adapter.steer(meta.sessionId, { content: 'urgent 1', urgent: true });
    await adapter.steer(meta.sessionId, { content: 'urgent 2', urgent: true });

    expect(session.promptQueue).toHaveLength(3);
    expect(session.promptQueue[0].content).toBe('[URGENT] urgent 1');
    expect(session.promptQueue[1].content).toBe('[URGENT] urgent 2');
    expect(session.promptQueue[2].content).toBe('normal');
  });

  it('session has isPrompting and promptQueue initialized', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    expect(session.isPrompting).toBe(false);
    expect(session.promptQueue).toEqual([]);
  });

  it('throws for ended session', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;
    session.status = 'ended';

    await expect(adapter.steer(meta.sessionId, { content: 'hello' }))
      .rejects.toThrow('Session already ended');
  });
});

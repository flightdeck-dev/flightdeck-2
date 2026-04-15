import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    // steer() now returns a pending promise; don't await it — just verify queuing
    const promise = adapter.steer(meta.sessionId, { content: 'hello' });
    // Give microtask a tick
    await new Promise(r => setTimeout(r, 10));

    expect(session.promptQueue).toHaveLength(1);
    expect(session.promptQueue[0].content).toBe('hello');
    expect(session.promptQueue[0].priority).toBe(false);
    // The promise should have resolve/reject callbacks
    expect(typeof session.promptQueue[0].resolve).toBe('function');
    expect(typeof session.promptQueue[0].reject).toBe('function');

    // Manually resolve to avoid hanging
    session.promptQueue[0].resolve!('test');
    expect(await promise).toBe('test');
  });

  it('queues messages when session is currently prompting', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    // Simulate an active session that is currently prompting
    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;

    const promise = adapter.steer(meta.sessionId, { content: 'queued message' });
    await new Promise(r => setTimeout(r, 10));

    expect(session.promptQueue).toHaveLength(1);
    expect(session.promptQueue[0].content).toBe('queued message');
    expect(typeof session.promptQueue[0].resolve).toBe('function');

    // Resolve to clean up
    session.promptQueue[0].resolve!('response');
    expect(await promise).toBe('response');
  });

  it('priority messages jump to front of queue (no connection)', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;
    // Nullify connection to test fallback queueing behavior
    session.connection = null!;

    // Queue normal messages (don't await — they return pending promises)
    const p1 = adapter.steer(meta.sessionId, { content: 'normal 1' });
    const p2 = adapter.steer(meta.sessionId, { content: 'normal 2' });

    // Queue an urgent message — should go to front
    const p3 = adapter.steer(meta.sessionId, { content: 'urgent!', urgent: true });

    await new Promise(r => setTimeout(r, 10));

    expect(session.promptQueue).toHaveLength(3);
    // Priority item should be first
    expect(session.promptQueue[0].content).toContain('[URGENT] urgent!');
    expect(session.promptQueue[0].priority).toBe(true);
    expect(session.promptQueue[1].content).toBe('normal 1');
    expect(session.promptQueue[2].content).toBe('normal 2');

    // Clean up
    for (const item of session.promptQueue) item.resolve!('ok');
    await Promise.all([p1, p2, p3]);
  });

  it('multiple priority messages maintain order among themselves (no connection)', async () => {
    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'test' });
    const session = adapter.getSession(meta.sessionId)!;

    session.acpSessionId = 'test-session-id';
    session.isPrompting = true;
    // Nullify connection to test fallback queueing behavior
    session.connection = null!;

    const p1 = adapter.steer(meta.sessionId, { content: 'normal' });
    const p2 = adapter.steer(meta.sessionId, { content: 'urgent 1', urgent: true });
    const p3 = adapter.steer(meta.sessionId, { content: 'urgent 2', urgent: true });

    await new Promise(r => setTimeout(r, 10));

    expect(session.promptQueue).toHaveLength(3);
    expect(session.promptQueue[0].content).toContain('[URGENT] urgent 1');
    expect(session.promptQueue[1].content).toContain('[URGENT] urgent 2');
    expect(session.promptQueue[2].content).toBe('normal');

    // Clean up
    for (const item of session.promptQueue) item.resolve!('ok');
    await Promise.all([p1, p2, p3]);
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

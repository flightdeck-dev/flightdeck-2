import { describe, it, expect, afterEach } from 'vitest';
import { SessionManager, DEFAULT_RUNTIMES, type RuntimeConfig } from '../../src/agents/SessionManager.js';

// Use 'echo' as a safe, universally available command for testing
const TEST_RUNTIMES: Record<string, RuntimeConfig> = {
  echo: {
    command: 'echo',
    args: ['{prompt}'],
    adapter: 'acp',
  },
  cat: {
    command: 'cat',
    args: [],
    adapter: 'pty',
  },
  sleep: {
    command: 'sleep',
    args: ['30'],
    adapter: 'acp',
  },
  nonexistent: {
    command: 'nonexistent-binary-xyz-12345',
    args: [],
    adapter: 'acp',
  },
};

describe('SessionManager', () => {
  let mgr: SessionManager;

  afterEach(() => {
    mgr?.clear();
  });

  it('spawns a session and tracks it', () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'echo', '/tmp', 'hello world');

    expect(session.id).toMatch(/^session-/);
    expect(session.agentId).toBe('agent-abc');
    expect(session.cwd).toBe('/tmp');
    expect(session.command).toBe('echo');
    expect(mgr.getSession(session.id)).toBe(session);
  });

  it('echo session ends quickly with exit code 0', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'echo', '/tmp', 'test output');

    // Wait for process to exit
    await new Promise(r => setTimeout(r, 200));
    expect(session.status).toBe('ended');
    expect(session.exitCode).toBe(0);
    expect(session.stdout).toContain('test output');
  });

  it('kills a running session', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'sleep', '/tmp', '');

    expect(session.status).toBe('active');
    mgr.kill(session.id);
    await new Promise(r => setTimeout(r, 200));
    expect(session.status).toBe('ended');
  });

  it('steers a running session via stdin', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'cat', '/tmp', '');

    // cat reads from stdin, so steer should write to it
    await new Promise(r => setTimeout(r, 100));
    mgr.steer(session.id, 'hello from steer');
    await new Promise(r => setTimeout(r, 100));
    expect(session.stdout).toContain('hello from steer');

    mgr.kill(session.id);
  });

  it('throws on steer to ended session', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'echo', '/tmp', 'done');
    await new Promise(r => setTimeout(r, 200));

    expect(() => mgr.steer(session.id, 'late')).toThrow('already ended');
  });

  it('throws on unknown runtime', () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    expect(() => mgr.spawn('agent-abc' as any, 'unknown', '/tmp', '')).toThrow('Unknown runtime');
  });

  it('handles ENOENT gracefully', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-abc' as any, 'nonexistent', '/tmp', '');

    await new Promise(r => setTimeout(r, 200));
    expect(session.status).toBe('ended');
    expect(session.exitCode).toBeLessThan(0);
    expect(session.stderr).toContain('not found');
  });

  it('checkHealth returns health for all sessions', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    mgr.spawn('agent-1' as any, 'echo', '/tmp', 'hi');
    mgr.spawn('agent-2' as any, 'sleep', '/tmp', '');
    await new Promise(r => setTimeout(r, 200));

    const health = mgr.checkHealth();
    expect(health).toHaveLength(2);

    const ended = health.find(h => h.status === 'ended');
    const active = health.find(h => h.status === 'active');
    expect(ended).toBeDefined();
    expect(active).toBeDefined();
    expect(ended!.exitCode).toBe(0);
  });

  it('getActiveSessions excludes ended', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    mgr.spawn('agent-1' as any, 'echo', '/tmp', 'hi');
    mgr.spawn('agent-2' as any, 'sleep', '/tmp', '');
    await new Promise(r => setTimeout(r, 200));

    const active = mgr.getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].command).toBe('sleep');
  });

  it('removeSession kills and removes', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    const session = mgr.spawn('agent-1' as any, 'sleep', '/tmp', '');
    expect(mgr.removeSession(session.id)).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(mgr.getSession(session.id)).toBeUndefined();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { AcpAdapter } from '../src/agents/AcpAdapter.js';
import { PtyAdapter } from '../src/agents/PtyAdapter.js';
import { SessionManager, type RuntimeConfig } from '../src/agents/SessionManager.js';

const TEST_RUNTIMES: Record<string, RuntimeConfig> = {
  codex: { command: 'echo', args: ['{prompt}'], adapter: 'acp' },
  claude: { command: 'echo', args: ['{prompt}'], adapter: 'pty' },
};

describe('AcpAdapter', () => {
  let mgr: SessionManager;
  let adapter: AcpAdapter;

  afterEach(() => mgr?.clear());

  it('spawns and returns metadata', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    adapter = new AcpAdapter(mgr, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'do stuff' });
    expect(meta.status).toBe('running');
    expect(meta.sessionId).toMatch(/^session-/);
    expect(meta.agentId).toMatch(/^agent-/);
  });

  it('getMetadata returns ended after process exits', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    adapter = new AcpAdapter(mgr, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    await new Promise(r => setTimeout(r, 200));

    const updated = await adapter.getMetadata(meta.sessionId);
    expect(updated?.status).toBe('ended');
  });

  it('getMetadata returns null for unknown session', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    adapter = new AcpAdapter(mgr, 'codex');

    const meta = await adapter.getMetadata('nonexistent');
    expect(meta).toBeNull();
  });

  it('kill terminates the session', async () => {
    const runtimes: Record<string, RuntimeConfig> = {
      codex: { command: 'sleep', args: ['30'], adapter: 'acp' },
    };
    mgr = new SessionManager(runtimes);
    adapter = new AcpAdapter(mgr, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    await adapter.kill(meta.sessionId);
    await new Promise(r => setTimeout(r, 200));

    const updated = await adapter.getMetadata(meta.sessionId);
    expect(updated?.status).toBe('ended');
  });
});

describe('PtyAdapter', () => {
  let mgr: SessionManager;
  let adapter: PtyAdapter;

  afterEach(() => mgr?.clear());

  it('spawns with pty runtime', async () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    adapter = new PtyAdapter(mgr, 'claude');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    expect(meta.status).toBe('running');
    expect(meta.sessionId).toMatch(/^session-/);
  });

  it('runtime is pty', () => {
    mgr = new SessionManager(TEST_RUNTIMES);
    adapter = new PtyAdapter(mgr, 'claude');
    expect(adapter.runtime).toBe('pty');
  });
});

describe('Adapter selection', () => {
  it('AcpAdapter has acp runtime', () => {
    const adapter = new AcpAdapter(new SessionManager(TEST_RUNTIMES), 'codex');
    expect(adapter.runtime).toBe('acp');
  });

  it('PtyAdapter has pty runtime', () => {
    const adapter = new PtyAdapter(new SessionManager(TEST_RUNTIMES), 'claude');
    expect(adapter.runtime).toBe('pty');
  });
});

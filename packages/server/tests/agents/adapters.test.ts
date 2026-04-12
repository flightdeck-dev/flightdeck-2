import { describe, it, expect, afterEach } from 'vitest';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { PtyAdapter } from '../../src/agents/PtyAdapter.js';
import { SessionManager, type RuntimeConfig } from '../../src/agents/SessionManager.js';

const TEST_RUNTIMES: Record<string, RuntimeConfig> = {
  codex: { command: 'echo', args: ['{prompt}'], adapter: 'acp' },
  claude: { command: 'echo', args: ['{prompt}'], adapter: 'pty' },
};

describe('AcpAdapter', () => {
  let adapter: AcpAdapter;

  afterEach(() => adapter?.clear());

  it('spawns and returns metadata', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp', systemPrompt: 'do stuff' });
    expect(meta.status).toBe('running');
    expect(meta.sessionId).toMatch(/^acp-/);
    expect(meta.agentId).toMatch(/^agent-/);
  });

  it('getMetadata returns ended after process exits', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    // echo exits immediately — process will end
    await new Promise(r => setTimeout(r, 500));

    const updated = await adapter.getMetadata(meta.sessionId);
    expect(updated?.status).toBe('ended');
  });

  it('getMetadata returns null for unknown session', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.getMetadata('nonexistent');
    expect(meta).toBeNull();
  });

  it('kill terminates the session', async () => {
    const runtimes: Record<string, RuntimeConfig> = {
      codex: { command: 'sleep', args: ['30'], adapter: 'acp' },
    };
    adapter = new AcpAdapter(runtimes, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    await adapter.kill(meta.sessionId);
    await new Promise(r => setTimeout(r, 500));

    const updated = await adapter.getMetadata(meta.sessionId);
    expect(updated?.status).toBe('ended');
  });

  it('tracks token usage in metadata', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.spawn({ role: 'worker', cwd: '/tmp' });
    const updated = await adapter.getMetadata(meta.sessionId);
    expect(updated?.tokensIn).toBe(0);
    expect(updated?.tokensOut).toBe(0);
    expect(updated?.turnCount).toBeDefined();
  });

  it('passes systemPromptMeta to session initialization', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    // Spawn with systemPromptMeta (append mode)
    const meta = await adapter.spawn({
      role: 'worker',
      cwd: '/tmp',
      systemPrompt: 'do stuff',
      systemPromptMeta: { append: 'You are a specialized worker.' },
    });
    expect(meta.status).toBe('running');
    expect(meta.sessionId).toMatch(/^acp-/);
  });

  it('passes systemPromptMeta as string (replace mode)', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.spawn({
      role: 'worker',
      cwd: '/tmp',
      systemPromptMeta: 'Full custom system prompt',
    });
    expect(meta.status).toBe('running');
  });

  it('works without systemPromptMeta (backward compatible)', async () => {
    adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');

    const meta = await adapter.spawn({
      role: 'worker',
      cwd: '/tmp',
      systemPrompt: 'do stuff',
    });
    expect(meta.status).toBe('running');
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
    const adapter = new AcpAdapter(TEST_RUNTIMES, 'codex');
    expect(adapter.runtime).toBe('acp');
    adapter.clear();
  });

  it('PtyAdapter has pty runtime', () => {
    const adapter = new PtyAdapter(new SessionManager(TEST_RUNTIMES), 'claude');
    expect(adapter.runtime).toBe('pty');
  });
});

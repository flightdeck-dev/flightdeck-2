import { describe, it, expect } from 'vitest';
import { MultiAdapter } from '../../src/agents/MultiAdapter.js';
import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from '../../src/agents/AgentAdapter.js';
import type { AgentId, AgentRuntime } from '@flightdeck-ai/shared';

class FakeAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  onSessionEnd: ((sessionId: string, session: unknown) => void) | null = null;
  steerCalls: string[] = [];
  private counter = 0;

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const sessionId = `fake-${++this.counter}`;
    return { agentId: `${opts.role}-fake` as AgentId, sessionId, status: 'running' };
  }
  async steer(sessionId: string, _message: SteerMessage): Promise<string> {
    this.steerCalls.push(sessionId);
    return 'ok';
  }
  async kill(_sessionId: string): Promise<void> { /* noop */ }
  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    return { agentId: 'a' as AgentId, sessionId, status: 'running' };
  }
}

describe('MultiAdapter session lifecycle', () => {
  it('cleans sessionAdapterMap when a session ends naturally', async () => {
    // Regression: entries were only removed on explicit kill(); sessions
    // that crashed or exited on their own leaked map entries forever.
    const acp = new FakeAdapter();
    const multi = new MultiAdapter(acp);
    const meta = await multi.spawn({ role: 'worker', cwd: '/tmp' });
    const map = (multi as any).sessionAdapterMap as Map<string, unknown>;
    expect(map.has(meta.sessionId)).toBe(true);

    // Simulate natural session end (what AcpAdapter fires on process exit)
    acp.onSessionEnd?.(meta.sessionId, {});
    expect(map.has(meta.sessionId)).toBe(false);
  });

  it('preserves externally-assigned onSessionEnd handlers', async () => {
    const acp = new FakeAdapter();
    const multi = new MultiAdapter(acp);
    const meta = await multi.spawn({ role: 'worker', cwd: '/tmp' });

    // Gateway-style assignment AFTER MultiAdapter construction
    const seen: string[] = [];
    acp.onSessionEnd = (sessionId) => { seen.push(sessionId); };

    acp.onSessionEnd?.(meta.sessionId, {});
    expect(seen).toEqual([meta.sessionId]);
    expect(((multi as any).sessionAdapterMap as Map<string, unknown>).has(meta.sessionId)).toBe(false);
  });
});

import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '@flightdeck-ai/shared';
import { RUNTIME_REGISTRY } from './runtimes.js';

/**
 * Composite adapter that delegates to AcpAdapter or PtyAdapter
 * based on the runtime's adapter type in RUNTIME_REGISTRY.
 */
export class MultiAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp'; // default
  private acpAdapter: AgentAdapter;
  private ptyAdapter: AgentAdapter;
  /** Maps sessionId → adapter for routing steer/kill/getMetadata */
  private sessionAdapterMap = new Map<string, AgentAdapter>();

  constructor(acpAdapter: AgentAdapter, ptyAdapter: AgentAdapter) {
    super();
    this.acpAdapter = acpAdapter;
    this.ptyAdapter = ptyAdapter;
  }

  private pickAdapter(runtime?: string): AgentAdapter {
    if (!runtime) return this.acpAdapter;
    const def = RUNTIME_REGISTRY[runtime];
    if (def?.adapter === 'pty') return this.ptyAdapter;
    return this.acpAdapter;
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const adapter = this.pickAdapter(opts.runtime);
    const meta = await adapter.spawn(opts);
    this.sessionAdapterMap.set(meta.sessionId, adapter);
    return meta;
  }

  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const adapter = this.sessionAdapterMap.get(sessionId) ?? this.acpAdapter;
    return adapter.steer(sessionId, message);
  }

  async kill(sessionId: string): Promise<void> {
    const adapter = this.sessionAdapterMap.get(sessionId) ?? this.acpAdapter;
    await adapter.kill(sessionId);
    this.sessionAdapterMap.delete(sessionId);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const adapter = this.sessionAdapterMap.get(sessionId) ?? this.acpAdapter;
    return adapter.getMetadata(sessionId);
  }

  /** Expose ACP adapter for session-end callbacks etc. */
  getAcpAdapter(): AgentAdapter { return this.acpAdapter; }
  getPtyAdapter(): AgentAdapter { return this.ptyAdapter; }
}

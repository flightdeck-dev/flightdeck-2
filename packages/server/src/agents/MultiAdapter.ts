import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '@flightdeck-ai/shared';
import { RUNTIME_REGISTRY } from './runtimes.js';

/**
 * Composite adapter that delegates to AcpAdapter or CopilotSdkAdapter
 * based on the runtime's adapter type in RUNTIME_REGISTRY.
 */
export class MultiAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp'; // default
  private acpAdapter: AgentAdapter;
  private copilotSdkAdapter: AgentAdapter | null;
  /** Maps sessionId → adapter for routing steer/kill/getMetadata */
  private sessionAdapterMap = new Map<string, AgentAdapter>();

  constructor(acpAdapter: AgentAdapter, copilotSdkAdapter?: AgentAdapter | null) {
    super();
    this.acpAdapter = acpAdapter;
    this.copilotSdkAdapter = copilotSdkAdapter ?? null;
    this.hookSessionEnd(this.acpAdapter);
    if (this.copilotSdkAdapter) this.hookSessionEnd(this.copilotSdkAdapter);
  }

  /**
   * Drop sessionAdapterMap entries when sessions end naturally (crash, exit) —
   * kill() is not the only way sessions die, and without this the map grows
   * for the lifetime of the gateway. Implemented as a transparent property
   * hook so consumers (gateway, facade) can still assign onSessionEnd later.
   */
  private hookSessionEnd(adapter: AgentAdapter): void {
    let external: ((sessionId: string, session: unknown) => void) | null =
      (adapter as { onSessionEnd?: ((sessionId: string, session: unknown) => void) | null }).onSessionEnd ?? null;
    const wrapper = (sessionId: string, session: unknown) => {
      this.sessionAdapterMap.delete(sessionId);
      if (external) { try { external(sessionId, session); } catch { /* consumer errors are not ours */ } }
    };
    Object.defineProperty(adapter, 'onSessionEnd', {
      get: () => wrapper,
      set: (fn) => { external = fn; },
      configurable: true,
      enumerable: true,
    });
  }

  private pickAdapter(runtime?: string): AgentAdapter {
    if (!runtime) return this.acpAdapter;
    const def = RUNTIME_REGISTRY[runtime];
    if (def?.adapter === 'copilot-sdk' && this.copilotSdkAdapter) return this.copilotSdkAdapter;
    return this.acpAdapter;
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const adapter = this.pickAdapter(opts.runtime);
    const meta = await adapter.spawn(opts);
    this.sessionAdapterMap.set(meta.sessionId, adapter);
    return meta;
  }

  override async resumeSession(opts: { previousSessionId: string; cwd: string; role: string; agentId?: string; model?: string; projectName?: string; runtime?: string }): Promise<AgentMetadata> {
    const adapter = this.pickAdapter(opts.runtime);
    const meta = await adapter.resumeSession(opts);
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
  getCopilotSdkAdapter(): AgentAdapter | null { return this.copilotSdkAdapter; }

  override getSession(sessionId: string): { output: string } | undefined {
    const adapter = this.sessionAdapterMap.get(sessionId) ?? this.acpAdapter;
    return adapter.getSession(sessionId);
  }
}

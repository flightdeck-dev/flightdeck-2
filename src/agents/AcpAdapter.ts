import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '../core/types.js';
import { agentId } from '../core/ids.js';
import { SessionManager, type RuntimeConfig } from './SessionManager.js';

/**
 * ACP-native agent adapter.
 * Spawns coding agents (Codex, Gemini CLI, etc.) as child processes
 * and tracks their lifecycle via process state.
 */
export class AcpAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  private sessionManager: SessionManager;
  private runtimeName: string;

  constructor(
    sessionManager?: SessionManager,
    runtimeName: string = 'codex',
  ) {
    super();
    this.sessionManager = sessionManager ?? new SessionManager();
    this.runtimeName = runtimeName;
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const prompt = opts.systemPrompt ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const session = this.sessionManager.spawn(
      agentId(opts.role, Date.now().toString()),
      this.runtimeName,
      opts.cwd,
      prompt,
    );

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: 'running',
      model: opts.model,
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    const prefix = message.urgent ? '[URGENT] ' : '';
    this.sessionManager.steer(sessionId, prefix + message.content);
  }

  async kill(sessionId: string): Promise<void> {
    this.sessionManager.kill(sessionId);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;

    const statusMap = {
      active: 'running' as const,
      idle: 'idle' as const,
      ended: 'ended' as const,
    };

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: statusMap[session.status],
    };
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }
}

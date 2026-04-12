import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '@flightdeck-ai/shared';
import { agentId } from '@flightdeck-ai/shared';
import { SessionManager } from './SessionManager.js';

/**
 * PTY/subprocess agent adapter for Claude Code and similar CLI agents
 * that don't support ACP natively.
 * 
 * Uses child_process.spawn with piped stdio (via SessionManager)
 * to control CLI agents that need interactive stdin/stdout communication.
 */
export class PtyAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'pty';
  private sessionManager: SessionManager;
  private runtimeName: string;

  constructor(
    sessionManager?: SessionManager,
    runtimeName: string = 'claude',
  ) {
    super();
    this.sessionManager = sessionManager ?? new SessionManager();
    this.runtimeName = runtimeName;
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const prompt = opts.systemPrompt ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const session = this.sessionManager.spawn(
      agentId(opts.role, 'pty', Date.now().toString()),
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

  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const prefix = message.urgent ? '[URGENT] ' : '';
    this.sessionManager.steer(sessionId, prefix + message.content);
    return '';
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

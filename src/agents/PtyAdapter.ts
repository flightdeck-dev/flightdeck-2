import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '../core/types.js';
import { agentId } from '../core/ids.js';

/**
 * PTY/tmux agent adapter for Claude Code and similar CLI agents.
 * Stub implementation — real version would use tmux sessions.
 */
export class PtyAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'pty';

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const id = agentId(opts.role, 'pty', Date.now().toString());
    const sessionId = `pty-session-${id}`;
    return {
      agentId: id,
      sessionId,
      status: 'running',
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    // Stub: would send keys to tmux session
  }

  async kill(sessionId: string): Promise<void> {
    // Stub: would kill tmux session
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    // Stub: would parse tmux output for best-effort metadata
    return null;
  }
}

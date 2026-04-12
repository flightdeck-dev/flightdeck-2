import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '../core/types.js';
import { agentId } from '../core/ids.js';

/**
 * ACP-native agent adapter.
 * Uses the ACP protocol (Agent Communication Protocol) to spawn/steer/kill agents.
 * This is a stub — real implementation would call OpenClaw or ACP-compatible runtime.
 */
export class AcpAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    // Stub: would call ACP spawn endpoint
    const id = agentId(opts.role, Date.now().toString());
    const sessionId = `acp-session-${id}`;
    return {
      agentId: id,
      sessionId,
      status: 'running',
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    // Stub: would send ACP steer message
  }

  async kill(sessionId: string): Promise<void> {
    // Stub: would call ACP kill
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    // Stub
    return null;
  }
}

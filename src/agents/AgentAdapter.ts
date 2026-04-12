import type { AgentId, AgentRole, AgentRuntime } from '../core/types.js';

export interface SpawnOptions {
  role: AgentRole;
  cwd: string;
  model?: string;
  systemPrompt?: string;
}

export interface SteerMessage {
  content: string;
  urgent?: boolean;
}

export interface AgentMetadata {
  agentId: AgentId;
  sessionId: string;
  status: 'running' | 'idle' | 'ended';
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  turnCount?: number;
}

/**
 * Abstract interface for controlling agent lifecycle.
 * Implementations: AcpAdapter (native ACP), PtyAdapter (tmux/PTY).
 */
export abstract class AgentAdapter {
  abstract readonly runtime: AgentRuntime;

  abstract spawn(opts: SpawnOptions): Promise<AgentMetadata>;
  abstract steer(sessionId: string, message: SteerMessage): Promise<void>;
  abstract kill(sessionId: string): Promise<void>;
  abstract getMetadata(sessionId: string): Promise<AgentMetadata | null>;
}

import type { AgentId, AgentRole, AgentRuntime } from '@flightdeck-ai/shared';
import type { McpServer } from '@agentclientprotocol/sdk';

export interface SpawnOptions {
  role: AgentRole;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  /** MCP servers to inject into the agent session (ACP only). */
  mcpServers?: McpServer[];
  /** Claude Code _meta.systemPrompt injection. String replaces default; { append } appends. */
  systemPromptMeta?: string | { append: string };
  /** Project name — passed as FLIGHTDECK_PROJECT env to MCP server. */
  projectName?: string;
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
  abstract steer(sessionId: string, message: SteerMessage): Promise<string>;
  abstract kill(sessionId: string): Promise<void>;
  abstract getMetadata(sessionId: string): Promise<AgentMetadata | null>;
}

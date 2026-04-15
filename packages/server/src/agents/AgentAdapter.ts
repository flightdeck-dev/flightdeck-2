import type { AgentId, AgentRole, AgentRuntime } from '@flightdeck-ai/shared';
import type { McpServer } from '@agentclientprotocol/sdk';

export interface SpawnOptions {
  role: AgentRole;
  cwd: string;
  model?: string;
  /** Runtime name override (e.g. 'copilot', 'opencode', 'cursor', 'codex-acp').
   *  If not set, the adapter's default runtime is used. */
  runtime?: string;
  systemPrompt?: string;
  /** MCP servers to inject into the agent session (ACP only). */
  mcpServers?: McpServer[];
  /** Claude Code _meta.systemPrompt injection. String replaces default; { append } appends. */
  systemPromptMeta?: string | { append: string };
  /** Project name — passed as FLIGHTDECK_PROJECT env to MCP server. */
  projectName?: string;
  /** Tools the agent is allowed to use (passed via _meta for Claude Code). */
  allowedTools?: string[];
  /** Maximum number of agentic turns (passed via _meta for Claude Code). */
  maxTurns?: number;
}

export interface SteerMessage {
  content: string;
  urgent?: boolean;
  sourceMessageId?: string;
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

  /** Resume a previously saved session. Not all adapters support this. */
  async resumeSession(_opts: { previousSessionId: string; cwd: string; role: string; model?: string; projectName?: string }): Promise<AgentMetadata> {
    throw new Error('resumeSession not supported by this adapter');
  }

  /** Get session details. Not all adapters support this. */
  getSession(_sessionId: string): { output: string } | undefined {
    return undefined;
  }
}

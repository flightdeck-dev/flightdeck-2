import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '@flightdeck-ai/shared';
import { agentId } from '@flightdeck-ai/shared';
import { SessionManager } from './SessionManager.js';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

/**
 * PTY/subprocess agent adapter for Claude Code and similar CLI agents
 * that don't support ACP natively.
 *
 * For Claude Code, uses stream-json mode for structured I/O:
 *   claude --print --output-format stream-json --input-format stream-json
 *
 * Creates a temporary MCP config file per session to inject the
 * Flightdeck MCP server without touching user's global config.
 */
export class PtyAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'pty';
  private sessionManager: SessionManager;
  private runtimeName: string;
  private mcpConfigPaths = new Map<string, string>();

  constructor(
    sessionManager?: SessionManager,
    runtimeName: string = 'claude',
  ) {
    super();
    this.sessionManager = sessionManager ?? new SessionManager();
    this.runtimeName = runtimeName;
  }

  /**
   * Create a temporary MCP config file for a session.
   * This injects the Flightdeck MCP server so the agent can use
   * task_list, task_submit, etc. without modifying user's global config.
   */
  private createMcpConfig(agentIdStr: string, role: string, projectName?: string): string {
    const mcpBinPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/flightdeck-mcp.mjs');
    const config = {
      mcpServers: {
        flightdeck: {
          command: 'node',
          args: [mcpBinPath],
          env: {
            FLIGHTDECK_AGENT_ID: agentIdStr,
            FLIGHTDECK_AGENT_ROLE: role ?? '',
            ...(projectName ? { FLIGHTDECK_PROJECT: projectName } : {}),
          },
        },
      },
    };

    const configDir = join(tmpdir(), 'flightdeck-mcp-configs');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, `mcp-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const aid = agentId(opts.role, 'pty', Date.now().toString());
    const prompt = opts.systemPrompt ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;

    // Create MCP config file for this session
    const mcpConfigPath = this.createMcpConfig(aid, opts.role, opts.projectName);

    const session = this.sessionManager.spawn(
      aid,
      this.runtimeName,
      opts.cwd,
      prompt,
      { mcpConfig: mcpConfigPath },
    );

    this.mcpConfigPaths.set(session.id, mcpConfigPath);

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: 'running',
      model: opts.model,
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.status === 'ended') return '';

    // For stream-json mode, send a JSON message on stdin
    const prefix = message.urgent ? '[URGENT] ' : '';
    const jsonMsg = JSON.stringify({ type: 'user_message', content: prefix + message.content });
    this.sessionManager.steer(sessionId, jsonMsg);
    return '';
  }

  async kill(sessionId: string): Promise<void> {
    this.sessionManager.kill(sessionId);
    // Clean up MCP config file
    const configPath = this.mcpConfigPaths.get(sessionId);
    if (configPath) {
      try { unlinkSync(configPath); } catch { /* already gone */ }
      this.mcpConfigPaths.delete(sessionId);
    }
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

import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentRuntime } from '@flightdeck-ai/shared';
import { agentId } from '@flightdeck-ai/shared';
import { SessionManager } from './SessionManager.js';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn as cpSpawn } from 'node:child_process';
import { RUNTIME_REGISTRY } from './runtimes.js';

/**
 * PTY/subprocess agent adapter for Claude Code and similar CLI agents
 * that use --print mode (one-shot per invocation).
 *
 * For Claude Code, each interaction spawns a new process:
 *   claude --print --resume <sessionId> --output-format stream-json ...
 *
 * Session persistence is handled by the CLI itself (saves to disk).
 * --resume allows continuing the same conversation across invocations.
 */
export class PtyAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'pty';
  private sessionManager: SessionManager;
  private runtimeName: string;
  private mcpConfigPaths = new Map<string, string>();
  onSessionTurnStart: ((sessionId: string, agentId: string) => void) | null = null;
  onSessionTurnEnd: ((sessionId: string, agentId: string) => void) | null = null;
  /** Tracks session state for --print mode agents (process exits after each turn) */
  private printSessions = new Map<string, {
    agentId: string;
    claudeSessionId: string; // The session ID for --resume
    cwd: string;
    status: 'idle' | 'running' | 'ended';
    output: string;
    model?: string;
    mcpConfigPath?: string;
    role: string;
  }>();

  constructor(
    sessionManager?: SessionManager,
    runtimeName: string = 'claude-code',
  ) {
    super();
    this.runtimeName = runtimeName;
    this.sessionManager = sessionManager ?? new SessionManager();
  }

  /**
   * Create a temporary MCP config for Flightdeck tools.
   */
  private createMcpConfig(aid: string, role: string, projectName?: string): string {
    const tmpDir = join(tmpdir(), '.flightdeck-mcp');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, `${aid}.json`);
    const mcpBinPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/flightdeck-mcp.mjs');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        flightdeck: {
          command: 'node',
          args: [mcpBinPath, '--project', projectName ?? 'default'],
          env: {
            FLIGHTDECK_AGENT_ID: aid,
            FLIGHTDECK_AGENT_ROLE: role,
          },
        },
      },
    }, null, 2));
    return configPath;
  }

  /**
   * Run claude --print with given prompt, optionally resuming a session.
   * Returns collected output.
   */
  private async runClaude(opts: {
    cwd: string;
    prompt: string;
    sessionId?: string;
    model?: string;
    systemPrompt?: string;
    mcpConfigPath?: string;
  }): Promise<{ output: string; claudeSessionId?: string }> {
    const runtime = RUNTIME_REGISTRY[this.runtimeName];
    if (!runtime) throw new Error(`Unknown runtime: ${this.runtimeName}`);

    const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.systemPrompt && !opts.sessionId) {
      // Only set system prompt on first run (resume carries it forward)
      args.push('--system-prompt', opts.systemPrompt);
    }
    if (opts.mcpConfigPath) {
      args.push('--mcp-config', opts.mcpConfigPath);
    }
    args.push('--permission-mode', 'auto');
    // Prompt goes as positional argument for --print mode
    args.push(opts.prompt);

    return new Promise<{ output: string; claudeSessionId?: string }>((resolve, reject) => {
      const child = cpSpawn(runtime.command, args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let claudeSessionId: string | undefined;

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      // stdin not used in --print mode (prompt is a CLI argument)
      child.stdin.end();


      child.on('close', (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          // Parse stream-json output (one JSON object per line)
          let textOutput = '';
          for (const line of stdout.split('\n').filter(Boolean)) {
            try {
              const event = JSON.parse(line);
              // Capture session ID from result event
              if (event.session_id) claudeSessionId = event.session_id;
              // Extract text from assistant messages
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text') textOutput += block.text;
                }
              }
              // Extract from content_block_delta
              if (event.type === 'content_block_delta' && event.delta?.text) {
                textOutput += event.delta.text;
              }
              // Extract from result
              if (event.type === 'result' && event.result) {
                textOutput = event.result;
              }
            } catch { /* not valid JSON line */ }
          }
          resolve({ output: textOutput || stdout, claudeSessionId });
        }
      });
    });
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const aid = agentId(opts.role, 'pty', Date.now().toString());
    const prompt = opts.systemPrompt ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const mcpConfigPath = this.createMcpConfig(aid, opts.role, opts.projectName);
    const sessionId = `pty-${randomUUID().slice(0, 8)}`;

    // Run initial prompt
    try {
      const result = await this.runClaude({
        cwd: opts.cwd,
        prompt,
        model: opts.model,
        systemPrompt: prompt,
        mcpConfigPath,
      });

      this.printSessions.set(sessionId, {
        agentId: aid,
        claudeSessionId: result.claudeSessionId ?? sessionId,
        cwd: opts.cwd,
        status: 'idle',
        output: result.output,
        model: opts.model,
        mcpConfigPath,
        role: opts.role,
      });
    } catch (err) {
      // Even if first run fails, create session entry for retry
      this.printSessions.set(sessionId, {
        agentId: aid,
        claudeSessionId: sessionId,
        cwd: opts.cwd,
        status: 'idle',
        output: `Spawn error: ${err instanceof Error ? err.message : String(err)}`,
        model: opts.model,
        mcpConfigPath,
        role: opts.role,
      });
    }

    return {
      agentId: aid,
      sessionId,
      status: 'running' as const,
      model: opts.model,
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const session = this.printSessions.get(sessionId);
    if (!session || session.status === 'ended') return '';

    session.status = 'running';
    if (this.onSessionTurnStart) {
      try { this.onSessionTurnStart(sessionId, session.agentId); } catch { /* */ }
    }
    try {
      const result = await this.runClaude({
        cwd: session.cwd,
        prompt: (message.urgent ? '[URGENT] ' : '') + message.content,
        sessionId: session.claudeSessionId, // --resume
        model: session.model,
        mcpConfigPath: session.mcpConfigPath,
      });

      session.output += '\n' + result.output;
      // Update session ID if claude returned one
      if (result.claudeSessionId) session.claudeSessionId = result.claudeSessionId;
      session.status = 'idle';
      if (this.onSessionTurnEnd) {
        try { this.onSessionTurnEnd(sessionId, session.agentId); } catch { /* */ }
      }
      return result.output;
    } catch (err) {
      session.status = 'idle';
      if (this.onSessionTurnEnd) {
        try { this.onSessionTurnEnd(sessionId, session.agentId); } catch { /* */ }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PtyAdapter] steer failed for ${sessionId}: ${errMsg}`);
      return `Error: ${errMsg}`;
    }
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.printSessions.get(sessionId);
    if (session) {
      session.status = 'ended';
      // Clean up MCP config
      if (session.mcpConfigPath) {
        try { unlinkSync(session.mcpConfigPath); } catch { /* */ }
      }
    }
    // Also try legacy SessionManager
    this.sessionManager.kill(sessionId);
    const configPath = this.mcpConfigPaths.get(sessionId);
    if (configPath) {
      try { unlinkSync(configPath); } catch { /* */ }
      this.mcpConfigPaths.delete(sessionId);
    }
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const session = this.printSessions.get(sessionId);
    if (session) {
      return {
        agentId: session.agentId as any,
        sessionId,
        status: session.status === 'running' ? 'running' : session.status === 'ended' ? 'ended' : 'idle',
      };
    }
    // Legacy fallback
    const legacySession = this.sessionManager.getSession(sessionId);
    if (!legacySession) return null;
    return {
      agentId: legacySession.agentId,
      sessionId: legacySession.id,
      status: legacySession.status === 'active' ? 'running' : legacySession.status === 'ended' ? 'ended' : 'idle',
    };
  }

  override getSession(sessionId: string): { output: string } | undefined {
    const session = this.printSessions.get(sessionId);
    if (session) return { output: session.output };
    return undefined;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }
}

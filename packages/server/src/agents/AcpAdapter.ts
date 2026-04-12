import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  McpServer,
  AgentCapabilities,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
} from '@agentclientprotocol/sdk';
import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentId, AgentRuntime } from '@flightdeck-ai/shared';
import { agentId } from '@flightdeck-ai/shared';
import type { RuntimeConfig } from './SessionManager.js';
import { DEFAULT_RUNTIMES } from './SessionManager.js';

export type AcpSessionStatus = 'initializing' | 'active' | 'prompting' | 'ended';

/**
 * Tracks a terminal spawned on behalf of the agent.
 */
interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  outputByteLimit: number;
  released: boolean;
}

/**
 * Tracks an ACP connection to a spawned agent process.
 */
export interface AcpSession {
  id: string;
  agentId: AgentId;
  process: ChildProcess;
  connection: ClientSideConnection;
  acpSessionId: string | null; // set after newSession/loadSession completes
  status: AcpSessionStatus;
  startedAt: Date;
  lastActivityAt: Date;
  cwd: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  turnCount: number;
  output: string;          // accumulated agent text output
  exitCode: number | null;
  error: string | null;
  agentCapabilities: AgentCapabilities | null;
  terminals: Map<string, ManagedTerminal>;
}

function interpolateArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map(a => {
    let result = a;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replaceAll(`{${k}}`, v);
    }
    return result;
  });
}

/**
 * ACP-native agent adapter using the official @agentclientprotocol/sdk.
 *
 * Flightdeck is the ACP **Client** — it provides filesystem and terminal
 * capabilities to agents. Agents are the **Agents** — they manage sessions,
 * process prompts, and make tool calls.
 *
 * Key protocol features:
 * - MCP server injection via session/new mcpServers parameter
 * - Session loading via session/load for resuming after restart
 * - Client-side fs (read/write) and terminal execution
 * - Permission management (auto-approve at Flightdeck level)
 */
export class AcpAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  private sessions = new Map<string, AcpSession>();
  private runtimes: Record<string, RuntimeConfig>;
  private runtimeName: string;
  private cleanupRegistered = false;

  constructor(
    runtimes?: Record<string, RuntimeConfig>,
    runtimeName: string = 'codex',
  ) {
    super();
    this.runtimes = runtimes ?? DEFAULT_RUNTIMES;
    this.runtimeName = runtimeName;
    this.registerCleanup();
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => {
      for (const session of this.sessions.values()) {
        if (session.status !== 'ended') {
          try { session.process.kill('SIGTERM'); } catch { /* already dead */ }
        }
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  }

  /**
   * Build the Client implementation that Flightdeck provides to the agent.
   * This is the core of "Flightdeck = Client" — we provide fs + terminal capabilities.
   */
  private buildClient(session: AcpSession): Client {
    return {
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // Auto-approve all permissions (Flightdeck manages permissions at a higher level)
        const allowOption = params.options.find(o => o.kind === 'allow_always')
          ?? params.options.find(o => o.kind === 'allow_once')
          ?? params.options[0];
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption?.optionId ?? params.options[0]?.optionId ?? '',
          },
        };
      },

      async sessionUpdate(params: SessionNotification): Promise<void> {
        session.lastActivityAt = new Date();
        const update = params.update;

        switch (update.sessionUpdate) {
          case 'agent_message_chunk':
            if (update.content.type === 'text') {
              session.output += update.content.text;
            }
            break;
          case 'usage_update':
            session.tokensIn = update.used;
            session.tokensOut = update.size;
            break;
          case 'tool_call':
          case 'tool_call_update':
          case 'plan':
          case 'agent_thought_chunk':
            break;
          default:
            break;
        }
      },

      // --- Filesystem capabilities (Client provides these to the Agent) ---

      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        const filePath = path.resolve(session.cwd, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content, 'utf-8');
        return {};
      },

      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        const filePath = path.resolve(session.cwd, params.path);
        const content = await fs.readFile(filePath, 'utf-8');

        if (params.line != null || params.limit != null) {
          const lines = content.split('\n');
          const start = (params.line ?? 1) - 1; // 1-based to 0-based
          const end = params.limit != null ? start + params.limit : lines.length;
          return { content: lines.slice(start, end).join('\n') };
        }

        return { content };
      },

      // --- Terminal capabilities (Client provides these to the Agent) ---

      async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
        const termId = `term-${randomUUID().slice(0, 8)}`;
        const cwd = params.cwd ?? session.cwd;
        const env: Record<string, string> = { ...process.env as Record<string, string> };
        if (params.env) {
          for (const { name, value } of params.env) {
            env[name] = value;
          }
        }

        const child = cpSpawn(params.command, params.args ?? [], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });

        const terminal: ManagedTerminal = {
          id: termId,
          process: child,
          output: '',
          truncated: false,
          exitCode: null,
          signal: null,
          outputByteLimit: params.outputByteLimit ?? 1024 * 1024, // 1MB default
          released: false,
        };

        const appendOutput = (data: Buffer) => {
          if (terminal.released) return;
          terminal.output += data.toString();
          // Enforce byte limit (truncate from beginning)
          if (Buffer.byteLength(terminal.output) > terminal.outputByteLimit) {
            const buf = Buffer.from(terminal.output);
            terminal.output = buf.subarray(buf.length - terminal.outputByteLimit).toString();
            terminal.truncated = true;
          }
        };

        child.stdout?.on('data', appendOutput);
        child.stderr?.on('data', appendOutput);
        child.on('close', (code, signal) => {
          terminal.exitCode = code;
          terminal.signal = signal;
        });

        session.terminals.set(termId, terminal);
        return { terminalId: termId };
      },

      async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
        const terminal = session.terminals.get(params.terminalId);
        if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);

        return {
          output: terminal.output,
          truncated: terminal.truncated,
          ...(terminal.exitCode !== null || terminal.signal !== null
            ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }
            : {}),
        };
      },

      async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
        const terminal = session.terminals.get(params.terminalId);
        if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);

        terminal.released = true;
        if (terminal.exitCode === null && terminal.signal === null) {
          try { terminal.process.kill('SIGTERM'); } catch { /* already dead */ }
        }
        session.terminals.delete(params.terminalId);
        return {};
      },

      async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
        const terminal = session.terminals.get(params.terminalId);
        if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);

        // If already exited, return immediately
        if (terminal.exitCode !== null || terminal.signal !== null) {
          return { exitCode: terminal.exitCode, signal: terminal.signal };
        }

        // Wait for exit
        return new Promise((resolve) => {
          terminal.process.on('close', (code, signal) => {
            resolve({ exitCode: code, signal });
          });
        });
      },

      async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
        const terminal = session.terminals.get(params.terminalId);
        if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);

        if (terminal.exitCode === null && terminal.signal === null) {
          try { terminal.process.kill('SIGTERM'); } catch { /* already dead */ }
        }
        return {};
      },
    };
  }

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    const runtime = this.runtimes[this.runtimeName];
    if (!runtime) {
      throw new Error(`Unknown runtime "${this.runtimeName}". Available: ${Object.keys(this.runtimes).join(', ')}`);
    }

    const prompt = opts.systemPrompt ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const args = interpolateArgs(runtime.args, { prompt, cwd: opts.cwd });
    const sessionLocalId = `acp-${randomUUID().slice(0, 8)}`;
    const aid = agentId(opts.role, Date.now().toString());

    // Spawn the agent process
    const child = cpSpawn(runtime.command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const now = new Date();
    const session: AcpSession = {
      id: sessionLocalId,
      agentId: aid,
      process: child,
      connection: null!, // set below
      acpSessionId: null,
      status: 'initializing',
      startedAt: now,
      lastActivityAt: now,
      cwd: opts.cwd,
      model: opts.model,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
      output: '',
      exitCode: null,
      error: null,
      agentCapabilities: null,
      terminals: new Map(),
    };

    // Collect stderr for diagnostics
    child.stderr?.on('data', (data: Buffer) => {
      session.error = (session.error ?? '') + data.toString();
    });

    child.on('close', (code) => {
      session.status = 'ended';
      session.exitCode = code;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      session.status = 'ended';
      session.exitCode = -1;
      session.error = (session.error ?? '') + `\nProcess error: ${err.message}`;
      if (err.code === 'ENOENT') {
        session.error += `\nCommand not found: ${runtime.command}. Is it installed?`;
      }
    });

    // Create ACP connection over stdin/stdout ndjson
    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const client = this.buildClient(session);
    const connection = new ClientSideConnection((_agent: Agent) => client, stream);
    session.connection = connection;
    this.sessions.set(sessionLocalId, session);

    // Initialize + create session in background (don't block spawn)
    this.initializeSession(session, prompt, opts.mcpServers, opts.systemPromptMeta).catch(err => {
      session.error = (session.error ?? '') + `\nACP init error: ${err.message}`;
    });

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: 'running',
      model: opts.model,
    };
  }

  private async initializeSession(
    session: AcpSession,
    prompt: string,
    mcpServers?: McpServer[],
    systemPromptMeta?: string | { append: string },
  ): Promise<void> {
    try {
      const initResult = await session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'flightdeck', version: '0.1.0' },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });

      // Store agent capabilities for later use (e.g., loadSession support)
      session.agentCapabilities = initResult.agentCapabilities ?? null;

      // Build _meta for runtime-specific extensions (e.g., Claude Code systemPrompt)
      const meta: Record<string, unknown> = {};
      if (systemPromptMeta) {
        meta.systemPrompt = systemPromptMeta;
      }

      const result = await session.connection.newSession({
        cwd: session.cwd,
        mcpServers: mcpServers ?? [
          {
            name: 'flightdeck',
            command: 'npx',
            args: ['tsx', new URL('../mcp/server.ts', import.meta.url).pathname],
            env: { FLIGHTDECK_AGENT_ID: session.agentId },
          } as any,
        ],
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      });

      session.acpSessionId = result.sessionId;
      session.status = 'active';
      session.lastActivityAt = new Date();

      // Send the initial prompt
      session.status = 'prompting';
      session.turnCount++;
      await session.connection.prompt({
        sessionId: result.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      session.status = 'active';
      session.lastActivityAt = new Date();
    } catch (err: any) {
      if (session.status !== 'ended') {
        session.error = (session.error ?? '') + `\nACP error: ${err.message}`;
      }
    }
  }

  /**
   * Resume a previous ACP session by loading it (session/load).
   * Only works if the agent advertises the loadSession capability.
   */
  async resumeSession(opts: {
    previousSessionId: string;
    cwd: string;
    role: string;
    model?: string;
    mcpServers?: McpServer[];
  }): Promise<AgentMetadata> {
    const runtime = this.runtimes[this.runtimeName];
    if (!runtime) {
      throw new Error(`Unknown runtime "${this.runtimeName}". Available: ${Object.keys(this.runtimes).join(', ')}`);
    }

    const sessionLocalId = `acp-${randomUUID().slice(0, 8)}`;
    const aid = agentId(opts.role, Date.now().toString());

    const child = cpSpawn(runtime.command, runtime.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const now = new Date();
    const session: AcpSession = {
      id: sessionLocalId,
      agentId: aid,
      process: child,
      connection: null!,
      acpSessionId: null,
      status: 'initializing',
      startedAt: now,
      lastActivityAt: now,
      cwd: opts.cwd,
      model: opts.model,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
      output: '',
      exitCode: null,
      error: null,
      agentCapabilities: null,
      terminals: new Map(),
    };

    child.stderr?.on('data', (data: Buffer) => {
      session.error = (session.error ?? '') + data.toString();
    });
    child.on('close', (code) => {
      session.status = 'ended';
      session.exitCode = code;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      session.status = 'ended';
      session.exitCode = -1;
      session.error = (session.error ?? '') + `\nProcess error: ${err.message}`;
    });

    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const client = this.buildClient(session);
    const connection = new ClientSideConnection((_agent: Agent) => client, stream);
    session.connection = connection;
    this.sessions.set(sessionLocalId, session);

    // Initialize then load session
    this.loadExistingSession(session, opts.previousSessionId, opts.mcpServers).catch(err => {
      session.error = (session.error ?? '') + `\nACP load error: ${err.message}`;
    });

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: 'running',
      model: opts.model,
    };
  }

  private async loadExistingSession(
    session: AcpSession,
    previousSessionId: string,
    mcpServers?: McpServer[],
  ): Promise<void> {
    try {
      const initResult = await session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'flightdeck', version: '0.1.0' },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });

      session.agentCapabilities = initResult.agentCapabilities ?? null;

      if (!session.agentCapabilities?.loadSession) {
        throw new Error('Agent does not support session/load. Cannot resume session.');
      }

      const result = await session.connection.loadSession({
        sessionId: previousSessionId,
        cwd: session.cwd,
        mcpServers: mcpServers ?? [],
      });

      // loadSession uses the same sessionId we passed in
      session.acpSessionId = previousSessionId;
      session.status = 'active';
      session.lastActivityAt = new Date();
    } catch (err: any) {
      if (session.status === 'initializing') {
        session.error = (session.error ?? '') + `\nACP load error: ${err.message}`;
      }
    }
  }

  /**
   * Check if a session's agent supports session loading.
   */
  supportsLoadSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.agentCapabilities?.loadSession === true;
  }

  /**
   * Get the ACP session ID (for use with resumeSession later).
   */
  getAcpSessionId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.acpSessionId ?? null;
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') throw new Error(`Session already ended: ${sessionId}`);

    if (!session.acpSessionId) {
      throw new Error(`Session not yet initialized: ${sessionId}`);
    }

    const prefix = message.urgent ? '[URGENT] ' : '';
    session.turnCount++;
    session.status = 'prompting';

    try {
      await session.connection.prompt({
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text: prefix + message.content }],
      });
      session.status = 'active';
    } catch (err: any) {
      // Process close handler may have set status to 'ended' concurrently
      if ((session.status as AcpSessionStatus) !== 'ended') {
        session.error = (session.error ?? '') + `\nSteer error: ${err.message}`;
        session.status = 'active';
      }
    }
    session.lastActivityAt = new Date();
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') return;

    // Release all terminals
    for (const terminal of session.terminals.values()) {
      if (!terminal.released && terminal.exitCode === null) {
        try { terminal.process.kill('SIGTERM'); } catch { /* */ }
      }
    }
    session.terminals.clear();

    // Try to cancel via ACP first
    if (session.acpSessionId) {
      try {
        await session.connection.cancel({ sessionId: session.acpSessionId });
      } catch { /* best effort */ }
    }

    // Then kill the process
    try {
      session.process.kill('SIGTERM');
      setTimeout(() => {
        if (session.status !== 'ended') {
          try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 5000);
    } catch { /* already dead */ }
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const statusMap: Record<AcpSessionStatus, AgentMetadata['status']> = {
      initializing: 'running',
      active: 'idle',
      prompting: 'running',
      ended: 'ended',
    };

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: statusMap[session.status],
      model: session.model,
      tokensIn: session.tokensIn,
      tokensOut: session.tokensOut,
      turnCount: session.turnCount,
    };
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): AcpSession[] {
    return [...this.sessions.values()].filter(s => s.status !== 'ended');
  }

  getAllSessions(): AcpSession[] {
    return [...this.sessions.values()];
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== 'ended') {
        try { session.process.kill('SIGTERM'); } catch { /* */ }
      }
      for (const terminal of session.terminals.values()) {
        if (!terminal.released && terminal.exitCode === null) {
          try { terminal.process.kill('SIGTERM'); } catch { /* */ }
        }
      }
    }
    this.sessions.clear();
  }
}

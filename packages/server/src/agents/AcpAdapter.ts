import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { modelRegistry } from './ModelTiers.js';

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
/** A queued prompt entry for the prompt queue system. */
export interface QueuedPrompt {
  content: string;
  priority: boolean;
  resolve?: (text: string) => void;
  reject?: (err: Error) => void;
}

export interface AcpSession {
  id: string;
  agentId: AgentId;
  role?: string;
  process: ChildProcess;
  connection: ClientSideConnection;
  acpSessionId: string | null; // set after newSession/loadSession completes
  status: AcpSessionStatus;
  startedAt: Date;
  lastActivityAt: Date;
  cwd: string;
  model?: string;
  projectName?: string;
  tokensIn: number;
  tokensOut: number;
  turnCount: number;
  output: string;          // accumulated agent text output
  exitCode: number | null;
  error: string | null;
  agentCapabilities: AgentCapabilities | null;
  terminals: Map<string, ManagedTerminal>;
  /** Whether a prompt() call is currently in-flight for this session. */
  isPrompting: boolean;
  /** Queue of messages received while a prompt was in-flight. */
  promptQueue: QueuedPrompt[];
}

import { interpolateArgs } from './interpolateArgs.js';

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
    process.once('exit', cleanup);
    // Don't call process.exit() here — let the gateway's signal handlers
    // save state and exit gracefully. We just clean up child processes.
    process.once('SIGINT', () => { cleanup(); });
    process.once('SIGTERM', () => { cleanup(); });
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
        // Lead and planner can only write to .flightdeck/ and memory/ directories
        // They should coordinate, not implement
        if (session.role === 'lead' || session.role === 'planner') {
          const rel = path.relative(session.cwd, filePath);
          const isAllowed = rel.startsWith('.flightdeck') || rel.startsWith('memory') || rel.endsWith('.md');
          if (!isAllowed) {
            throw new Error(`Role '${session.role}' cannot write to '${params.path}'. Only .flightdeck/, memory/, and .md files are allowed. Delegate implementation to worker agents.`);
          }
        }
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
        // Lead should not run arbitrary commands — only read operations
        if (session.role === 'lead') {
          const cmd = params.command.toLowerCase();
          const allowedLeadCmds = ['cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc', 'echo', 'flightdeck'];
          if (!allowedLeadCmds.some(c => cmd.startsWith(c) || cmd.endsWith('/' + c))) {
            throw new Error(`Role 'lead' cannot run '${params.command}'. Lead agents can only run read-only commands. Delegate implementation to worker agents.`);
          }
        }
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
        child.once('close', (code, signal) => {
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
          terminal.process.once('close', (code, signal) => {
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

    // Inject role + agent ID into Copilot process env.
    // Copilot's MCP subprocess inherits parent env, so the MCP server
    // (flightdeck-mcp) will see FLIGHTDECK_AGENT_ROLE for tool filtering.
    // The .mcp.json is written once at gateway start (no role env there).
    const spawnEnv = {
      ...process.env,
      FLIGHTDECK_AGENT_ID: aid,
      FLIGHTDECK_AGENT_ROLE: opts.role,
      ...(opts.projectName ? { FLIGHTDECK_PROJECT: opts.projectName } : {}),
    };

    // Spawn the agent process (detached: false ensures children die with parent)
    const child = cpSpawn(runtime.command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      detached: false,
    });

    const now = new Date();
    const session: AcpSession = {
      id: sessionLocalId,
      agentId: aid,
      role: opts.role,
      process: child,
      connection: null!, // set below
      acpSessionId: null,
      status: 'initializing',
      startedAt: now,
      lastActivityAt: now,
      cwd: opts.cwd,
      model: opts.model,
      projectName: opts.projectName,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
      output: '',
      exitCode: null,
      error: null,
      agentCapabilities: null,
      terminals: new Map(),
      isPrompting: false,
      promptQueue: [],
    };

    // Collect stderr for diagnostics
    child.stderr?.on('data', (data: Buffer) => {
      session.error = (session.error ?? '') + data.toString();
    });

    child.once('close', (code) => {
      session.status = 'ended';
      session.exitCode = code;
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
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
    this.initializeSession(session, prompt, opts.mcpServers, opts.systemPromptMeta, opts.role, opts.projectName).catch(err => {
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
    role?: string,
    projectName?: string,
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
            command: 'node',
            args: [resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/flightdeck-mcp.mjs')],
            env: [
              { name: 'FLIGHTDECK_AGENT_ID', value: session.agentId },
              { name: 'FLIGHTDECK_AGENT_ROLE', value: role ?? '' },
              ...(projectName ? [{ name: 'FLIGHTDECK_PROJECT', value: projectName }] : []),
            ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ACP SDK expects broader type than our strict env shape
          } as any,
        ],
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      });

      session.acpSessionId = result.sessionId;
      session.status = 'active';
      session.lastActivityAt = new Date();

      // Cache available models if returned
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing undocumented ACP result property
      if ((result as any).models?.availableModels) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing undocumented ACP result property
        modelRegistry.registerModels(this.runtimeName, (result as any).models.availableModels);
      }

      // Queue the initial prompt instead of sending it synchronously.
      // This lets initializeSession() return quickly after newSession(),
      // so steer() calls don't have to wait for the first prompt to finish.
      // drainQueue() will merge queued steer messages with the initial prompt.
      if (prompt) {
        session.promptQueue.push({
          content: prompt,
          priority: false,
          resolve: () => {},
          reject: () => {},
        });
      }

      // Drain: sends the initial prompt (and any steer messages that arrived during init)
      await this.drainQueue(session);
    } catch (err: unknown) {
      if (session.status !== 'ended') {
        session.error = (session.error ?? '') + `\nACP error: ${err instanceof Error ? err.message : String(err)}`;
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
    projectName?: string;
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
      detached: false,
    });

    const now = new Date();
    const session: AcpSession = {
      id: sessionLocalId,
      agentId: aid,
      role: opts.role,
      process: child,
      connection: null!,
      acpSessionId: null,
      status: 'initializing',
      startedAt: now,
      lastActivityAt: now,
      cwd: opts.cwd,
      model: opts.model,
      projectName: opts.projectName,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
      output: '',
      exitCode: null,
      error: null,
      agentCapabilities: null,
      terminals: new Map(),
      isPrompting: false,
      promptQueue: [],
    };

    child.stderr?.on('data', (data: Buffer) => {
      session.error = (session.error ?? '') + data.toString();
    });
    child.once('close', (code) => {
      session.status = 'ended';
      session.exitCode = code;
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
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
      session.error = (session.error ?? '') + `\nACP load error: ${err instanceof Error ? err.message : String(err)}`;
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

      const defaultMcpServers: McpServer[] = [
        {
          name: 'flightdeck',
          command: 'node',
          args: [resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/flightdeck-mcp.mjs')],
          env: [
            { name: 'FLIGHTDECK_AGENT_ID', value: session.agentId },
            { name: 'FLIGHTDECK_AGENT_ROLE', value: session.role ?? '' },
            ...(session.projectName ? [{ name: 'FLIGHTDECK_PROJECT', value: session.projectName }] : []),
          ],
        } as any,
      ];

      const _result = await session.connection.loadSession({
        sessionId: previousSessionId,
        cwd: session.cwd,
        mcpServers: mcpServers ?? defaultMcpServers,
      });

      // loadSession uses the same sessionId we passed in
      session.acpSessionId = previousSessionId;
      session.status = 'active';
      session.lastActivityAt = new Date();
    } catch (err: unknown) {
      if (session.status === 'initializing') {
        session.error = (session.error ?? '') + `\nACP load error: ${err instanceof Error ? err.message : String(err)}`;
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

  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') throw new Error(`Session already ended: ${sessionId}`);

    if (!session.acpSessionId) {
      // Session not yet initialized — queue the message for later
      const prefix = message.urgent ? '[URGENT] ' : '';
      return new Promise<string>((resolve, reject) => {
        session.promptQueue.push({ content: prefix + message.content, priority: !!message.urgent, resolve, reject });
      });
    }

    const prefix = message.urgent ? '[URGENT] ' : '';
    const text = prefix + message.content;

    // If a prompt is already in-flight, queue the message instead of interrupting
    if (session.isPrompting) {
      return new Promise<string>((resolve, reject) => {
        const entry: QueuedPrompt = { content: text, priority: !!message.urgent, resolve, reject };
        if (message.urgent) {
          // Priority messages go to the front of the queue
          const priorityCount = session.promptQueue.filter(q => q.priority).length;
          session.promptQueue.splice(priorityCount, 0, entry);
        } else {
          session.promptQueue.push(entry);
        }
      });
    }

    return this.sendPrompt(session, text);
  }

  /**
   * Send a prompt to the agent and drain the queue afterward.
   */
  private async sendPrompt(session: AcpSession, text: string): Promise<string> {
    session.turnCount++;
    session.status = 'prompting';
    session.isPrompting = true;

    const outputBefore = session.output.length;

    try {
      await session.connection.prompt({
        sessionId: session.acpSessionId!,
        prompt: [{ type: 'text', text }],
      });
      session.status = 'active';
    } catch (err: unknown) {
      if ((session.status as AcpSessionStatus) !== 'ended') {
        session.error = (session.error ?? '') + `\nSteer error: ${err instanceof Error ? err.message : String(err)}`;
        session.status = 'active';
      }
    } finally {
      session.isPrompting = false;
    }
    session.lastActivityAt = new Date();

    // Drain any messages queued while this prompt was running (loop instead of recursion)
    while (session.promptQueue.length > 0 && session.status !== 'ended' && session.acpSessionId) {
      const items = session.promptQueue.splice(0);
      const priorityItems = items.filter(i => i.priority);
      const normalItems = items.filter(i => !i.priority);
      const ordered = [...priorityItems, ...normalItems];
      const merged = ordered.map(i => i.content).join('\n\n---\n\n');

      session.turnCount++;
      session.status = 'prompting';
      session.isPrompting = true;
      const loopOutputBefore = session.output.length;

      try {
        await session.connection.prompt({
          sessionId: session.acpSessionId!,
          prompt: [{ type: 'text', text: merged }],
        });
        session.status = 'active';
        const loopResponse = session.output.slice(loopOutputBefore);
        for (const item of ordered) { item.resolve?.(loopResponse); }
      } catch (err: unknown) {
        if ((session.status as AcpSessionStatus) !== 'ended') {
          session.status = 'active';
        }
        for (const item of ordered) { item.reject?.(err instanceof Error ? err : new Error(String(err))); }
      } finally {
        session.isPrompting = false;
      }
      session.lastActivityAt = new Date();
    }

    return session.output.slice(outputBefore);
  }

  /**
   * Drain the prompt queue by merging all queued messages into a single prompt.
   * Priority messages appear first.
   */
  private async drainQueue(session: AcpSession): Promise<void> {
    if (session.promptQueue.length === 0) return;
    if (session.status === 'ended') return;
    if (!session.acpSessionId) return;

    // Take all queued items
    const items = session.promptQueue.splice(0);

    // Priority items first (already at front due to insertion order), then normal
    const priorityItems = items.filter(i => i.priority);
    const normalItems = items.filter(i => !i.priority);
    const ordered = [...priorityItems, ...normalItems];

    const merged = ordered.map(i => i.content).join('\n\n---\n\n');

    try {
      const responseText = await this.sendPrompt(session, merged);
      // Resolve all queued promises with the combined response
      for (const item of ordered) {
        item.resolve?.(responseText);
      }
    } catch (err: unknown) {
      for (const item of ordered) {
        item.reject?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') return;

    // Release all terminals and remove listeners
    for (const terminal of session.terminals.values()) {
      terminal.process.removeAllListeners();
      if (!terminal.released && terminal.exitCode === null) {
        try { terminal.process.kill('SIGTERM'); } catch { /* */ }
      }
    }
    session.terminals.clear();

    // Remove listeners from session process
    session.process.removeAllListeners();
    session.status = 'ended';

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
      }, 10_000);
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

  /**
   * Change the model for a running ACP session.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.connection || !session.acpSessionId) {
      throw new Error(`Cannot set model: session ${sessionId} not initialized or not found`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unstable API not in type definitions
    await (session.connection as any).unstable_setSessionModel({
      sessionId: session.acpSessionId,
      modelId,
    });
    session.model = modelId;
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== 'ended') {
        try { session.process.kill('SIGTERM'); } catch { /* */ }
      }
      session.process.removeAllListeners();
      for (const terminal of session.terminals.values()) {
        terminal.process.removeAllListeners();
        if (!terminal.released && terminal.exitCode === null) {
          try { terminal.process.kill('SIGTERM'); } catch { /* */ }
        }
      }
    }
    this.sessions.clear();
  }
}

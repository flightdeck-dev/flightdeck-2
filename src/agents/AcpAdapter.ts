import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
import { AgentAdapter, type SpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';
import type { AgentId, AgentRuntime } from '../core/types.js';
import { agentId } from '../core/ids.js';
import type { RuntimeConfig } from './SessionManager.js';
import { DEFAULT_RUNTIMES } from './SessionManager.js';

export type AcpSessionStatus = 'initializing' | 'active' | 'prompting' | 'ended';

/**
 * Tracks an ACP connection to a spawned agent process.
 */
export interface AcpSession {
  id: string;
  agentId: AgentId;
  process: ChildProcess;
  connection: ClientSideConnection;
  acpSessionId: string | null; // set after newSession completes
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
 * Spawns coding agents as child processes, establishes a ClientSideConnection
 * over stdin/stdout (ndjson), and uses the ACP protocol for session lifecycle,
 * prompting, and event streaming.
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

    // Client implementation that Flightdeck provides to the agent
    const flightdeckClient: Client = {
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // Auto-approve all permissions (Flightdeck manages permissions at a higher level)
        const allowOption = params.options.find(o => o.kind === 'always_allow')
          ?? params.options.find(o => o.kind === 'allow')
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
            // Tracked but no specific action needed
            break;
          default:
            break;
        }
      },
    };

    const connection = new ClientSideConnection((_agent: Agent) => flightdeckClient, stream);
    session.connection = connection;
    this.sessions.set(sessionLocalId, session);

    // Initialize + create session in background (don't block spawn)
    this.initializeSession(session, prompt).catch(err => {
      session.error = (session.error ?? '') + `\nACP init error: ${err.message}`;
      // If init fails, the session is still tracked — getMetadata will show the error
    });

    return {
      agentId: session.agentId,
      sessionId: session.id,
      status: 'running',
      model: opts.model,
    };
  }

  private async initializeSession(session: AcpSession, prompt: string): Promise<void> {
    try {
      await session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const result = await session.connection.newSession({
        cwd: session.cwd,
        mcpServers: [],
      });

      session.acpSessionId = result.sessionId;
      session.status = 'active';
      session.lastActivityAt = new Date();

      // Send the initial prompt
      session.status = 'prompting';
      session.turnCount++;
      const promptResult = await session.connection.prompt({
        sessionId: result.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      session.status = 'active';
      session.lastActivityAt = new Date();
    } catch (err: any) {
      // If the process already exited (e.g. echo command), that's fine
      if (session.status !== 'ended') {
        session.error = (session.error ?? '') + `\nACP error: ${err.message}`;
      }
    }
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
      if (session.status !== 'ended') {
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
    }
    this.sessions.clear();
  }
}

import { type ChildProcess, spawn as cpSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentId, AgentRuntime } from '@flightdeck-ai/shared';

export type SessionStatus = 'active' | 'idle' | 'ended';

export interface AgentSession {
  id: string;
  agentId: AgentId;
  process: ChildProcess;
  runtime: AgentRuntime;
  status: SessionStatus;
  startedAt: Date;
  cwd: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  lastActivityAt: Date;
}

export interface SessionHealth {
  sessionId: string;
  agentId: AgentId;
  status: SessionStatus;
  runtimeMs: number;
  idleMs: number;
  exitCode: number | null;
}

export interface RuntimeConfig {
  command: string;
  args: string[];
  adapter: AgentRuntime;
}

export const DEFAULT_RUNTIMES: Record<string, RuntimeConfig> = {
  codex: {
    command: 'codex',
    args: ['--message', '{prompt}', '--cwd', '{cwd}'],
    adapter: 'acp',
  },
  claude: {
    command: 'claude',
    args: ['--message', '{prompt}'],
    adapter: 'pty',
  },
  gemini: {
    command: 'gemini',
    args: ['{prompt}'],
    adapter: 'acp',
  },
  copilot: {
    command: 'copilot',
    args: ['--acp', '--stdio', '--allow-all'],
    adapter: 'acp',
  },
  'claude-code': {
    command: 'claude-agent-acp',
    args: [],
    adapter: 'acp',
  },
};

import { interpolateArgs } from './interpolateArgs.js';

/**
 * Simple PTY-based session backend used by PtyAdapter.
 * Not used in the daemon startup path (which uses AcpAdapter instead),
 * but retained as the lightweight/non-ACP agent backend.
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private cleanupRegistered = false;

  constructor(private runtimes: Record<string, RuntimeConfig> = DEFAULT_RUNTIMES) {
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

  spawn(
    agentId: AgentId,
    runtimeName: string,
    cwd: string,
    prompt: string,
  ): AgentSession {
    const runtime = this.runtimes[runtimeName];
    if (!runtime) {
      throw new Error(`Unknown runtime "${runtimeName}". Available: ${Object.keys(this.runtimes).join(', ')}`);
    }

    const args = interpolateArgs(runtime.args, { prompt, cwd });
    const id = `session-${randomUUID().slice(0, 8)}`;

    const child = cpSpawn(runtime.command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const now = new Date();
    const session: AgentSession = {
      id,
      agentId,
      process: child,
      runtime: runtime.adapter,
      status: 'active',
      startedAt: now,
      cwd,
      command: runtime.command,
      args,
      exitCode: null,
      stdout: '',
      stderr: '',
      lastActivityAt: now,
    };

    child.stdout?.on('data', (data: Buffer) => {
      session.stdout += data.toString();
      session.lastActivityAt = new Date();
    });

    child.stderr?.on('data', (data: Buffer) => {
      session.stderr += data.toString();
      session.lastActivityAt = new Date();
    });

    child.on('close', (code) => {
      session.status = 'ended';
      session.exitCode = code;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      session.status = 'ended';
      session.exitCode = -1;
      session.stderr += `\nProcess error: ${err.message}`;
      if (err.code === 'ENOENT') {
        session.stderr += `\nCommand not found: ${runtime.command}. Is it installed?`;
      }
    });

    this.sessions.set(id, session);
    return session;
  }

  steer(sessionId: string, message: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') throw new Error(`Session already ended: ${sessionId}`);
    if (!session.process.stdin?.writable) throw new Error(`Session stdin not writable: ${sessionId}`);

    session.process.stdin.write(message + '\n');
    session.lastActivityAt = new Date();
  }

  kill(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'ended') return;

    try {
      session.process.kill('SIGTERM');
      // Give it 5 seconds, then SIGKILL
      setTimeout(() => {
        if (session.status !== 'ended') {
          try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 5000);
    } catch {
      // Already dead
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): AgentSession[] {
    return [...this.sessions.values()].filter(s => s.status !== 'ended');
  }

  getAllSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  checkHealth(): SessionHealth[] {
    const now = Date.now();
    return [...this.sessions.values()].map(s => ({
      sessionId: s.id,
      agentId: s.agentId,
      status: s.status,
      runtimeMs: now - s.startedAt.getTime(),
      idleMs: now - s.lastActivityAt.getTime(),
      exitCode: s.exitCode,
    }));
  }

  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== 'ended') {
      this.kill(sessionId);
    }
    return this.sessions.delete(sessionId);
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

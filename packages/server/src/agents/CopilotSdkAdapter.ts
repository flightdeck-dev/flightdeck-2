/**
 * CopilotSdkAdapter — Spawns Copilot agents using @github/copilot-sdk.
 *
 * Instead of going through ACP (copilot --acp --stdio) and relying on
 * MCP server subprocesses for tools, this adapter:
 * 1. Uses CopilotClient to manage the CLI server lifecycle
 * 2. Injects flightdeck tools directly as session tools
 * 3. Tool handlers call the gateway HTTP API
 * 4. System prompt injected via systemMessage config
 *
 * This eliminates the MCP subprocess entirely for Copilot agents.
 */

import { CopilotClient, type CopilotSession, approveAll } from '@github/copilot-sdk';
import type { SessionConfig, SessionEvent, Tool } from '@github/copilot-sdk';
import type { AgentId, AgentRole, AgentRuntime } from '@flightdeck-ai/shared';
import { agentId as makeAgentId } from '@flightdeck-ai/shared';

export interface CopilotSdkAdapterOptions {
  /** Gateway URL for tool HTTP calls. Default: http://localhost:18800 */
  gatewayUrl?: string;
  /** Default model. If not set, uses Copilot's default. */
  defaultModel?: string;
}

export interface CopilotAgentSession {
  id: string;
  agentId: AgentId;
  role: AgentRole;
  session: CopilotSession;
  status: 'initializing' | 'active' | 'idle' | 'ended';
  output: string;
  startedAt: Date;
  lastActivityAt: Date;
  projectName?: string;
  cwd: string;
  model?: string;
}

export interface SpawnOptions {
  agentId?: string;
  role: AgentRole;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  projectName?: string;
}

export class CopilotSdkAdapter {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotAgentSession>();
  private gatewayUrl: string;
  private defaultModel?: string;

  /** Callback fired when a session ends. */
  onSessionEnd: ((sessionId: string, session: CopilotAgentSession) => void) | null = null;
  /** Callback fired when a session's prompt turn completes. */
  onSessionTurnEnd: ((sessionId: string, agentId: string) => void) | null = null;
  /** Callback fired on any output. */
  onOutput: ((agentId: string, event: SessionEvent) => void) | null = null;

  constructor(options?: CopilotSdkAdapterOptions) {
    this.gatewayUrl = options?.gatewayUrl ?? process.env.FLIGHTDECK_URL ?? 'http://localhost:18800';
    this.defaultModel = options?.defaultModel;
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient();
      await this.client.start();
    }
    return this.client;
  }

  /**
   * Build flightdeck tools that call the gateway HTTP API.
   */
  private buildTools(agentId: string, role: AgentRole, projectName?: string): Tool<any>[] {
    const baseUrl = `${this.gatewayUrl}/api/projects/${encodeURIComponent(projectName ?? 'default')}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Agent-Id': agentId,
      'X-Agent-Role': role,
    };

    const httpPost = async (path: string, body?: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };

    const httpGet = async (path: string, params?: Record<string, string>) => {
      const url = new URL(`${baseUrl}${path}`);
      if (params) Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
      const res = await fetch(url.toString(), { headers });
      return res.json();
    };

    const tools: Tool<any>[] = [];

    // Task tools
    tools.push({
      name: 'flightdeck_task_list',
      description: 'List tasks in the project. Optionally filter by state.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by state (ready/running/in_review/done/failed)' },
        },
      },
      handler: async (args: { state?: string }) => {
        const params: Record<string, string> = {};
        if (args.state) params.state = args.state;
        return JSON.stringify(await httpGet('/tasks', params));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_claim',
      description: 'Claim a ready task to work on.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Task ID to claim' } },
        required: ['taskId'],
      },
      handler: async (args: { taskId: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/claim`));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_submit',
      description: 'Submit completed work for a task. REQUIRED after completing work.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          claim: { type: 'string', description: 'Summary of what you did' },
        },
        required: ['taskId'],
      },
      handler: async (args: { taskId: string; claim?: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/submit`, { claim: args.claim }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_review_submit',
      description: 'Submit a review verdict for a task in review.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID being reviewed' },
          verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Review verdict' },
          comment: { type: 'string', description: 'Review feedback' },
        },
        required: ['taskId', 'verdict', 'comment'],
      },
      handler: async (args: { taskId: string; verdict: string; comment: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/review`, args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_comment',
      description: 'Add a comment to a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          comment: { type: 'string', description: 'Comment text' },
        },
        required: ['taskId', 'comment'],
      },
      handler: async (args: { taskId: string; comment: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/comments`, { message: args.comment }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_escalate',
      description: 'Escalate an issue to the lead agent.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Related task ID' },
          reason: { type: 'string', description: 'Why you are escalating' },
        },
        required: ['reason'],
      },
      handler: async (args: { taskId?: string; reason: string }) => {
        return JSON.stringify(await httpPost('/escalate', args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_msg_send',
      description: 'Send a message to another agent or channel.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent ID' },
          channel: { type: 'string', description: 'Channel name (alternative to to)' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['content'],
      },
      handler: async (args: { to?: string; channel?: string; content: string }) => {
        return JSON.stringify(await httpPost('/messages', args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_search',
      description: 'Search across tasks, agents, messages, and memory.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          source: { type: 'string', description: 'Filter: all/chat/memory/session' },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; source?: string }) => {
        return JSON.stringify(await httpGet('/search', { q: args.query, source: args.source ?? '' }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_status',
      description: 'Get project status overview.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        return JSON.stringify(await httpGet('/status'));
      },
      skipPermission: true,
    });

    return tools;
  }

  /**
   * Spawn a new Copilot agent session with flightdeck tools injected.
   */
  async spawn(opts: SpawnOptions): Promise<{ agentId: AgentId; sessionId: string; status: string }> {
    const client = await this.ensureClient();
    const aid = (opts.agentId ?? makeAgentId(opts.role, Date.now().toString())) as AgentId;
    const sessionId = `copilot-sdk-${Date.now().toString(36)}`;

    const tools = this.buildTools(aid, opts.role, opts.projectName);

    const sessionConfig: SessionConfig = {
      model: opts.model ?? this.defaultModel,
      systemMessage: opts.systemPrompt
        ? { mode: 'append', content: opts.systemPrompt }
        : undefined,
      tools,
      onPermissionRequest: approveAll,
    };

    const session = await client.createSession(sessionConfig);

    const agentSession: CopilotAgentSession = {
      id: sessionId,
      agentId: aid,
      role: opts.role,
      session,
      status: 'active',
      output: '',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      projectName: opts.projectName,
      cwd: opts.cwd,
      model: opts.model,
    };

    this.sessions.set(sessionId, agentSession);

    // Wire up event handlers
    session.on((event: SessionEvent) => {
      agentSession.lastActivityAt = new Date();

      if (event.type === 'assistant.message') {
        agentSession.output += event.data.content;
        agentSession.status = 'active';
      }

      if (event.type === 'session.idle') {
        agentSession.status = 'idle';
        if (this.onSessionTurnEnd) {
          try { this.onSessionTurnEnd(sessionId, aid); } catch { /* */ }
        }
      }

      if (event.type === 'session.error') {
        console.error(`[CopilotSdk] Session ${sessionId} error: ${event.data.message}`);
      }

      if (event.type === 'session.shutdown' as any) {
        agentSession.status = 'ended';
        if (this.onSessionEnd) {
          try { this.onSessionEnd(sessionId, agentSession); } catch { /* */ }
        }
      }

      if (this.onOutput) {
        try { this.onOutput(aid, event); } catch { /* */ }
      }
    });

    return { agentId: aid, sessionId, status: 'active' };
  }

  /**
   * Send a prompt to an existing session (steer).
   */
  async steer(sessionId: string, message: string): Promise<string> {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) throw new Error(`Session not found: ${sessionId}`);
    if (agentSession.status === 'ended') throw new Error(`Session ended: ${sessionId}`);

    const outputBefore = agentSession.output.length;
    agentSession.status = 'active';

    await agentSession.session.send({ prompt: message });

    // Wait for idle (turn complete)
    await new Promise<void>((resolve) => {
      const handler = (event: SessionEvent) => {
        if (event.type === 'session.idle') {
          resolve();
        }
      };
      agentSession.session.on(handler);
      // Timeout after 5 minutes
      setTimeout(() => resolve(), 5 * 60 * 1000);
    });

    return agentSession.output.slice(outputBefore);
  }

  /**
   * Kill a session.
   */
  async kill(sessionId: string): Promise<void> {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) return;
    try {
      await agentSession.session.disconnect();
    } catch { /* */ }
    agentSession.status = 'ended';
    // Clean up after grace period
    setTimeout(() => this.sessions.delete(sessionId), 60_000);
  }

  /**
   * Get session metadata.
   */
  getSession(sessionId: string): CopilotAgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Stop the Copilot CLI server and clean up all sessions.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try { await session.session.disconnect(); } catch { /* */ }
    }
    this.sessions.clear();
    if (this.client) {
      try { await this.client.stop(); } catch { /* */ }
      this.client = null;
    }
  }
}

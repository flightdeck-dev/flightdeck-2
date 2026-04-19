import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';

import { SessionStore, type SessionEvent } from './SessionStore.js';
import { Flightdeck } from '../facade.js';
import { LeadManager, type LeadEvent } from '../lead/LeadManager.js';
import { AcpAdapter } from '../agents/AcpAdapter.js';
import { DEFAULT_RUNTIMES } from '../agents/SessionManager.js';
import { modelRegistry } from '../agents/ModelTiers.js';

export class AcpAgentServer implements Agent {
  private conn!: AgentSideConnection;
  private opts: { project?: string };

  // Per-session state
  private sessionStore: SessionStore | null = null;
  private facade: Flightdeck | null = null;
  private leadManager: LeadManager | null = null;
  private acpAdapter: AcpAdapter | null = null;
  private currentSessionId: string | null = null;
  private currentModel: string | null = null;
  private currentRuntime: string = 'copilot';
  private cancelled = false;

  constructor(opts: { project?: string }) {
    this.opts = opts;
  }

  setConnection(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: {
        name: 'flightdeck',
        title: 'Flightdeck Multi-Agent Orchestrator',
        version: '2.0.0',
      },
    };
  }

  private resolveProject(cwd: string): string {
    const configPath = path.join(cwd, '.flightdeck.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.project) return config.project;
    } catch {
      // Fall through
    }
    return this.opts.project ?? path.basename(cwd);
  }

  private setupProject(projectName: string): void {
    this.acpAdapter = new AcpAdapter(DEFAULT_RUNTIMES, this.currentRuntime);
    this.facade = new Flightdeck(projectName, this.acpAdapter);
    this.sessionStore = new SessionStore(projectName, this.facade.sqlite.db);
    this.leadManager = new LeadManager({
      sqlite: this.facade.sqlite,
      project: this.facade.project,
      messageStore: this.facade.messages ?? undefined,
      acpAdapter: this.acpAdapter,
      projectName,
      leadRuntime: this.currentRuntime,
    });
  }

  /** Build the full config options array reflecting current state. */
  private buildConfigOptions(): SessionConfigOption[] {
    const runtimeNames = Object.keys(DEFAULT_RUNTIMES);

    const options: SessionConfigOption[] = [
      {
        id: 'runtime',
        name: 'Agent Runtime',
        type: 'select' as const,
        description: 'The ACP runtime used for the Lead agent (e.g. copilot, claude-code, codex)',
        currentValue: this.currentRuntime,
        options: runtimeNames.map(r => ({ value: r, name: r })),
      },
      {
        id: 'model',
        name: 'Model',
        type: 'select' as const,
        category: 'model',
        description: 'The LLM model for the Lead agent',
        currentValue: this.currentModel ?? 'default',
        options: [
          { value: 'default', name: 'Default' },
        ],
      },
    ];

    return options;
  }

  /** Build available models state from the model registry, grouped by runtime. */
  private buildModelState(): { availableModels: Array<{ modelId: string; name: string; description?: string }>; currentModelId: string } | null {
    const runtimes = modelRegistry.getRuntimes();
    if (runtimes.length === 0) {
      // No models registered yet (Lead hasn't spawned)
      return null;
    }

    const availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
    for (const rt of runtimes) {
      const models = modelRegistry.getModels(rt);
      for (const m of models) {
        // Prefix with runtime name for disambiguation across providers
        availableModels.push({
          modelId: m.modelId,
          name: `${m.displayName} (${rt})`,
          description: `via ${rt} runtime`,
        });
      }
    }

    return {
      availableModels,
      currentModelId: this.currentModel ?? 'default',
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // Read model/runtime from _meta if provided
    const meta = params._meta as Record<string, unknown> | undefined;
    if (meta?.model && typeof meta.model === 'string') {
      this.currentModel = meta.model;
    }
    if (meta?.runtime && typeof meta.runtime === 'string') {
      this.currentRuntime = meta.runtime;
    }

    const projectName = this.resolveProject(params.cwd);
    this.setupProject(projectName);

    const entry = this.sessionStore!.createSession(projectName, params.cwd);
    this.currentSessionId = entry.id;

    return {
      sessionId: entry.id,
      configOptions: this.buildConfigOptions(),
      models: this.buildModelState(),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const projectName = this.resolveProject(params.cwd);
    this.setupProject(projectName);

    const entry = this.sessionStore!.getSession(params.sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    this.currentSessionId = params.sessionId;

    // Replay events as session/update notifications
    const events = this.sessionStore!.readEvents(params.sessionId);
    for (const event of events) {
      const updateType = event.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk';
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: updateType,
          content: { type: 'text', text: event.content },
        },
      });
    }

    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.cancelled = false;
    const sessionId = params.sessionId;
    this.currentSessionId = sessionId;

    // Extract content from all block types
    const textParts: string[] = [];
    for (const block of params.prompt) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        textParts.push(`[Image: ${(block as { mimeType?: string }).mimeType ?? 'image'}]`);
      } else if (block.type === 'resource') {
        // Embedded resource — extract text content if available
        const res = block as { resource?: { uri?: string; text?: string } };
        if (res.resource?.text) {
          textParts.push(`[Resource: ${res.resource.uri ?? 'unknown'}]\n${res.resource.text}`);
        } else {
          textParts.push(`[Resource: ${res.resource?.uri ?? 'unknown'}]`);
        }
      } else if (block.type === 'resource_link') {
        const link = block as { uri?: string };
        textParts.push(`[ResourceLink: ${link.uri ?? 'unknown'}]`);
      }
    }
    const text = textParts.join('\n');

    // Append user event
    this.sessionStore?.appendEvent(sessionId, {
      role: 'user',
      content: text,
      ts: Date.now(),
    });
    this.sessionStore?.updateLastActive(sessionId);

    // Send user message chunk
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
      },
    });

    if (this.cancelled) {
      return { stopReason: 'cancelled' };
    }

    // Steer Lead
    let response = '';
    try {
      const event: LeadEvent = {
        type: 'user_message',
        message: {
          id: randomUUID(),
          threadId: null,
          parentId: null,
          taskId: null,
          authorType: 'user',
          authorId: null,
          content: text,
          metadata: null,
          channel: null,
          recipient: null,
          createdAt: new Date().toISOString(),
          updatedAt: null,
        },
      };
      response = await this.leadManager!.steerLead(event);
    } catch (err) {
      response = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (this.cancelled) {
      return { stopReason: 'cancelled' };
    }

    // Append agent event
    this.sessionStore?.appendEvent(sessionId, {
      role: 'agent',
      content: response,
      ts: Date.now(),
    });

    // Stream output
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: response },
      },
    });

    return { stopReason: 'end_turn' };
  }

  async cancel(_params: CancelNotification): Promise<void> {
    this.cancelled = true;

    // Relay cancel to the Lead's underlying ACP session
    if (this.leadManager && this.acpAdapter) {
      const leadSessionId = this.leadManager.getLeadSessionId();
      if (leadSessionId) {
        const session = this.acpAdapter.getSession(leadSessionId);
        if (session?.acpSessionId && session.status !== 'ended') {
          try {
            await session.connection.cancel({ sessionId: session.acpSessionId });
          } catch {
            // Best effort — agent may have already finished
          }
        }
      }
    }
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!this.sessionStore) {
      return { sessions: [] };
    }

    // Get all sessions from the store
    let sessions = this.sessionStore.listAll();

    // Filter by cwd if specified
    if (params.cwd) {
      sessions = sessions.filter(s => s.cwd === params.cwd);
    }

    // Map to ACP SessionInfo format
    const sessionInfos = sessions.map(s => ({
      sessionId: s.id,
      cwd: s.cwd,
      title: s.projectName,
      updatedAt: s.lastActiveAt,
    }));

    // Simple cursor-based pagination (use index as cursor)
    const pageSize = 50;
    const startIdx = params.cursor ? parseInt(params.cursor, 10) : 0;
    const page = sessionInfos.slice(startIdx, startIdx + pageSize);
    const nextCursor = startIdx + pageSize < sessionInfos.length
      ? String(startIdx + pageSize)
      : null;

    return {
      sessions: page,
      nextCursor,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const { configId, value } = params;

    if (configId === 'model' && typeof value === 'string') {
      this.currentModel = value === 'default' ? null : value;
      // If Lead is already running, try to set model on the underlying agent
      if (this.leadManager && this.currentModel) {
        const leadSessionId = this.leadManager.getLeadSessionId();
        if (leadSessionId && this.acpAdapter) {
          try {
            await this.acpAdapter.setModel(leadSessionId, this.currentModel);
          } catch {
            // Best effort — agent may not support model switching
          }
        }
      }
    } else if (configId === 'runtime' && typeof value === 'string') {
      this.currentRuntime = value;
      // Runtime change takes effect on next Lead spawn
    }

    return { configOptions: this.buildConfigOptions() };
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    // Flightdeck doesn't have modes yet, acknowledge gracefully
    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    // Delegate to setSessionConfigOption for consistency
    await this.setSessionConfigOption({
      sessionId: params.sessionId,
      configId: 'model',
      value: params.modelId,
      type: 'boolean', // SDK union type quirk — value is actually a string ID
    } as unknown as SetSessionConfigOptionRequest);
    return {};
  }
}

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
  type AuthenticateResponse,
} from '@agentclientprotocol/sdk';

import { SessionStore, type SessionEvent } from './SessionStore.js';
import { Flightdeck } from '../facade.js';
import { LeadManager, type LeadEvent } from '../lead/LeadManager.js';
import { AcpAdapter } from '../agents/AcpAdapter.js';
import { DEFAULT_RUNTIMES } from '../agents/SessionManager.js';

export class AcpAgentServer implements Agent {
  private conn!: AgentSideConnection;
  private opts: { project?: string };

  // Per-session state
  private sessionStore: SessionStore | null = null;
  private facade: Flightdeck | null = null;
  private leadManager: LeadManager | null = null;
  private currentSessionId: string | null = null;
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
    const acpAdapter = new AcpAdapter(DEFAULT_RUNTIMES, 'copilot');
    this.facade = new Flightdeck(projectName, acpAdapter);
    this.sessionStore = new SessionStore(projectName);
    this.leadManager = new LeadManager({
      sqlite: this.facade.sqlite,
      project: this.facade.project,
      messageStore: this.facade.chatMessages ?? undefined,
      acpAdapter,
      projectName,
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const projectName = this.resolveProject(params.cwd);
    this.setupProject(projectName);

    const entry = this.sessionStore!.createSession(projectName, params.cwd);
    this.currentSessionId = entry.id;

    return { sessionId: entry.id };
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

    // Extract text from content blocks
    const textParts: string[] = [];
    for (const block of params.prompt) {
      if (block.type === 'text') {
        textParts.push(block.text);
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
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }
}

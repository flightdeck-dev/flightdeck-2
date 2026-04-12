import type { AgentId, AgentRole, Agent } from '@flightdeck-ai/shared';
import { agentId as makeAgentId } from '@flightdeck-ai/shared';
import type { SqliteStore } from '../storage/SqliteStore.js';
import type { RoleRegistry } from '../roles/RoleRegistry.js';
import type { AgentAdapter, AgentMetadata } from './AgentAdapter.js';

export interface SpawnAgentOptions {
  role: AgentRole;
  model?: string;
  task?: string;
  cwd: string;
  runtime?: string;
}

/**
 * Build a system prompt for a spawned agent based on its role and context.
 */
export function buildSystemPrompt(opts: {
  roleName: string;
  roleInstructions: string;
  agentId: string;
  projectName: string;
  permissions: Record<string, boolean>;
}): string {
  const permittedTools = Object.entries(opts.permissions)
    .filter(([, v]) => v)
    .map(([k]) => `flightdeck_${k}`);

  return `You are a ${opts.roleName} agent in Flightdeck project "${opts.projectName}".
Your agent ID is: ${opts.agentId}

${opts.roleInstructions}

## Available Flightdeck Tools
Based on your role permissions, you can use:
${permittedTools.map(t => `- ${t}`).join('\n')}

## Rules
- Always pass your agentId when calling Flightdeck tools
- Report task completion via flightdeck_task_submit
- If stuck, use flightdeck_escalate
`;
}

/**
 * Central manager bridging MCP tools → AgentAdapter (ACP/PTY).
 * Handles spawn, terminate, interrupt, restart — keeping SQLite in sync.
 */
export class AgentManager {
  /** sessionId → agentId mapping for active agents */
  private sessionToAgent = new Map<string, AgentId>();
  /** agentId → sessionId mapping */
  private agentToSession = new Map<AgentId, string>();

  constructor(
    private adapter: AgentAdapter,
    private store: SqliteStore,
    private roleRegistry: RoleRegistry,
    private projectName: string,
  ) {}

  async spawnAgent(opts: SpawnAgentOptions): Promise<Agent> {
    // 1. Get role from registry
    const role = this.roleRegistry.get(opts.role);
    const roleName = role?.name ?? opts.role;
    const roleInstructions = role?.instructions ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const permissions = role?.permissions ?? {};

    // 2. Register in SQLite
    const newId = makeAgentId(opts.role, Date.now().toString());
    const agent: Agent = {
      id: newId,
      role: opts.role,
      runtime: this.adapter.runtime,
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };
    this.store.insertAgent(agent);

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt({
      roleName,
      roleInstructions,
      agentId: newId,
      projectName: this.projectName,
      permissions,
    });

    // 4. Spawn via adapter
    try {
      const meta = await this.adapter.spawn({
        role: opts.role,
        cwd: opts.cwd,
        model: opts.model,
        systemPrompt,
      });

      // 5. Update SQLite with session ID
      this.store.updateAgentAcpSession(newId, meta.sessionId);
      this.store.updateAgentStatus(newId, 'busy');
      agent.acpSessionId = meta.sessionId;
      agent.status = 'busy';

      // Track mappings
      this.sessionToAgent.set(meta.sessionId, newId);
      this.agentToSession.set(newId, meta.sessionId);

      return agent;
    } catch (err) {
      // Spawn failed — mark agent as errored
      this.store.updateAgentStatus(newId, 'errored');
      agent.status = 'errored';
      throw err;
    }
  }

  async terminateAgent(agentId: AgentId): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (sessionId) {
      try {
        await this.adapter.kill(sessionId);
      } catch {
        // Best effort — process may already be dead
      }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    this.store.updateAgentStatus(agentId, 'offline');
    this.store.updateAgentAcpSession(agentId, null);
  }

  async interruptAgent(agentId: AgentId, message: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (!sessionId) throw new Error(`No active session for agent: ${agentId}`);

    await this.adapter.steer(sessionId, { content: message, urgent: true });
  }

  async restartAgent(agentId: AgentId): Promise<Agent> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Kill existing session
    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (sessionId) {
      try {
        await this.adapter.kill(sessionId);
      } catch { /* best effort */ }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    // Re-spawn with same role/config
    const role = this.roleRegistry.get(agent.role);
    const systemPrompt = buildSystemPrompt({
      roleName: role?.name ?? agent.role,
      roleInstructions: role?.instructions ?? `You are a ${agent.role} agent.`,
      agentId,
      projectName: this.projectName,
      permissions: role?.permissions ?? {},
    });

    const meta = await this.adapter.spawn({
      role: agent.role,
      cwd: process.cwd(),
      model: undefined,
      systemPrompt,
    });

    this.store.updateAgentAcpSession(agentId, meta.sessionId);
    this.store.updateAgentStatus(agentId, 'busy');
    this.sessionToAgent.set(meta.sessionId, agentId);
    this.agentToSession.set(agentId, meta.sessionId);

    return { ...agent, acpSessionId: meta.sessionId, status: 'busy' };
  }

  getAgent(agentId: AgentId): Agent | null {
    return this.store.getAgent(agentId);
  }

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  async getAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return null;
    return this.adapter.getMetadata(sessionId);
  }
}

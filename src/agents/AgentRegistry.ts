// Agent Management Module
// Inspired by: Flightdeck 1.0 (14 built-in roles, agent lifecycle),
// BMAD-METHOD (scale-adaptive intelligence), spec-kit (multi-agent command registration)

import {
  type Agent, type AgentId, type AgentStatus, type Role, type RoleId,
  agentId,
} from '../core/types.js';

export interface SpawnAgentInput {
  name: string;
  role: RoleId;
  model: string;
  capabilities?: string[];
  sessionId?: string;
}

export class AgentRegistry {
  private agents: Map<AgentId, Agent> = new Map();
  private roles: Map<RoleId, Role> = new Map();
  private heartbeatTimeout: number = 30_000; // 30s default

  // ---- Role Management ----

  registerRole(role: Role): void {
    this.roles.set(role.id, role);
  }

  getRole(id: RoleId): Role | undefined {
    return this.roles.get(id);
  }

  getAllRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  // ---- Agent Lifecycle ----

  spawn(input: SpawnAgentInput): Agent {
    const id = agentId();
    const now = new Date();
    const role = this.roles.get(input.role);

    const agent: Agent = {
      id,
      name: input.name,
      role: input.role,
      model: input.model,
      status: 'idle',
      capabilities: input.capabilities ?? role?.capabilities ?? [],
      costAccumulated: 0,
      lastHeartbeat: now,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(id, agent);
    return agent;
  }

  getAgent(id: AgentId): Agent | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getAgentsByRole(roleId: RoleId): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.role === roleId);
  }

  heartbeat(id: AgentId): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.lastHeartbeat = new Date();
    if (agent.status === 'crashed') {
      agent.status = 'idle'; // Resume from crash
    }
    agent.updatedAt = new Date();
    return true;
  }

  markBusy(id: AgentId): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'busy';
      agent.updatedAt = new Date();
    }
  }

  markIdle(id: AgentId): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'idle';
      agent.updatedAt = new Date();
    }
  }

  terminate(id: AgentId): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'terminated';
      agent.updatedAt = new Date();
    }
  }

  addCost(id: AgentId, amount: number): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.costAccumulated += amount;
      agent.updatedAt = new Date();
    }
  }

  /** Detect crashed agents (no heartbeat within timeout) */
  detectCrashed(): Agent[] {
    const cutoff = new Date(Date.now() - this.heartbeatTimeout);
    const crashed: Agent[] = [];

    for (const agent of this.agents.values()) {
      if (agent.status === 'busy' && agent.lastHeartbeat && agent.lastHeartbeat < cutoff) {
        agent.status = 'crashed';
        agent.updatedAt = new Date();
        crashed.push(agent);
      }
    }

    return crashed;
  }

  /** Find an idle agent with matching role and capabilities */
  findAvailable(roleId: RoleId, requiredCapabilities?: string[]): Agent | undefined {
    return Array.from(this.agents.values()).find(a => {
      if (a.role !== roleId || a.status !== 'idle') return false;
      if (requiredCapabilities) {
        return requiredCapabilities.every(c => a.capabilities.includes(c));
      }
      return true;
    });
  }

  setHeartbeatTimeout(ms: number): void {
    this.heartbeatTimeout = ms;
  }

  getCostSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const agent of this.agents.values()) {
      summary[agent.id] = agent.costAccumulated;
    }
    return summary;
  }
}

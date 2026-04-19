import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentManager, buildSystemPrompt } from '../../src/agents/AgentManager.js';
import { LeadManager, FLIGHTDECK_IDLE, FLIGHTDECK_NO_REPLY } from '../../src/lead/LeadManager.js';
import type { AgentAdapter, SpawnOptions, SteerMessage, AgentMetadata } from '../../src/agents/AgentAdapter.js';
import type { AgentId, AgentRuntime, Agent } from '@flightdeck-ai/shared';
import { createDatabase } from '../../src/db/database.js';

/**
 * E2E tests for Scenario 9: Claw as Supervisor flow.
 *
 * Mocks the ACP adapter to test AgentManager + LeadManager logic
 * without spawning real CLI processes.
 */

// ── Mock ACP Adapter ──

class MockAcpAdapter extends (await import('../../src/agents/AgentAdapter.js')).AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  private sessions = new Map<string, { opts: SpawnOptions; meta: AgentMetadata; steers: SteerMessage[]; killed: boolean }>();
  private nextId = 1;

  spawnCount = 0;
  steerLog: Array<{ sessionId: string; message: SteerMessage }> = [];
  killLog: string[] = [];

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    this.spawnCount++;
    const sessionId = `mock-session-${this.nextId++}`;
    const meta: AgentMetadata = {
      agentId: `${opts.role}:${Date.now()}` as AgentId,
      sessionId,
      status: 'running',
      model: opts.model,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
    };
    this.sessions.set(sessionId, { opts, meta, steers: [], killed: false });
    return meta;
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.killed) throw new Error(`Session already killed: ${sessionId}`);
    session.steers.push(message);
    this.steerLog.push({ sessionId, message });
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.killed = true;
    session.meta.status = 'ended';
    this.killLog.push(sessionId);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { ...session.meta };
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  // Simulate clearing for tests
  clear(): void {
    this.sessions.clear();
    this.steerLog = [];
    this.killLog = [];
    this.spawnCount = 0;
    this.nextId = 1;
  }
}

// ── Mock SqliteStore (minimal) ──

function createMockStore() {
  const agents = new Map<AgentId, Agent>();
  return {
    db: createDatabase(':memory:'),
    insertAgent(agent: Agent) { agents.set(agent.id, { ...agent }); },
    getAgent(id: AgentId): Agent | null { return agents.get(id) ?? null; },
    listAgents(includeRetired = false): Agent[] {
      const all = [...agents.values()];
      return includeRetired ? all : all.filter(a => a.status !== 'retired');
    },
    updateAgentStatus(id: AgentId, status: Agent['status']) {
      const a = agents.get(id);
      if (a) a.status = status;
    },
    updateAgentAcpSession(id: AgentId, sessionId: string | null) {
      const a = agents.get(id);
      if (a) a.acpSessionId = sessionId;
    },
    updateAgentHeartbeat(id: AgentId) {
      const a = agents.get(id);
      if (a) a.lastHeartbeat = new Date().toISOString();
    },
    deleteAgent(id: AgentId): boolean {
      return agents.delete(id);
    },
    purgeOfflineAgents(): number {
      let count = 0;
      for (const [id, a] of agents) {
        if (a.status === 'hibernated') { agents.delete(id); count++; }
      }
      return count;
    },
    getTaskStats() { return { ready: 2, running: 1, in_review: 0, done: 3, failed: 0 }; },
    getTotalCost() { return 1.23; },
    resetOrphanedTasks() { return 0; },
    _agents: agents,
  };
}

// ── Mock RoleRegistry ──

function createMockRoleRegistry() {
  const roles: Record<string, any> = {
    lead: {
      name: 'Lead',
      instructions: 'You are the lead agent. Coordinate workers and report to supervisor.',
      permissions: { task_list: true, task_create: true, task_claim: true, escalate: true },
    },
    worker: {
      name: 'Worker',
      instructions: 'You are a worker agent. Complete assigned tasks.',
      permissions: { task_claim: true, task_submit: true },
    },
  };
  return {
    get(role: string) { return roles[role] ?? null; },
    list() { return Object.entries(roles).map(([k, v]) => ({ role: k, ...v })); },
  };
}

// ── Mock ProjectStore ──

function createMockProjectStore(heartbeatContent?: string) {
  return {
    readHeartbeat() { return heartbeatContent ?? null; },
  };
}

// ── Tests ──

describe('Scenario 9: Claw as Supervisor', () => {
  let adapter: MockAcpAdapter;
  let store: ReturnType<typeof createMockStore>;
  let roleRegistry: ReturnType<typeof createMockRoleRegistry>;
  let agentManager: AgentManager;

  beforeEach(() => {
    adapter = new MockAcpAdapter();
    store = createMockStore();
    roleRegistry = createMockRoleRegistry();
    agentManager = new AgentManager(
      adapter as any,
      store as any,
      roleRegistry as any,
      'test-project',
    );
  });

  afterEach(() => {
    adapter.clear();
  });

  // 9.1: Lead spawn via AgentManager
  describe('9.1 - Lead spawn via AgentManager', () => {
    it('spawns a lead agent with correct role', async () => {
      const agent = await agentManager.spawnAgent({
        role: 'lead',
        cwd: '/tmp/test-project',
      });

      expect(agent.role).toBe('lead');
      expect(agent.status).toBe('busy');
      expect(agent.acpSessionId).toBeTruthy();
      expect(adapter.spawnCount).toBe(1);

      // Verify persisted in store
      const stored = store.getAgent(agent.id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('busy');
    });

    it('spawns lead via LeadManager directly', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      const sessionId = await leadManager.spawnLead();
      expect(sessionId).toBeTruthy();
      expect(sessionId).toMatch(/^mock-session-/);
      expect(adapter.spawnCount).toBe(1);
      expect(leadManager.getLeadSessionId()).toBe(sessionId);
    });
  });

  // 9.2: Steer Lead with user intent
  describe('9.2 - Steer Lead with user intent', () => {
    it('steers lead with user message event', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      await leadManager.spawnLead();

      await leadManager.steerLead({
        type: 'user_message',
        message: { id: 'msg-1', role: 'user', content: 'Implement the auth module', timestamp: new Date().toISOString() } as any,
      });

      expect(adapter.steerLog).toHaveLength(1);
      expect(adapter.steerLog[0].message.content).toContain('Implement the auth module');
    });

    it('steers lead with urgent interrupt via AgentManager', async () => {
      const agent = await agentManager.spawnAgent({
        role: 'lead',
        cwd: '/tmp/test-project',
      });

      await agentManager.interruptAgent(agent.id, 'STOP: priority change');

      expect(adapter.steerLog).toHaveLength(1);
      expect(adapter.steerLog[0].message.urgent).toBe(true);
      expect(adapter.steerLog[0].message.content).toBe('STOP: priority change');
    });
  });

  // 9.3: Lead spawns Worker (nested spawn)
  describe('9.3 - Lead spawns Worker (nested spawn)', () => {
    it('spawns worker after lead is running', async () => {
      // Lead spawn
      const lead = await agentManager.spawnAgent({
        role: 'lead',
        cwd: '/tmp/test-project',
      });
      expect(adapter.spawnCount).toBe(1);

      // Worker spawn (simulating lead requesting worker)
      const worker = await agentManager.spawnAgent({
        role: 'worker',
        cwd: '/tmp/test-project',
        task: 'Implement OAuth2',
      });
      expect(adapter.spawnCount).toBe(2);
      expect(worker.role).toBe('worker');
      expect(worker.status).toBe('busy');

      // Both agents visible
      const agents = agentManager.listAgents();
      expect(agents).toHaveLength(2);
      expect(agents.map(a => a.role)).toContain('lead');
      expect(agents.map(a => a.role)).toContain('worker');
    });
  });

  // 9.4: Worker completes task → Lead notified (event propagation)
  describe('9.4 - Worker completes → Lead notified', () => {
    it('steers lead with task completion event', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      await leadManager.spawnLead();

      await leadManager.steerLead({
        type: 'spec_completed',
        specId: 'spec-001',
        summary: 'OAuth2 module implemented and tested',
      });

      expect(adapter.steerLog).toHaveLength(1);
      expect(adapter.steerLog[0].message.content).toContain('spec-001');
      expect(adapter.steerLog[0].message.content).toContain('OAuth2 module implemented and tested');
    });

    it('steers lead on task failure', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      await leadManager.spawnLead();

      await leadManager.steerLead({
        type: 'task_failure',
        taskId: 'task-42',
        error: 'Build failed: type errors in auth.ts',
      });

      expect(adapter.steerLog).toHaveLength(1);
      expect(adapter.steerLog[0].message.content).toContain('task-42');
      expect(adapter.steerLog[0].message.content).toContain('Build failed');
    });

    it('tracks task completions for heartbeat conditions', () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      leadManager.recordTaskCompletion();
      leadManager.recordTaskCompletion();
      leadManager.recordTaskCompletion();
      // Internal counter should be 3 — verified indirectly via heartbeat condition
    });
  });

  // 9.5: Monitor via status (all agents + tasks visible)
  describe('9.5 - Monitor via status', () => {
    it('lists all agents with metadata', async () => {
      const lead = await agentManager.spawnAgent({ role: 'lead', cwd: '/tmp' });
      const worker = await agentManager.spawnAgent({ role: 'worker', cwd: '/tmp' });

      const agents = agentManager.listAgents();
      expect(agents).toHaveLength(2);

      // Check metadata from adapter
      const leadMeta = await agentManager.getAgentMetadata(lead.id);
      expect(leadMeta).not.toBeNull();
      expect(leadMeta!.status).toBe('running');

      const workerMeta = await agentManager.getAgentMetadata(worker.id);
      expect(workerMeta).not.toBeNull();
      expect(workerMeta!.status).toBe('running');
    });

    it('returns null metadata for unknown agent', async () => {
      const meta = await agentManager.getAgentMetadata('nonexistent' as AgentId);
      expect(meta).toBeNull();
    });
  });

  // 9.6: Lead escalation (message from lead to supervisor)
  describe('9.6 - Lead escalation', () => {
    it('steers lead with escalation event', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      await leadManager.spawnLead();

      await leadManager.steerLead({
        type: 'escalation',
        agentId: 'worker-1',
        taskId: 'task-99',
        reason: 'Need clarification on API design: REST vs GraphQL?',
      });

      expect(adapter.steerLog).toHaveLength(1);
      const content = adapter.steerLog[0].message.content;
      expect(content).toContain('[AGENT worker-1]');
      expect(content).toContain('source: escalation');
      expect(content).toContain('worker-1');
      expect(content).toContain('REST vs GraphQL');
    });

    it('handles lead response filtering (IDLE/NO_REPLY)', () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      // IDLE → suppressed
      expect(leadManager.handleLeadResponse(FLIGHTDECK_IDLE)).toBeNull();

      // NO_REPLY → suppressed
      expect(leadManager.handleLeadResponse(FLIGHTDECK_NO_REPLY)).toBeNull();

      // Real response → forwarded
      const response = leadManager.handleLeadResponse('Worker needs help with auth design');
      expect(response).toBe('Worker needs help with auth design');
    });
  });

  // 9.9: Stall detection → kill + respawn Lead
  describe('9.9 - Stall detection → kill + respawn', () => {
    it('terminates and restarts a stalled agent', async () => {
      const agent = await agentManager.spawnAgent({
        role: 'lead',
        cwd: '/tmp/test-project',
      });

      const originalSessionId = agent.acpSessionId;
      expect(originalSessionId).toBeTruthy();

      // Restart (simulates stall detection → kill + respawn)
      const restarted = await agentManager.restartAgent(agent.id);

      // Old session was killed
      expect(adapter.killLog).toContain(originalSessionId);

      // New session assigned
      expect(restarted.acpSessionId).toBeTruthy();
      expect(restarted.acpSessionId).not.toBe(originalSessionId);
      expect(restarted.status).toBe('busy');

      // Total spawns: original + restart
      expect(adapter.spawnCount).toBe(2);
    });

    it('terminates agent completely', async () => {
      const agent = await agentManager.spawnAgent({
        role: 'worker',
        cwd: '/tmp/test-project',
      });

      await agentManager.terminateAgent(agent.id);

      const stored = store.getAgent(agent.id);
      expect(stored!.status).toBe('hibernated');
      expect(stored!.acpSessionId).toBeNull();
      expect(adapter.killLog).toHaveLength(1);
    });
  });

  // 9.10: Heartbeat trigger
  describe('9.10 - Heartbeat trigger', () => {
    it('builds heartbeat steer with project status', () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore('Check on auth module progress') as any,
        acpAdapter: adapter as any,
      });

      const steer = leadManager.buildHeartbeatSteer();

      expect(steer).toContain('[heartbeat steer]');
      expect(steer).toContain('$1.23');
      expect(steer).toContain('HEARTBEAT.md');
      expect(steer).toContain('Check on auth module progress');
    });

    it('builds heartbeat steer without HEARTBEAT.md', () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      const steer = leadManager.buildHeartbeatSteer();

      expect(steer).toContain('[heartbeat steer]');
      expect(steer).not.toContain('HEARTBEAT.md');
    });

    it('sends heartbeat steer to lead', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      await leadManager.spawnLead();
      await leadManager.steerLead({ type: 'heartbeat' });

      expect(adapter.steerLog).toHaveLength(1);
      expect(adapter.steerLog[0].message.content).toContain('[heartbeat steer]');
    });

    it('checks heartbeat conditions — tasks_completed', () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
        heartbeat: {
          enabled: true,
          interval: 60_000,
          conditions: [{ type: 'tasks_completed', min: 2 }],
        },
      });

      // Not enough completions
      leadManager.recordTaskCompletion();
      expect(leadManager.checkHeartbeatConditions()).toBe(false);

      // Enough
      leadManager.recordTaskCompletion();
      expect(leadManager.checkHeartbeatConditions()).toBe(true);
    });

    it('checks heartbeat conditions — idle_duration', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
        heartbeat: {
          enabled: false,
          interval: 60_000,
          conditions: [{ type: 'idle_duration', min: '1ms' }],
        },
      });

      await leadManager.spawnLead();

      // Steer to set lastSteerAt
      await leadManager.steerLead({ type: 'heartbeat' });

      // After a tiny delay, idle_duration of 1ms should pass
      await new Promise(r => setTimeout(r, 5));
      expect(leadManager.checkHeartbeatConditions()).toBe(true);
    });

    it('stops heartbeat timer on cleanup', async () => {
      const leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
        heartbeat: { enabled: true, interval: 100, conditions: [] },
      });

      await leadManager.spawnLead();
      // Timer started because heartbeat enabled
      leadManager.stop();
      // No error — timer cleared
    });
  });

  // ── Additional: buildSteer coverage ──

  describe('buildSteer event types', () => {
    let leadManager: LeadManager;

    beforeEach(() => {
      leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });
    });

    it('builds user_message steer', () => {
      const steer = leadManager.buildSteer({
        type: 'user_message',
        message: { id: 'msg-1', role: 'user', content: 'Fix the bug in login', timestamp: new Date().toISOString() } as any,
      });
      expect(steer).toContain('[USER]');
      expect(steer).toContain('Fix the bug in login');
    });

    it('builds task_comment steer', () => {
      const steer = leadManager.buildSteer({
        type: 'task_comment',
        taskId: 'task-5',
        message: { id: 'msg-2', role: 'user', content: 'Also handle edge case', timestamp: new Date().toISOString() } as any,
      });
      expect(steer).toContain('[USER]');
      expect(steer).toContain('source: task_comment');
      expect(steer).toContain('task-5');
      expect(steer).toContain('Also handle edge case');
    });

    it('builds budget_warning steer', () => {
      const steer = leadManager.buildSteer({
        type: 'budget_warning',
        currentSpend: 8.50,
        limit: 10.00,
      });
      expect(steer).toContain('[SYSTEM]');
      expect(steer).toContain('source: budget_warning');
      expect(steer).toContain('$8.50');
      expect(steer).toContain('$10.00');
    });
  });

  // ── buildSystemPrompt ──

  describe('buildSystemPrompt', () => {
    it('includes role name and permissions', () => {
      const prompt = buildSystemPrompt({
        roleName: 'Lead',
        roleInstructions: 'Coordinate workers.',
        agentId: 'lead:123',
        projectName: 'test-project',
        permissions: { task_list: true, task_create: true, escalate: true, task_submit: false },
      });

      expect(prompt).toContain('Lead agent');
      expect(prompt).toContain('test-project');
      expect(prompt).toContain('flightdeck_task_list');
      expect(prompt).toContain('flightdeck_task_create');
      expect(prompt).toContain('flightdeck_escalate');
      // Note: 'flightdeck_task_submit' appears in Rules section (hardcoded), not in permissions list
      // Verify task_submit is NOT in the permitted tools list
      const toolsSection = prompt.split('## Available Flightdeck Tools')[1]?.split('## Rules')[0] ?? '';
      expect(toolsSection).not.toContain('flightdeck_task_submit');
    });
  });
});

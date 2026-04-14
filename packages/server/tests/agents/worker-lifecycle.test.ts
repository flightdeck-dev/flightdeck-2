import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentManager } from '../../src/agents/AgentManager.js';
import type { Agent, AgentId, AgentRole, AgentStatus } from '@flightdeck-ai/shared';

// ── Mock helpers ──

function createMockStore() {
  const agents = new Map<AgentId, Agent>();
  return {
    insertAgent(agent: Agent) { agents.set(agent.id, { ...agent }); },
    getAgent(id: AgentId): Agent | null { return agents.get(id) ?? null; },
    listAgents(includeRetired = false): Agent[] {
      const all = [...agents.values()];
      return includeRetired ? all : all.filter(a => a.status !== 'retired');
    },
    updateAgentStatus(id: AgentId, status: AgentStatus) {
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
    deleteAgent(id: AgentId): boolean { return agents.delete(id); },
    purgeOfflineAgents(): number {
      let count = 0;
      for (const [id, a] of agents) {
        if (a.status === 'offline') { agents.delete(id); count++; }
      }
      return count;
    },
    getActiveAgentCount(): number {
      return [...agents.values()].filter(a => a.status === 'idle' || a.status === 'busy').length;
    },
    resetOrphanedTasks() { return 0; },
    _agents: agents,
  };
}

function createMockAdapter() {
  return {
    runtime: 'acp' as const,
    spawn: vi.fn().mockResolvedValue({ agentId: 'test', sessionId: 'sess-1' }),
    steer: vi.fn().mockResolvedValue('ok'),
    kill: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(null),
    resumeSession: vi.fn().mockResolvedValue({ agentId: 'test', sessionId: 'sess-resumed' }),
  };
}

function createMockRoleRegistry() {
  return {
    get(role: string) {
      return {
        name: role,
        instructions: `You are a ${role} agent.`,
        permissions: {},
      };
    },
    list() { return []; },
  };
}

function makeAgent(id: string, status: AgentStatus, sessionId: string | null = null): Agent {
  return {
    id: id as AgentId,
    role: 'worker' as AgentRole,
    runtime: 'acp',
    acpSessionId: sessionId,
    status,
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  };
}

describe('Worker Lifecycle', () => {
  let store: ReturnType<typeof createMockStore>;
  let adapter: ReturnType<typeof createMockAdapter>;
  let agentManager: AgentManager;

  beforeEach(() => {
    store = createMockStore();
    adapter = createMockAdapter();
    const roleRegistry = createMockRoleRegistry();
    agentManager = new AgentManager(
      adapter as any,
      store as any,
      roleRegistry as any,
      'test-project',
    );
  });

  describe('hibernateAgent', () => {
    it('should transition busy agent to hibernated and kill process', async () => {
      const agent = makeAgent('worker-1', 'busy', 'sess-1');
      store.insertAgent(agent);

      await agentManager.hibernateAgent('worker-1' as AgentId);

      const updated = store.getAgent('worker-1' as AgentId)!;
      expect(updated.status).toBe('hibernated');
      // acpSessionId should be preserved for resume
      expect(updated.acpSessionId).toBe('sess-1');
      expect(adapter.kill).toHaveBeenCalledWith('sess-1');
    });

    it('should throw for non-existent agent', async () => {
      await expect(
        agentManager.hibernateAgent('nonexistent' as AgentId),
      ).rejects.toThrow('Agent not found');
    });
  });

  describe('wakeAgent', () => {
    it('should resume a hibernated agent', async () => {
      const agent = makeAgent('worker-1', 'hibernated', 'sess-saved');
      store.insertAgent(agent);

      const result = await agentManager.wakeAgent('worker-1' as AgentId);

      expect(result.status).toBe('busy');
      expect(result.acpSessionId).toBe('sess-resumed');
      expect(adapter.resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({ previousSessionId: 'sess-saved' }),
      );
    });

    it('should throw if agent is not hibernated', async () => {
      const agent = makeAgent('worker-1', 'busy', 'sess-1');
      store.insertAgent(agent);

      await expect(
        agentManager.wakeAgent('worker-1' as AgentId),
      ).rejects.toThrow('not hibernated');
    });

    it('should retire agent if no saved session', async () => {
      const agent = makeAgent('worker-1', 'hibernated', null);
      store.insertAgent(agent);

      await expect(
        agentManager.wakeAgent('worker-1' as AgentId),
      ).rejects.toThrow('No saved session');

      const updated = store.getAgent('worker-1' as AgentId)!;
      expect(updated.status).toBe('retired');
    });

    it('should retire agent on resume failure', async () => {
      adapter.resumeSession.mockRejectedValue(new Error('session expired'));
      const agent = makeAgent('worker-1', 'hibernated', 'sess-old');
      store.insertAgent(agent);

      await expect(
        agentManager.wakeAgent('worker-1' as AgentId),
      ).rejects.toThrow('Failed to resume');

      const updated = store.getAgent('worker-1' as AgentId)!;
      expect(updated.status).toBe('retired');
      expect(updated.acpSessionId).toBeNull();
    });
  });

  describe('retireAgent', () => {
    it('should retire a busy agent and kill process', async () => {
      const agent = makeAgent('worker-1', 'busy', 'sess-1');
      store.insertAgent(agent);

      await agentManager.retireAgent('worker-1' as AgentId);

      const updated = store.getAgent('worker-1' as AgentId)!;
      expect(updated.status).toBe('retired');
      expect(updated.acpSessionId).toBeNull();
      expect(adapter.kill).toHaveBeenCalledWith('sess-1');
    });

    it('should retire a hibernated agent without killing', async () => {
      const agent = makeAgent('worker-1', 'hibernated', 'sess-saved');
      store.insertAgent(agent);

      await agentManager.retireAgent('worker-1' as AgentId);

      const updated = store.getAgent('worker-1' as AgentId)!;
      expect(updated.status).toBe('retired');
      // Should NOT have tried to kill (already hibernated)
      expect(adapter.kill).not.toHaveBeenCalled();
    });
  });

  describe('listAgents filtering', () => {
    it('should exclude retired agents by default', () => {
      store.insertAgent(makeAgent('worker-1', 'busy', 'sess-1'));
      store.insertAgent(makeAgent('worker-2', 'retired', null));
      store.insertAgent(makeAgent('worker-3', 'hibernated', 'sess-3'));

      const visible = agentManager.listAgents();
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).not.toContain('worker-2');
    });

    it('should include retired agents when requested', () => {
      store.insertAgent(makeAgent('worker-1', 'busy', 'sess-1'));
      store.insertAgent(makeAgent('worker-2', 'retired', null));

      const all = agentManager.listAgents(true);
      expect(all).toHaveLength(2);
    });
  });

  describe('getActiveAgentCount', () => {
    it('should not count hibernated or retired agents', () => {
      store.insertAgent(makeAgent('w1', 'busy', 'sess-1'));
      store.insertAgent(makeAgent('w2', 'idle', null));
      store.insertAgent(makeAgent('w3', 'hibernated', 'sess-3'));
      store.insertAgent(makeAgent('w4', 'retired', null));

      expect(store.getActiveAgentCount()).toBe(2);
    });
  });
});

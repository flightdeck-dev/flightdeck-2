import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import type { Agent, AgentId } from '@flightdeck-ai/shared';

describe('Agent state machine', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-agent-sm-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertAgent(id: string, status: Agent['status'] = 'idle'): Agent {
    const agent: Agent = {
      id: id as AgentId,
      role: 'worker',
      runtime: 'acp',
      runtimeName: null,
      acpSessionId: null,
      status,
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };
    store.insertAgent(agent);
    return agent;
  }

  it('spawned agent starts as idle', () => {
    insertAgent('agent-1');
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent).not.toBeNull();
    expect(agent!.status).toBe('idle');
  });

  it('turn start marks agent busy', () => {
    insertAgent('agent-1');
    store.updateAgentStatus('agent-1' as AgentId, 'busy');
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent!.status).toBe('busy');
  });

  it('turn end marks agent idle', () => {
    insertAgent('agent-1', 'busy');
    store.updateAgentStatus('agent-1' as AgentId, 'idle');
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent!.status).toBe('idle');
  });

  it('terminate with session → hibernated', () => {
    insertAgent('agent-1', 'busy');
    // Simulate terminate: set hibernated, keep session
    store.hibernateAgent('agent-1' as AgentId, 'session-123');
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent!.status).toBe('hibernated');
    expect(agent!.acpSessionId).toBe('session-123');
  });

  it('terminate without session → hibernated', () => {
    insertAgent('agent-1', 'busy');
    store.updateAgentStatus('agent-1' as AgentId, 'hibernated');
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent!.status).toBe('hibernated');
  });

  it('retireAgent sets status to retired', () => {
    insertAgent('agent-1', 'idle');
    store.retireAgent('agent-1' as AgentId);
    const agent = store.getAgent('agent-1' as AgentId);
    expect(agent!.status).toBe('retired');
  });

  it('retired agents excluded from listAgents by default', () => {
    insertAgent('agent-1', 'idle');
    insertAgent('agent-2', 'idle');
    store.retireAgent('agent-1' as AgentId);
    expect(store.listAgents().map(a => a.id)).toEqual(['agent-2']);
    expect(store.listAgents(true).map(a => a.id)).toContain('agent-1');
  });

  it('unretireAgent sets retired → hibernated', () => {
    insertAgent('agent-1', 'idle');
    store.retireAgent('agent-1' as AgentId);
    expect(store.getAgent('agent-1' as AgentId)!.status).toBe('retired');
    store.unretireAgent('agent-1' as AgentId);
    expect(store.getAgent('agent-1' as AgentId)!.status).toBe('hibernated');
  });
});

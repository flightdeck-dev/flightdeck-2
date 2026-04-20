import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { AgentManager, buildSystemPrompt } from '../../src/agents/AgentManager.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { RoleRegistry } from '../../src/roles/RoleRegistry.js';
import { MessageStore } from '../../src/comms/MessageStore.js';
import type { AgentAdapter, SpawnOptions, SteerMessage, AgentMetadata } from '../../src/agents/AgentAdapter.js';
import type { AgentId, AgentRuntime, MessageId } from '@flightdeck-ai/shared';

/** Minimal mock adapter for testing */
class MockAdapter implements AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  spawnCalls: SpawnOptions[] = [];
  killCalls: string[] = [];
  steerCalls: { sessionId: string; message: SteerMessage }[] = [];
  private sessionCounter = 0;
  shouldFail = false;

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    if (this.shouldFail) throw new Error('spawn failed');
    this.spawnCalls.push(opts);
    const sessionId = `mock-session-${++this.sessionCounter}`;
    return {
      agentId: `${opts.role}-mock` as AgentId,
      sessionId,
      status: 'running',
      model: opts.model,
    };
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    this.steerCalls.push({ sessionId, message });
  }

  async kill(sessionId: string): Promise<void> {
    this.killCalls.push(sessionId);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    return { agentId: 'test' as AgentId, sessionId, status: 'running' };
  }
}

describe('AgentManager', () => {
  const projectName = `test-agent-mgr-${Date.now()}`;
  const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
  let store: SqliteStore;
  let roles: RoleRegistry;
  let adapter: MockAdapter;
  let manager: AgentManager;

  beforeEach(() => {
    mkdirSync(projDir, { recursive: true });
    store = new SqliteStore(join(projDir, 'state.sqlite'));
    roles = new RoleRegistry(projectName);
    adapter = new MockAdapter();
    manager = new AgentManager(adapter, store, roles, projectName);
  });

  afterEach(() => {
    store.close();
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('spawnAgent registers in SQLite and calls adapter', async () => {
    const agent = await manager.spawnAgent({
      role: 'worker',
      cwd: '/tmp',
      model: 'gpt-4',
    });

    expect(agent.role).toBe('worker');
    expect(agent.status).toBe('idle');
    expect(agent.acpSessionId).toBe('mock-session-1');
    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.spawnCalls[0].role).toBe('worker');

    // Verify in SQLite
    const dbAgent = store.getAgent(agent.id);
    expect(dbAgent).not.toBeNull();
    expect(dbAgent!.status).toBe('idle');
    expect(dbAgent!.acpSessionId).toBe('mock-session-1');
  });

  it('spawnAgent marks agent errored on adapter failure', async () => {
    adapter.shouldFail = true;
    await expect(manager.spawnAgent({
      role: 'worker',
      cwd: '/tmp',
    })).rejects.toThrow('spawn failed');

    // Agent should exist in SQLite but be errored
    const agents = store.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('errored');
  });

  it('terminateAgent kills adapter session and updates SQLite', async () => {
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    await manager.terminateAgent(agent.id);

    expect(adapter.killCalls).toHaveLength(1);
    expect(adapter.killCalls[0]).toBe('mock-session-1');

    const dbAgent = store.getAgent(agent.id);
    expect(dbAgent!.status).toBe('hibernated');
    expect(dbAgent!.acpSessionId).toBe('mock-session-1');
  });

  it('interruptAgent sends urgent steer', async () => {
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    await manager.interruptAgent(agent.id, 'Stop what you are doing!');

    expect(adapter.steerCalls).toHaveLength(1);
    expect(adapter.steerCalls[0].message.content).toBe('Stop what you are doing!');
    expect(adapter.steerCalls[0].message.urgent).toBe(true);
  });

  it('restartAgent kills and re-spawns', async () => {
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    const restarted = await manager.restartAgent(agent.id);

    expect(adapter.killCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toHaveLength(2);
    expect(restarted.status).toBe('busy');
    expect(restarted.acpSessionId).toBe('mock-session-2');
  });

  it('terminateAgent throws for unknown agent', async () => {
    await expect(manager.terminateAgent('nonexistent' as AgentId))
      .rejects.toThrow('Agent not found');
  });

  it('interruptAgent throws when no session', async () => {
    // Insert agent without session
    store.insertAgent({
      id: 'bare-1' as AgentId,
      role: 'worker',
      runtime: 'acp',
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    });
    await expect(manager.interruptAgent('bare-1' as AgentId, 'hello'))
      .rejects.toThrow('No active session');
  });
});

describe('buildSystemPrompt', () => {
  it('includes role name, agent ID, and instructions', () => {
    const prompt = buildSystemPrompt({
      roleName: 'Worker',
      roleInstructions: 'Write clean code.',
      agentId: 'worker-123',
      projectName: 'my-project',
      permissions: { task_claim: true, task_submit: true, memory_write: true },
    });

    expect(prompt).toContain('Worker agent');
    expect(prompt).toContain('worker-123');
    expect(prompt).toContain('my-project');
    expect(prompt).toContain('Write clean code.');
    expect(prompt).toContain('flightdeck_task_claim');
    expect(prompt).toContain('flightdeck_task_submit');
    expect(prompt).toContain('flightdeck_memory_write');
  });

  it('excludes denied permissions', () => {
    const prompt = buildSystemPrompt({
      roleName: 'Worker',
      roleInstructions: '',
      agentId: 'w-1',
      projectName: 'p',
      permissions: { task_claim: true, agent_spawn: false },
    });

    expect(prompt).toContain('flightdeck_task_claim');
    expect(prompt).not.toContain('flightdeck_agent_spawn');
  });
});

describe('AgentManager DM delivery', () => {
  const projectName = `test-dm-delivery-${Date.now()}`;
  const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
  let store: SqliteStore;
  let roles: RoleRegistry;
  let adapter: MockAdapter;
  let manager: AgentManager;
  let messageStore: MessageStore;

  beforeEach(() => {
    mkdirSync(projDir, { recursive: true });
    store = new SqliteStore(join(projDir, 'state.sqlite'));
    roles = new RoleRegistry(projectName);
    adapter = new MockAdapter();
    manager = new AgentManager(adapter, store, roles, projectName);
    messageStore = new MessageStore(store.db);
    manager.setMessageStore(messageStore);
  });

  afterEach(() => {
    store.close();
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('delivers unread DMs on spawnAgent when agent ID matches', async () => {
    // First spawn an agent so we know its ID
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    
    // Terminate it
    await manager.terminateAgent(agent.id);
    adapter.steerCalls = [];

    // Send DMs while it's offline
    messageStore.appendDM('lead-1' as AgentId, agent.id, 'Please check the test results');

    // Spawn a NEW agent (same role) — it gets a DIFFERENT ID
    // so DMs to old agent won't be delivered to new agent (correct behavior)
    const newAgent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    await new Promise(r => setTimeout(r, 50));

    // New agent should NOT receive old agent's DMs
    const dmSteers = adapter.steerCalls.filter(s => s.message.content.includes('unread'));
    expect(dmSteers).toHaveLength(0);
    
    // But restartAgent would deliver them (same ID)
    // Verify the DMs are still there for the original agent
    const unread = messageStore.getUnreadDMs(agent.id);
    expect(unread).toHaveLength(1);
  });

  it('does not deliver DMs when there are none', async () => {
    await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });
    await new Promise(r => setTimeout(r, 50));

    // No steer calls for DMs
    const dmSteers = adapter.steerCalls.filter(s => s.message.content.includes('unread'));
    expect(dmSteers).toHaveLength(0);
  });

  it('marks DMs as read after restart delivery so they are not re-delivered', async () => {
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });

    messageStore.appendDM('lead-1' as AgentId, agent.id, 'First message');

    // Restart delivers the DM
    adapter.steerCalls = [];
    await manager.restartAgent(agent.id);
    await new Promise(r => setTimeout(r, 50));

    const firstDelivery = adapter.steerCalls.filter(s => s.message.content.includes('unread'));
    expect(firstDelivery).toHaveLength(1);

    // After delivery + markRead, no more unread DMs
    const unread = messageStore.getUnreadDMs(agent.id);
    expect(unread).toHaveLength(0);

    // Second restart should NOT re-deliver
    adapter.steerCalls = [];
    await manager.restartAgent(agent.id);
    await new Promise(r => setTimeout(r, 50));

    const secondDelivery = adapter.steerCalls.filter(s => s.message.content.includes('unread'));
    expect(secondDelivery).toHaveLength(0);
  });

  it('delivers unread DMs on restartAgent', async () => {
    const agent = await manager.spawnAgent({ role: 'worker', cwd: '/tmp' });

    // Send a DM while the agent is running
    messageStore.appendDM('planner-1' as AgentId, agent.id, 'New priority task available');

    // Restart the agent
    adapter.steerCalls = []; // Clear previous steers
    await manager.restartAgent(agent.id);
    await new Promise(r => setTimeout(r, 50));

    const dmSteers = adapter.steerCalls.filter(s => s.message.content.includes('unread'));
    expect(dmSteers).toHaveLength(1);
    expect(dmSteers[0].message.content).toContain('New priority task available');
  });
});

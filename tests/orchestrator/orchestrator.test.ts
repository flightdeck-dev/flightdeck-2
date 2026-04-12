import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentId, TaskId, ProjectConfig } from '../../src/core/types.js';
import type { AgentMetadata } from '../../src/agents/AgentAdapter.js';

describe('Orchestrator', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let adapter: AcpAdapter;
  let orch: Orchestrator;
  let tmpDir: string;

  const config: ProjectConfig = {
    name: 'test',
    governance: 'autonomous',
    isolation: 'none',
    onCompletion: 'stop',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-orch-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    adapter = new AcpAdapter();
    const gov = new GovernanceEngine(config);
    orch = new Orchestrator(dag, store, gov, adapter, config);
  });

  afterEach(() => {
    orch.stop();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('assigns ready tasks to idle agents', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const result = await orch.tick();
    expect(result.assignedTasks).toHaveLength(1);
  });

  it('does not assign when no idle agents', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const result = await orch.tick();
    expect(result.assignedTasks).toHaveLength(0);
  });

  it('skips active ACP sessions (do not disturb)', async () => {
    // Create a running task with an agent + ACP session
    const task = dag.addTask({ title: 'Working on it', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    // Manually set acpSessionId in DB
    store['db'].prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
      .run('session-active', task.id);
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'session-active',
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    // Mock: session is running
    vi.spyOn(adapter, 'getMetadata').mockResolvedValue({
      agentId: 'agent-w1' as AgentId,
      sessionId: 'session-active',
      status: 'running',
    });
    const steerSpy = vi.spyOn(adapter, 'steer');

    const result = await orch.tick();
    expect(result.pingedAgents).toHaveLength(0);
    expect(result.restartedAgents).toHaveLength(0);
    expect(steerSpy).not.toHaveBeenCalled();
  });

  it('pings idle ACP session with unsubmitted task', async () => {
    const task = dag.addTask({ title: 'Idle agent task', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
      .run('session-idle', task.id);
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'session-idle',
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    vi.spyOn(adapter, 'getMetadata').mockResolvedValue({
      agentId: 'agent-w1' as AgentId,
      sessionId: 'session-idle',
      status: 'idle',
    });
    const steerSpy = vi.spyOn(adapter, 'steer').mockResolvedValue();

    const result = await orch.tick();
    expect(result.pingedAgents).toContain('agent-w1');
    expect(steerSpy).toHaveBeenCalledWith('session-idle', expect.objectContaining({
      content: expect.stringContaining(task.id),
    }));
  });

  it('restarts agent when ACP session ended without submit', async () => {
    const task = dag.addTask({ title: 'Crashed task', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
      .run('session-ended', task.id);
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'session-ended',
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    vi.spyOn(adapter, 'getMetadata').mockResolvedValue({
      agentId: 'agent-w1' as AgentId,
      sessionId: 'session-ended',
      status: 'ended',
    });
    const killSpy = vi.spyOn(adapter, 'kill').mockResolvedValue();

    const result = await orch.tick();
    expect(result.restartedAgents).toContain('agent-w1');
    expect(killSpy).toHaveBeenCalledWith('session-ended');

    // Task should be reset to ready
    const updated = dag.getTask(task.id);
    expect(updated!.state).toBe('ready');
    expect(updated!.assignedAgent).toBeNull();

    // Agent should be offline
    const agent = store.getAgent('agent-w1' as AgentId);
    expect(agent!.status).toBe('offline');
  });

  it('start/stop lifecycle', () => {
    expect(orch.isRunning()).toBe(false);
    orch.start(60000);
    expect(orch.isRunning()).toBe(true);
    orch.stop();
    expect(orch.isRunning()).toBe(false);
  });
});

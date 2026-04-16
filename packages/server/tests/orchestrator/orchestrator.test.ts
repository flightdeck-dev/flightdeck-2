import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentId, TaskId, ProjectConfig } from '@flightdeck-ai/shared';

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
    expect(result.readyTasksAssigned).toBe(1);
  });

  it('does not assign when no idle agents', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const result = await orch.tick();
    expect(result.readyTasksAssigned).toBe(0);
  });

  it('skips active ACP sessions (do not disturb)', async () => {
    const task = dag.addTask({ title: 'Working on it', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].$client.prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
      .run('session-active', task.id);
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'session-active',
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    vi.spyOn(adapter, 'getMetadata').mockResolvedValue({
      agentId: 'agent-w1' as AgentId,
      sessionId: 'session-active',
      status: 'running',
    });
    const steerSpy = vi.spyOn(adapter, 'steer');

    const result = await orch.tick();
    expect(result.stallsDetected).toBe(0);
    expect(steerSpy).not.toHaveBeenCalled();
  });

  it('pings idle ACP session with unsubmitted task', async () => {
    const task = dag.addTask({ title: 'Idle agent task', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].$client.prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
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
    expect(result.stallsDetected).toBe(1);
    expect(steerSpy).toHaveBeenCalledWith('session-idle', expect.objectContaining({
      content: expect.stringContaining(task.id),
    }));
  });

  it('restarts agent when ACP session ended without submit', async () => {
    const task = dag.addTask({ title: 'Crashed task', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].$client.prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
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
    vi.spyOn(adapter, 'kill').mockResolvedValue();

    const result = await orch.tick();
    expect(result.stallsDetected).toBe(1);

    // Task should be reset to ready (retry)
    const updated = dag.getTask(task.id);
    expect(updated!.state).toBe('ready');
    expect(updated!.assignedAgent).toBeNull();

    // Agent should be offline
    const agent = store.getAgent('agent-w1' as AgentId);
    expect(agent!.status).toBe('offline');
  });

  it('promotes pending tasks when deps are done', async () => {
    const t1 = dag.addTask({ title: 'First task', role: 'worker' });
    const t2 = dag.addTask({ title: 'Second task', role: 'worker', dependsOn: [t1.id] });

    expect(t2.state).toBe('pending');

    // Complete the first task
    dag.claimTask(t1.id, 'agent-w1' as AgentId);
    dag.submitTask(t1.id, 'done');
    dag.completeTask(t1.id);

    // Insert idle agent for assignment
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const result = await orch.tick();

    // t2 should have been promoted to ready and possibly assigned
    const updatedT2 = dag.getTask(t2.id);
    expect(['ready', 'running']).toContain(updatedT2!.state);
  });

  it('does not promote pending tasks when deps are not done', async () => {
    const t1 = dag.addTask({ title: 'First task', role: 'worker' });
    const t2 = dag.addTask({ title: 'Second task', role: 'worker', dependsOn: [t1.id] });

    const result = await orch.tick();

    const updatedT2 = dag.getTask(t2.id);
    expect(updatedT2!.state).toBe('pending');
  });

  it('notifies Lead on task failure after max retries', async () => {
    const mockLeadManager = {
      steerLead: vi.fn().mockResolvedValue(undefined),
      steerPlannerEvent: vi.fn().mockResolvedValue(''),
      recordTaskCompletion: vi.fn(),
    };

    const gov = new GovernanceEngine(config);
    const orchWithLead = new Orchestrator(dag, store, gov, adapter, config, undefined, {
      leadManager: mockLeadManager as any,
      governanceConfig: { maxRetries: 0 }, // 0 retries = fail immediately
    });

    const task = dag.addTask({ title: 'Doomed task', role: 'worker' });
    dag.claimTask(task.id, 'agent-w1' as AgentId);
    store['db'].$client.prepare('UPDATE tasks SET acp_session_id = ? WHERE id = ?')
      .run('session-dead', task.id);
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'session-dead',
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    vi.spyOn(adapter, 'getMetadata').mockResolvedValue({
      agentId: 'agent-w1' as AgentId,
      sessionId: 'session-dead',
      status: 'ended',
    });
    vi.spyOn(adapter, 'kill').mockResolvedValue();

    await orchWithLead.tick();

    expect(mockLeadManager.steerLead).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_failure',
        taskId: task.id,
      }),
    );

    orchWithLead.stop();
  });

  it('pause prevents tick from doing work', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    orch.pause();
    expect(orch.paused).toBe(true);

    const result = await orch.tick();
    expect(result.readyTasksAssigned).toBe(0);
    expect(result.stallsDetected).toBe(0);
    expect(result.completionsProcessed).toBe(0);
    expect(result.errorsHandled).toBe(0);
  });

  it('resume allows tick to work again after pause', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    orch.pause();
    expect(orch.paused).toBe(true);

    orch.resume();
    expect(orch.paused).toBe(false);

    const result = await orch.tick();
    expect(result.readyTasksAssigned).toBe(1);
  });

  it('paused defaults to false', () => {
    expect(orch.paused).toBe(false);
  });

  it('start/stop lifecycle', () => {
    expect(orch.isRunning()).toBe(false);
    orch.start(60000);
    expect(orch.isRunning()).toBe(true);
    orch.stop();
    expect(orch.isRunning()).toBe(false);
  });

  describe('processCompletions (via tick)', () => {
    it('auto-completes in_review tasks when verification disabled', async () => {
      // Override governance to disable verification
      const gov = new GovernanceEngine(config);
      gov.setGovernanceConfig({
        ...gov.governanceConfig,
        verification: { enabled: false, freshReviewerOnRetry: false, additionalChecks: [] },
      });
      const noVerOrch = new Orchestrator(dag, store, gov, adapter, config);

      const task = dag.addTask({ title: 'Review me', role: 'worker' });
      store.insertAgent({
        id: 'agent-w1' as AgentId,
        role: 'worker', runtime: 'acp', acpSessionId: null,
        status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
      });
      dag.claimTask(task.id, 'agent-w1' as AgentId);
      dag.submitTask(task.id);

      const result = await noVerOrch.tick();
      expect(result.completionsProcessed).toBeGreaterThan(0);

      const updated = dag.getTask(task.id);
      expect(updated?.state).toBe('done');
      noVerOrch.stop();
    });

    it('does not auto-complete when verification is enabled', async () => {
      // Temporarily switch governance to collaborative (verification enabled)
      const origConfig = (orch as any).governance.governanceConfig;
      const savedVerification = origConfig.verification.enabled;
      origConfig.verification.enabled = true;

      const task = dag.addTask({ title: 'Review me', role: 'worker' });
      store.insertAgent({
        id: 'agent-w2' as AgentId,
        role: 'worker', runtime: 'acp', acpSessionId: null,
        status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
      });
      dag.claimTask(task.id, 'agent-w2' as AgentId);
      dag.submitTask(task.id);

      await orch.tick();
      const updated = dag.getTask(task.id);
      expect(updated?.state).toBe('in_review');

      // Restore
      origConfig.verification.enabled = savedVerification;
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentId, ProjectConfig } from '../../src/core/types.js';

describe('Orchestrator', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let orch: Orchestrator;
  let tmpDir: string;

  const config: ProjectConfig = {
    name: 'test',
    governance: 'autonomous',
    isolation: 'none',
    onCompletion: 'stop',
    stallDetection: {
      agentSilenceTimeoutMin: 30,
      taskRunningTimeoutMin: 120,
      dagIdleTimeoutMin: 60,
    },
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-orch-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    const gov = new GovernanceEngine(config);
    orch = new Orchestrator(dag, store, gov, new AcpAdapter(), config);
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

  it('detects stalled agents', async () => {
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    store.insertAgent({
      id: 'agent-stale' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'busy', currentSpecId: null, costAccumulated: 0, lastHeartbeat: oldTime,
    });

    const result = await orch.tick();
    expect(result.stalledAgents).toContain('agent-stale');
  });

  it('start/stop lifecycle', () => {
    expect(orch.isRunning()).toBe(false);
    orch.start(60000);
    expect(orch.isRunning()).toBe(true);
    orch.stop();
    expect(orch.isRunning()).toBe(false);
  });
});

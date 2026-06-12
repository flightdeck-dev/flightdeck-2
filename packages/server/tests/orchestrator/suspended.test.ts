import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentId, ProjectConfig } from '@flightdeck-ai/shared';

describe('Orchestrator suspended agents', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let adapter: AcpAdapter;
  let orch: Orchestrator;
  let tmpDir: string;

  const config: ProjectConfig = {
    name: 'test',
    governance: 'autonomous',
    isolation: 'file_lock',
    onCompletion: 'stop',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-susp-'));
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

  it('does not assign tasks to suspended agents', async () => {
    dag.addTask({ title: 'Ready task', role: 'worker' });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const result = await orch.tick();
    expect(result.readyTasksAssigned).toBe(0);
  });

  it('does not count suspended agents as active capacity', () => {
    store.insertAgent({
      id: 'agent-s1' as AgentId,
      role: 'director', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    // getActiveAgentCount only counts idle/busy
    expect(store.getActiveAgentCount()).toBe(0);
  });

  it('listHibernatedAgents returns only hibernated agents', () => {
    store.insertAgent({
      id: 'agent-s1' as AgentId,
      role: 'director', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });
    store.insertAgent({
      id: 'agent-w1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const suspended = store.listHibernatedAgents();
    expect(suspended).toHaveLength(1);
    expect(suspended[0].id).toBe('agent-s1');
    expect(suspended[0].status).toBe('hibernated');
  });

  it('purgeOfflineAgents purges hibernated agents but not retired', () => {
    store.insertAgent({
      id: 'agent-s1' as AgentId,
      role: 'director', runtime: 'acp', acpSessionId: null,
      status: 'retired', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });
    store.insertAgent({
      id: 'agent-off1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const purged = store.purgeOfflineAgents();
    expect(purged).toBe(1);

    const remaining = store.listAgents(true);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('retired');
  });

  it('purgeOfflineAgents keeps resumable agents and agents with in-flight tasks', () => {
    // Resumable: has a saved session — purging it would lose the resume
    store.insertAgent({
      id: 'agent-resumable' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: 'sess-keep',
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });
    // Has a running task assigned — purging would orphan the task
    store.insertAgent({
      id: 'agent-busy-task' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });
    store.insertTask({
      id: 'task-inflight' as any, specId: null, title: 'wip', description: '',
      state: 'running', role: 'worker', dependsOn: [], priority: 0,
      assignedAgent: 'agent-busy-task' as AgentId, acpSessionId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // Truly dead: no session, no tasks
    store.insertAgent({
      id: 'agent-dead' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'hibernated', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const purged = store.purgeOfflineAgents();
    expect(purged).toBe(1);
    const ids = store.listAgents(true).map(a => a.id);
    expect(ids).toContain('agent-resumable');
    expect(ids).toContain('agent-busy-task');
    expect(ids).not.toContain('agent-dead');
  });
});

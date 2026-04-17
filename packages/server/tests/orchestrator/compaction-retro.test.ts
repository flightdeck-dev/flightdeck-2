import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentId, SpecId } from '@flightdeck-ai/shared';

// Minimal mock adapter
const mockAdapter = {
  runtime: 'mock' as const,
  spawn: vi.fn().mockResolvedValue({ sessionId: 's1', agentId: 'a1' }),
  steer: vi.fn().mockResolvedValue('ok'),
  kill: vi.fn().mockResolvedValue(undefined),
  getMetadata: vi.fn().mockResolvedValue({ status: 'running' }),
};

// Mock LeadManager
const mockLeadManager = {
  steerLead: vi.fn().mockResolvedValue('ok'),
  recordTaskCompletion: vi.fn(),
};

describe('Orchestrator: Compaction & Retrospective', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let orchestrator: Orchestrator;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-orch-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    const gov = new GovernanceEngine({
      profile: 'autonomous',
      isolation: 'file_lock',
      costThresholdPerDay: 100,
    });
    orchestrator = new Orchestrator(dag, store, gov, mockAdapter as any, {
      name: 'test',
      isolation: 'file_lock',
      costThresholdPerDay: 100,
    } as any, undefined, {
      leadManager: mockLeadManager as any,
      governanceConfig: { compactionTtlHours: 0 }, // compact immediately for testing
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    orchestrator.stop();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compacts old completed tasks during tick', async () => {
    const task = dag.addTask({ title: 'Old task', description: 'Long description' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    dag.completeTask(task.id);
    // Backdate updatedAt
    store.db.run(require('drizzle-orm').sql.raw(
      `UPDATE tasks SET updated_at = '2020-01-01T00:00:00Z' WHERE id = '${task.id}'`
    ));

    const result = await orchestrator.tick();
    expect(result.tasksCompacted).toBe(1);

    const updated = dag.getTask(task.id);
    expect(updated!.compactedAt).toBeTruthy();
  });

  it('triggers retrospective when spec completes', async () => {
    const t1 = dag.addTask({ title: 'Task 1', specId: 'spec-1' as SpecId });
    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id);

    const result = await orchestrator.tick();
    expect(result.retrospectivesTriggered).toBe(1);
    expect(mockLeadManager.steerLead).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'spec_completed', specId: 'spec-1' })
    );
  });

  it('does not trigger retrospective twice for same spec', async () => {
    const t1 = dag.addTask({ title: 'Task 1', specId: 'spec-1' as SpecId });
    dag.claimTask(t1.id, 'agent-1' as AgentId);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id);

    await orchestrator.tick();
    await orchestrator.tick();

    // steerLead should only be called once for spec_completed
    const specCalls = mockLeadManager.steerLead.mock.calls.filter(
      (c: any) => c[0].type === 'spec_completed'
    );
    expect(specCalls).toHaveLength(1);
  });

  it('does not compact tasks newer than TTL', async () => {
    const gov = new GovernanceEngine({
      profile: 'autonomous',
      isolation: 'file_lock',
      costThresholdPerDay: 100,
    });
    const orch2 = new Orchestrator(dag, store, gov, mockAdapter as any, {
      name: 'test',
      isolation: 'file_lock',
      costThresholdPerDay: 100,
    } as any, undefined, {
      governanceConfig: { compactionTtlHours: 24 }, // 24h TTL
    });

    const task = dag.addTask({ title: 'Recent task' });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    dag.completeTask(task.id);

    const result = await orch2.tick();
    expect(result.tasksCompacted).toBe(0);
    orch2.stop();
  });
});

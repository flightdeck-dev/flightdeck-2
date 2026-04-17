import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import { SuggestionStore } from '../../src/storage/SuggestionStore.js';
import type { AgentId, ProjectConfig, SpecId } from '@flightdeck-ai/shared';

describe('Orchestrator — on_completion modes', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let adapter: AcpAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-oncomp-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    adapter = new AcpAdapter();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrch(onCompletion: 'explore' | 'stop' | 'ask', opts?: { suggestionStore?: SuggestionStore }) {
    const config: ProjectConfig = {
      name: 'test',
      governance: 'autonomous',
      isolation: 'file_lock',
      onCompletion,
    };
    const gov = new GovernanceEngine(config);
    return new Orchestrator(dag, store, gov, adapter, config, undefined, {
      suggestionStore: opts?.suggestionStore,
    });
  }

  function addCompletedSpec(specId: string) {
    const task = dag.addTask({ title: 'Task 1', role: 'worker', specId: specId as SpecId });
    // Transition: pending -> ready -> running -> in_review -> done
    store.updateTaskState(task.id, 'ready');
    store.updateTaskState(task.id, 'running', 'agent-1' as AgentId);
    store.updateTaskState(task.id, 'in_review');
    store.updateTaskState(task.id, 'done');
  }

  it('explore mode triggers scout analysis request', async () => {
    const sugStore = new SuggestionStore(tmpDir);
    const orch = makeOrch('explore', { suggestionStore: sugStore });
    addCompletedSpec('spec-explore');

    const result = await orch.tick();
    expect(result.retrospectivesTriggered).toBe(1);
    orch.stop();
  });

  it('stop mode triggers retrospective without scout', async () => {
    const orch = makeOrch('stop');
    addCompletedSpec('spec-stop');

    const result = await orch.tick();
    expect(result.retrospectivesTriggered).toBe(1);
    orch.stop();
  });

  it('ask mode triggers retrospective', async () => {
    const orch = makeOrch('ask');
    addCompletedSpec('spec-ask');

    const result = await orch.tick();
    expect(result.retrospectivesTriggered).toBe(1);
    orch.stop();
  });

  it('does not retrigger for same spec', async () => {
    const orch = makeOrch('explore', { suggestionStore: new SuggestionStore(tmpDir) });
    addCompletedSpec('spec-once');

    await orch.tick();
    const result2 = await orch.tick();
    expect(result2.retrospectivesTriggered).toBe(0);
    orch.stop();
  });
});

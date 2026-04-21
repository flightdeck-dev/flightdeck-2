import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { AgentId } from '@flightdeck-ai/shared';

describe('notifyLead — task completion notification', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-notify-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('task with notifyLead: true stores the flag', () => {
    const task = dag.addTask({ title: 'Notify test', notifyLead: true });
    const stored = store.getTask(task.id);
    expect(stored!.notifyLead).toBe(true);
  });

  it('task with notifyLead: false stores the flag', () => {
    const task = dag.addTask({ title: 'Silent test', notifyLead: false });
    const stored = store.getTask(task.id);
    expect(stored!.notifyLead).toBe(false);
  });

  it('submitTask with notifyLead: true and needsReview: false calls processEffects with notify_lead_completed', () => {
    const task = dag.addTask({ title: 'Notify test', notifyLead: true, needsReview: false });
    dag.claimTask(task.id, 'agent-1' as AgentId);

    // Spy on the private processEffects via prototype
    const effects: any[] = [];
    const origProcess = (dag as any).processEffects.bind(dag);
    (dag as any).processEffects = (effs: any[]) => {
      effects.push(...effs);
      origProcess(effs);
    };

    dag.submitTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(1);
    expect(notifyEffects[0].taskId).toBe(task.id);
  });

  it('submitTask with notifyLead: false does not emit notify_lead_completed', () => {
    const task = dag.addTask({ title: 'Silent test', notifyLead: false, needsReview: false });
    dag.claimTask(task.id, 'agent-1' as AgentId);

    const effects: any[] = [];
    const origProcess = (dag as any).processEffects.bind(dag);
    (dag as any).processEffects = (effs: any[]) => {
      effects.push(...effs);
      origProcess(effs);
    };

    dag.submitTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(0);
  });

  it('completeTask with notifyLead: true emits notify_lead_completed', () => {
    const task = dag.addTask({ title: 'Complete notify', notifyLead: true });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id); // goes to in_review

    const effects: any[] = [];
    const origProcess = (dag as any).processEffects.bind(dag);
    (dag as any).processEffects = (effs: any[]) => {
      effects.push(...effs);
      origProcess(effs);
    };

    dag.completeTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(1);
  });
});

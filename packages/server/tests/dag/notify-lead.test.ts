import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import type { AgentId, SideEffect } from '@flightdeck-ai/shared';

describe('notifyLead — task completion notification', () => {
  let store: SqliteStore;
  let dag: TaskDAG;
  let tmpDir: string;
  let effects: SideEffect[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-notify-'));
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    effects = [];
    dag.setEffectHandler((e) => effects.push(e));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('submitTask with notifyLead: true and needsReview: false emits notify_lead_completed', () => {
    const task = dag.addTask({ title: 'Notify test', notifyLead: true, needsReview: false });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(1);
    expect((notifyEffects[0] as any).taskId).toBe(task.id);
  });

  it('submitTask with notifyLead: false emits no notification', () => {
    const task = dag.addTask({ title: 'Silent test', notifyLead: false, needsReview: false });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(0);
  });

  it('completeTask with notifyLead: true emits notify_lead_completed', () => {
    const task = dag.addTask({ title: 'Complete notify', notifyLead: true });
    dag.claimTask(task.id, 'agent-1' as AgentId);
    dag.submitTask(task.id);
    effects = []; // clear submit effects
    dag.completeTask(task.id);
    const notifyEffects = effects.filter((e: any) => e.type === 'notify_lead_completed');
    expect(notifyEffects.length).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Flightdeck } from '../../src/facade.js';
import type { TaskId, AgentId } from '@flightdeck-ai/shared';
import type { WorkflowConfig } from '../../src/storage/WorkflowStore.js';
import { rmSync } from 'node:fs';

const tid = (s: string) => s as TaskId;
const aid = (s: string) => s as AgentId;

describe('WorkflowEngine + Orchestrator Integration', () => {
  let fd: Flightdeck;

  beforeEach(() => {
    fd = new Flightdeck(`test-wf-int-${Date.now()}`);
  });

  afterEach(() => {
    try { fd.sqlite.close(); } catch { /* ignore */ }
    try { rmSync(fd.project.path, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('facade passes WorkflowEngine to Orchestrator', () => {
    // The orchestrator should be wired with the workflow engine
    expect(fd.workflow).toBeDefined();
    expect(fd.orchestrator).toBeDefined();
    // Default workflow has 3 pipeline steps
    const config = fd.workflow.getConfig();
    expect(config.task_pipeline).toHaveLength(3);
  });

  it('submitTask succeeds with no hooks configured (default workflow)', () => {
    const task = fd.addTask({ title: 'Test task', role: 'worker' });
    // Task with no deps starts as ready
    fd.claimTask(task.id, aid('agent-1'));

    // Submit should succeed — no hooks to run
    const submitted = fd.submitTask(task.id, 'Done');
    expect(submitted.state).toBe('in_review');
  });

  it('submitTask runs on_task_submit hooks and proceeds on success', () => {
    // Configure hooks that pass
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'review', role: 'reviewer' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'echo ok', on_fail: 'reject' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Hook test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    const submitted = fd.submitTask(task.id, 'Done');
    expect(submitted.state).toBe('in_review');
  });

  it('submitTask rejects when hook fails with on_fail: reject', () => {
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'false', on_fail: 'reject' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Reject test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    expect(() => fd.submitTask(task.id, 'Done')).toThrow('Task submission rejected by hook');
  });

  it('submitTask returns to worker when hook fails with on_fail: return_to_worker', () => {
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'false', on_fail: 'return_to_worker' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Return test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    expect(() => fd.submitTask(task.id, 'Done')).toThrow('Task returned to worker');
  });

  it('submitTask proceeds with warning when hook fails with on_fail: warn', () => {
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'review', role: 'reviewer' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'false', on_fail: 'warn' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Warn test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    // Should succeed despite hook failure
    const submitted = fd.submitTask(task.id, 'Done');
    expect(submitted.state).toBe('in_review');
  });

  it('submitTask proceeds when hook fails with on_fail: skip', () => {
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'false', on_fail: 'skip' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Skip test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    const submitted = fd.submitTask(task.id, 'Done');
    expect(submitted.state).toBe('in_review');
  });

  it('workflow engine tracks pipeline state for tasks', () => {
    const action1 = fd.workflow.initTask(tid('t-pipeline'));
    expect(action1.type).toBe('assign_role');
    if (action1.type === 'assign_role') {
      expect(action1.role).toBe('worker');
      expect(action1.step).toBe('implement');
    }

    const action2 = fd.workflow.advanceTask(tid('t-pipeline'));
    expect(action2.type).toBe('assign_role');
    if (action2.type === 'assign_role') {
      expect(action2.role).toBe('reviewer');
      expect(action2.step).toBe('review');
    }

    const action3 = fd.workflow.advanceTask(tid('t-pipeline'));
    expect(action3.type).toBe('done');

    const action4 = fd.workflow.advanceTask(tid('t-pipeline'));
    expect(action4.type).toBe('pipeline_complete');
  });

  it('task submit goes to in_review (reviewer handles approval)', async () => {
    const task = fd.addTask({ title: 'Tick test', role: 'worker' });
    fd.registerAgent({ id: aid('w1'), role: 'worker', status: 'idle', name: 'Worker 1', model: 'test', createdAt: new Date().toISOString() } as any);
    fd.claimTask(task.id, aid('w1'));
    fd.submitTask(task.id, 'Done');

    // Task should be in_review (reviewer will handle approval, not tick)
    const beforeTick = fd.dag.getTask(task.id);
    expect(beforeTick?.state).toBe('in_review');

    // Tick should NOT auto-approve
    await fd.orchestrator.tick();

    const afterTick = fd.dag.getTask(task.id);
    expect(afterTick?.state).toBe('in_review');
  });

  it('multiple hooks: reject takes priority over warn', () => {
    fd.setWorkflow({
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'false', on_fail: 'warn' },
          { run: 'false', on_fail: 'reject' },
        ],
      },
    });

    const task = fd.addTask({ title: 'Multi-hook test', role: 'worker' });
    fd.claimTask(task.id, aid('agent-1'));

    expect(() => fd.submitTask(task.id, 'Done')).toThrow('rejected');
  });
});

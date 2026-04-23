import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../../src/workflow/WorkflowEngine.js';
import { WorkflowStore } from '../../src/storage/WorkflowStore.js';
import type { WorkflowConfig } from '../../src/storage/WorkflowStore.js';
import type { TaskId } from '@flightdeck-ai/shared';

const tid = (s: string) => s as TaskId;

describe('WorkflowEngine', () => {
  const defaultConfig = WorkflowStore.defaultWorkflow();

  it('loads default workflow with 3 task pipeline steps', () => {
    const engine = new WorkflowEngine(defaultConfig);
    const config = engine.getConfig();
    expect(config.task_pipeline).toHaveLength(3);
    expect(config.task_pipeline[0].step).toBe('implement');
    expect(config.task_pipeline[1].step).toBe('review');
    expect(config.task_pipeline[2].step).toBe('done');
  });

  it('initTask starts at step 0', () => {
    const engine = new WorkflowEngine(defaultConfig);
    const action = engine.initTask(tid('t1'));
    expect(action.type).toBe('assign_role');
    if (action.type === 'assign_role') {
      expect(action.role).toBe('worker');
      expect(action.step).toBe('implement');
    }
  });

  it('advanceTask moves through the pipeline', () => {
    const engine = new WorkflowEngine(defaultConfig);
    engine.initTask(tid('t1'));

    // advance from implement -> review
    const step1 = engine.advanceTask(tid('t1'));
    expect(step1.type).toBe('assign_role');
    if (step1.type === 'assign_role') {
      expect(step1.role).toBe('reviewer');
    }

    // advance from review -> done
    const step2 = engine.advanceTask(tid('t1'));
    expect(step2.type).toBe('done');

    // advance past done -> pipeline_complete
    const step3 = engine.advanceTask(tid('t1'));
    expect(step3.type).toBe('pipeline_complete');
  });

  it('handles run step with successful command', () => {
    const engine = new WorkflowEngine(defaultConfig);
    const result = engine.executeRunStep('echo hello');
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('hello');
  });

  it('handles run step with failing command', () => {
    const engine = new WorkflowEngine(defaultConfig);
    const result = engine.executeRunStep('false');
    expect(result.success).toBe(false);
  });

  it('handles on_fail: return_to_worker', () => {
    const config: WorkflowConfig = {
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'lint', run: 'npm run lint', on_fail: 'return_to_worker' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {},
    };
    const engine = new WorkflowEngine(config);
    engine.initTask(tid('t1'));
    engine.advanceTask(tid('t1')); // move to lint step

    const action = engine.handleFailure(tid('t1'), 'return_to_worker');
    expect(action.type).toBe('assign_role');
    if (action.type === 'assign_role') {
      expect(action.role).toBe('worker');
    }
  });

  it('handles on_fail: skip', () => {
    const config: WorkflowConfig = {
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'optional_lint', run: 'lint', on_fail: 'skip' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {},
    };
    const engine = new WorkflowEngine(config);
    engine.initTask(tid('t1'));
    engine.advanceTask(tid('t1')); // at optional_lint

    const action = engine.handleFailure(tid('t1'), 'skip');
    expect(action.type).toBe('done');
  });

  it('handles on_fail: reject', () => {
    const engine = new WorkflowEngine(defaultConfig);
    engine.initTask(tid('t1'));
    const action = engine.handleFailure(tid('t1'), 'reject');
    expect(action.type).toBe('done');
    if (action.type === 'done') {
      expect(action.step).toBe('rejected');
    }
  });

  it('runs submit hooks and reports failures', () => {
    const config: WorkflowConfig = {
      task_pipeline: [],
      spec_pipeline: [],
      hooks: {
        on_task_submit: [
          { run: 'echo ok', on_fail: 'warn' },
          { run: 'false', on_fail: 'reject' },
        ],
      },
    };
    const engine = new WorkflowEngine(config);
    const failures = engine.runSubmitHooks();
    expect(failures).toHaveLength(1);
    expect(failures[0].run).toBe('false');
    expect(failures[0].on_fail).toBe('reject');
  });

  it('handles discussion step type', () => {
    const config: WorkflowConfig = {
      task_pipeline: [
        { step: 'discuss', type: 'discussion', participants: ['lead', 'director'] },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {},
    };
    const engine = new WorkflowEngine(config);
    const action = engine.initTask(tid('t1'));
    expect(action.type).toBe('discussion');
    if (action.type === 'discussion') {
      expect(action.participants).toEqual(['lead', 'director']);
    }
  });

  it('pipeline with run step resolves correctly', () => {
    const config: WorkflowConfig = {
      task_pipeline: [
        { step: 'implement', role: 'worker' },
        { step: 'lint', run: 'echo lint-ok' },
        { step: 'done' },
      ],
      spec_pipeline: [],
      hooks: {},
    };
    const engine = new WorkflowEngine(config);
    engine.initTask(tid('t1'));
    const action = engine.advanceTask(tid('t1'));
    expect(action.type).toBe('run_command');
    if (action.type === 'run_command') {
      expect(action.command).toBe('echo lint-ok');
    }
  });
});

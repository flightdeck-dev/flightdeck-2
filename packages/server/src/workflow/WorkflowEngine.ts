/**
 * WorkflowEngine — executes task and spec pipelines.
 *
 * Tracks the current pipeline step for each task and advances them
 * through the configured workflow.
 */

import { execSync } from 'node:child_process';
import type { TaskId, AgentRole } from '@flightdeck-ai/shared';
import type { WorkflowConfig, PipelineStep } from '../storage/WorkflowStore.js';

export type StepAction =
  | { type: 'assign_role'; role: AgentRole; step: string }
  | { type: 'run_command'; command: string; step: string }
  | { type: 'discussion'; participants: string[]; step: string }
  | { type: 'done'; step: string }
  | { type: 'pipeline_complete' };

export type OnFailAction = 'return_to_worker' | 'reject' | 'warn' | 'skip';

export interface TaskPipelineState {
  taskId: TaskId;
  pipelineIndex: number;
}

export class WorkflowEngine {
  private config: WorkflowConfig;
  /** Maps taskId → current index in task_pipeline */
  private taskStates: Map<string, number> = new Map();

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  getConfig(): WorkflowConfig {
    return this.config;
  }

  setConfig(config: WorkflowConfig): void {
    this.config = config;
  }

  /** Get the current pipeline step for a task, defaulting to 0 */
  getTaskStep(taskId: TaskId): number {
    return this.taskStates.get(taskId) ?? 0;
  }

  /** Get the current step definition for a task */
  getCurrentStep(taskId: TaskId): PipelineStep | null {
    const idx = this.getTaskStep(taskId);
    return this.config.task_pipeline[idx] ?? null;
  }

  /** Determine the action for the current step */
  resolveStep(step: PipelineStep): StepAction {
    if (step.role) {
      return { type: 'assign_role', role: step.role, step: step.step };
    }
    if (step.run) {
      return { type: 'run_command', command: step.run, step: step.step };
    }
    if (step.type === 'discussion') {
      return { type: 'discussion', participants: step.participants ?? [], step: step.step };
    }
    if (step.step === 'done') {
      return { type: 'done', step: step.step };
    }
    // Steps with no role/run/type just advance
    return { type: 'done', step: step.step };
  }

  /**
   * Advance a task to the next pipeline step.
   * Returns the action needed for the new step, or pipeline_complete.
   */
  advanceTask(taskId: TaskId): StepAction {
    const current = this.getTaskStep(taskId);
    const nextIdx = current + 1;

    if (nextIdx >= this.config.task_pipeline.length) {
      this.taskStates.delete(taskId);
      return { type: 'pipeline_complete' };
    }

    this.taskStates.set(taskId, nextIdx);
    const step = this.config.task_pipeline[nextIdx];
    return this.resolveStep(step);
  }

  /**
   * Initialize a task at step 0 and return the action.
   */
  initTask(taskId: TaskId): StepAction {
    this.taskStates.set(taskId, 0);
    const step = this.config.task_pipeline[0];
    if (!step) return { type: 'pipeline_complete' };
    return this.resolveStep(step);
  }

  /**
   * Execute a `run` step (shell command). Returns true if success.
   */
  executeRunStep(command: string, cwd?: string): { success: boolean; output: string } {
    try {
      const output = execSync(command, {
        cwd,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  }

  /**
   * Handle on_fail for a step.
   * Returns the resulting action to take.
   */
  handleFailure(taskId: TaskId, failAction?: OnFailAction): StepAction {
    switch (failAction) {
      case 'return_to_worker':
        // Reset to the first worker step
        for (let i = 0; i < this.config.task_pipeline.length; i++) {
          if (this.config.task_pipeline[i].role === 'worker') {
            this.taskStates.set(taskId, i);
            return this.resolveStep(this.config.task_pipeline[i]);
          }
        }
        return this.initTask(taskId);
      case 'reject':
        this.taskStates.delete(taskId);
        return { type: 'done', step: 'rejected' };
      case 'skip':
        return this.advanceTask(taskId);
      case 'warn':
      default:
        // Warn but continue
        return this.advanceTask(taskId);
    }
  }

  /**
   * Run on_task_submit hooks. Returns list of failures.
   */
  runSubmitHooks(cwd?: string): Array<{ run: string; on_fail: string; output: string }> {
    const failures: Array<{ run: string; on_fail: string; output: string }> = [];
    const hooks = this.config.hooks.on_task_submit ?? [];
    for (const hook of hooks) {
      const result = this.executeRunStep(hook.run, cwd);
      if (!result.success) {
        failures.push({ run: hook.run, on_fail: hook.on_fail, output: result.output });
      }
    }
    return failures;
  }

  /**
   * Run on_spec_start hooks.
   */
  runSpecStartHooks(cwd?: string): Array<{ run: string; output: string }> {
    const failures: Array<{ run: string; output: string }> = [];
    const hooks = this.config.hooks.on_spec_start ?? [];
    for (const hook of hooks) {
      const result = this.executeRunStep(hook.run, cwd);
      if (!result.success) {
        failures.push({ run: hook.run, output: result.output });
      }
    }
    return failures;
  }
}

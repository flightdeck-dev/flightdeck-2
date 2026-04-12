import type { TaskId, AgentId, Task } from '@flightdeck-ai/shared';
import type { AgentManager } from '../agents/AgentManager.js';
import type { SqliteStore } from '../storage/SqliteStore.js';

export interface ReviewResult {
  taskId: TaskId;
  passed: boolean;
  feedback?: string;
  reviewerId?: AgentId;
}

/**
 * Process a review for a task that's in_review state.
 *
 * This is called by the Orchestrator when a task transitions to in_review.
 * Currently auto-approves (stub); will be wired to spawn a real reviewer agent later.
 */
export async function processReview(
  taskId: TaskId,
  sqlite: SqliteStore,
  agentManager?: AgentManager,
): Promise<ReviewResult> {
  // 1. Get the task's claim and artifacts
  const task = sqlite.getTask(taskId);
  if (!task) {
    return { taskId, passed: false, feedback: `Task ${taskId} not found` };
  }

  if (task.state !== 'in_review') {
    return { taskId, passed: false, feedback: `Task ${taskId} is not in_review (current: ${task.state})` };
  }

  // 2. In the future: spawn a reviewer agent (different model) via agentManager
  //    const reviewer = await agentManager.spawnAgent({ role: 'reviewer', model: 'different-model', ... });
  //    const verdict = await reviewer.review(task.claim, artifacts);

  // 3. For now: auto-approve (stub)
  //    The data flow is correct — task goes in_review → processReview called → mark done
  sqlite.updateTaskState(taskId, 'done');

  return {
    taskId,
    passed: true,
    feedback: undefined,
    reviewerId: undefined,
  };
}

/**
 * Reject a review — returns task to worker with feedback for retry.
 */
export async function rejectReview(
  taskId: TaskId,
  feedback: string,
  sqlite: SqliteStore,
): Promise<ReviewResult> {
  const task = sqlite.getTask(taskId);
  if (!task) {
    return { taskId, passed: false, feedback: `Task ${taskId} not found` };
  }

  // Return to running state so worker can retry
  sqlite.updateTaskState(taskId, 'running');

  return {
    taskId,
    passed: false,
    feedback,
  };
}

import type { TaskId, AgentId } from '@flightdeck-ai/shared';
import type { AgentAdapter, AgentMetadata } from '../agents/AgentAdapter.js';
import type { SqliteStore } from '../storage/SqliteStore.js';

export interface ReviewResult {
  taskId: TaskId;
  passed: boolean;
  feedback?: string;
  reviewerId?: AgentId;
}

export type ReviewVerdict = 'approve' | 'request-changes' | 'reject';

export interface ParsedReview {
  verdict: ReviewVerdict;
  feedback: string;
}

/** Default timeout for reviewer agent (5 minutes). */
const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

/** Poll interval when waiting for reviewer output. */
const POLL_INTERVAL_MS = 2000;

/**
 * Build the review prompt sent to the reviewer agent.
 */
export function buildReviewPrompt(task: {
  id: TaskId;
  title?: string;
  claim?: string;
  diff?: string;
  artifacts?: string[];
}): string {
  const sections: string[] = [
    `## Code Review Request`,
    `**Task ID:** ${task.id}`,
  ];
  if (task.title) sections.push(`**Task:** ${task.title}`);
  if (task.claim) sections.push(`**Agent's claim:** ${task.claim}`);
  if (task.diff) sections.push(`\n### Changes\n\`\`\`diff\n${task.diff}\n\`\`\``);
  if (task.artifacts?.length) {
    sections.push(`\n### Artifacts\n${task.artifacts.map(a => `- ${a}`).join('\n')}`);
  }
  sections.push(`
## Instructions
Review the changes above. Respond with exactly one of these verdicts on the FIRST line:

VERDICT: APPROVE
VERDICT: REQUEST-CHANGES
VERDICT: REJECT

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type not available
Then provide your reasoning and any feedback below the verdict line.
Focus on: correctness, edge cases, security, and whether the claim matches the actual changes.`);
  return sections.join('\n');
}

/**
 * Parse a reviewer agent's output into a structured verdict.
 */
export function parseReviewerResponse(output: string): ParsedReview {
  const lines = output.trim().split('\n');
  const verdictLine = lines.find(l => /^\s*VERDICT:\s*/i.test(l));

  if (!verdictLine) {
    // No explicit verdict — try to infer from keywords
    const lower = output.toLowerCase();
    if (lower.includes('approve') && !lower.includes('not approve') && !lower.includes("don't approve")) {
      return { verdict: 'approve', feedback: output.trim() };
    }
    if (lower.includes('reject')) {
      return { verdict: 'reject', feedback: output.trim() };
    }
    // Default to request-changes if we can't parse
    return { verdict: 'request-changes', feedback: output.trim() || 'Unable to parse reviewer response' };
  }

  const raw = verdictLine.replace(/^\s*VERDICT:\s*/i, '').trim().toLowerCase();
  const feedbackStart = output.indexOf(verdictLine) + verdictLine.length;
  const feedback = output.slice(feedbackStart).trim();

  if (raw === 'approve' || raw === 'approved') {
    return { verdict: 'approve', feedback };
  }
  if (raw.startsWith('request') || raw === 'changes-requested') {
    return { verdict: 'request-changes', feedback };
  }
  if (raw === 'reject' || raw === 'rejected') {
    return { verdict: 'reject', feedback };
  }

  return { verdict: 'request-changes', feedback: feedback || output.trim() };
}

/**
 * Wait for a reviewer agent to finish and return its output.
 * Polls getMetadata until the agent is idle/ended or timeout is reached.
 */
async function waitForReviewer(
  adapter: AgentAdapter,
  sessionId: string,
  getOutput: () => string,
  timeoutMs: number,
): Promise<{ output: string; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const meta = await adapter.getMetadata(sessionId);
    if (!meta || meta.status === 'ended' || meta.status === 'idle') {
      return { output: getOutput(), timedOut: false };
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timed out — kill and return what we have
  try { await adapter.kill(sessionId); } catch { /* best effort */ }
  return { output: getOutput(), timedOut: true };
}

/**
 * Process a review for a task in in_review state.
 *
 * Spawns a reviewer agent via AcpAdapter, waits for its verdict,
 * and transitions the task accordingly.
 */
export async function processReview(
  taskId: TaskId,
  sqlite: SqliteStore,
  adapter?: AgentAdapter,
  options?: {
    timeoutMs?: number;
    reviewerModel?: string;
    diff?: string;
    artifacts?: string[];
    cwd?: string;
    /** For testing: function to retrieve agent output */
    getOutput?: (sessionId: string) => string;
  },
): Promise<ReviewResult> {
  const task = sqlite.getTask(taskId);
  if (!task) {
    return { taskId, passed: false, feedback: `Task ${taskId} not found` };
  }

  if (task.state !== 'in_review') {
    return { taskId, passed: false, feedback: `Task ${taskId} is not in_review (current: ${task.state})` };
  }

  // If no adapter provided, fall back to auto-approve (backwards compatible)
  if (!adapter) {
    sqlite.updateTaskState(taskId, 'done');
    return { taskId, passed: true };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const prompt = buildReviewPrompt({
    id: taskId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing untyped task/adapter properties
    title: (task as any).title,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing untyped task/adapter properties
    claim: (task as any).claim,
    diff: options?.diff,
    artifacts: options?.artifacts,
  });

  let meta: AgentMetadata;
  try {
    meta = await adapter.spawn({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type mismatch with internal API
      role: 'reviewer' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing untyped task/adapter properties
      cwd: options?.cwd ?? (task as any).cwd ?? process.cwd(),
      model: options?.reviewerModel,
      systemPrompt: prompt,
    });
  } catch (err: unknown) {
    // Spawn failure — don't block the pipeline, return pending
    return {
      taskId,
      passed: false,
      feedback: `Failed to spawn reviewer: ${err.message}`,
    };
  }

  // Wait for the reviewer to complete
  const getOutput = options?.getOutput
    ? () => options.getOutput!(meta.sessionId)
    : () => {
        // For AcpAdapter, access session output directly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing untyped task/adapter properties
        const session = (adapter as any).getSession?.(meta.sessionId);
        return session?.output ?? '';
      };

  const { output, timedOut } = await waitForReviewer(
    adapter,
    meta.sessionId,
    getOutput,
    timeoutMs,
  );

  if (timedOut && !output.trim()) {
    // Total timeout with no output — leave in review for retry
    return {
      taskId,
      passed: false,
      feedback: 'Review timed out with no response',
      reviewerId: meta.agentId,
    };
  }

  const parsed = parseReviewerResponse(output);

  switch (parsed.verdict) {
    case 'approve':
      sqlite.updateTaskState(taskId, 'done');
      return {
        taskId,
        passed: true,
        feedback: parsed.feedback || undefined,
        reviewerId: meta.agentId,
      };

    case 'reject':
      sqlite.updateTaskState(taskId, 'failed');
      return {
        taskId,
        passed: false,
        feedback: parsed.feedback || 'Rejected by reviewer',
        reviewerId: meta.agentId,
      };

    case 'request-changes':
    default:
      // Return to running so worker can address feedback
      sqlite.updateTaskState(taskId, 'running');
      return {
        taskId,
        passed: false,
        feedback: parsed.feedback || 'Changes requested by reviewer',
        reviewerId: meta.agentId,
      };
  }
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

  sqlite.updateTaskState(taskId, 'running');

  return {
    taskId,
    passed: false,
    feedback,
  };
}

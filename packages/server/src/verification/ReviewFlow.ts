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
Review the changes above. You MUST submit your review using the \`flightdeck_review_submit\` MCP tool:

\`\`\`
flightdeck_review_submit({
  taskId: "${task.id}",
  verdict: "approve",        // or "request_changes"
  comment: "Your feedback"
})
\`\`\`

- **approve** — Work meets requirements, task will be marked done.
- **request_changes** — Worker must address your feedback.

Always include a comment explaining your reasoning.
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
    // Default to request-changes if we can't parse — but only if there's
    // substantial output (not just error noise)
    if (output.trim().length < 20) {
      return { verdict: 'approve', feedback: 'Reviewer output too short to parse; auto-approving.' };
    }
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
    reviewerRuntime?: string;
    diff?: string;
    artifacts?: string[];
    cwd?: string;
    projectName?: string;
    /** Use AgentManager for spawning (handles DB registration, role config, AGENTS.md, .mcp.json) */
    agentManager?: import('../agents/AgentManager.js').AgentManager;
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
    if (options?.agentManager) {
      // Use AgentManager — handles DB registration, role config, AGENTS.md, .mcp.json
      const agent = await options.agentManager.spawnAgent({
        role: 'reviewer',
        cwd: options?.cwd ?? (task as any).cwd ?? process.cwd(),
        model: options?.reviewerModel,
        runtime: options?.reviewerRuntime,
        projectName: options?.projectName,
        taskContext: prompt,
      });
      meta = {
        agentId: agent.id as string as import('@flightdeck-ai/shared').AgentId,
        sessionId: agent.acpSessionId ?? '',
        status: 'running',
      };
    } else {
      // Fallback: direct adapter.spawn (for tests or when no AgentManager)
      const reviewerAgentId = `reviewer-${Date.now().toString(36)}` as import('@flightdeck-ai/shared').AgentId;
      sqlite.insertAgent({
        id: reviewerAgentId,
        role: 'reviewer',
        runtime: 'acp',
        acpSessionId: null,
        status: 'busy',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });
      meta = await adapter!.spawn({
        agentId: reviewerAgentId,
        role: 'reviewer' as any,
        cwd: options?.cwd ?? (task as any).cwd ?? process.cwd(),
        model: options?.reviewerModel,
        runtime: options?.reviewerRuntime,
        systemPrompt: prompt,
        projectName: options?.projectName,
      });
    }
  } catch (err: unknown) {
    // Spawn failure — don't block the pipeline, return pending
    return {
      taskId,
      passed: false,
      feedback: `Failed to spawn reviewer: ${(err as Error).message}`,
    };
  }

  // Wait for the reviewer to submit via flightdeck_review_submit tool.
  // The tool directly transitions the task state (done or running).
  // We poll task state instead of parsing reviewer output.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const current = sqlite.getTask(taskId);
    if (!current || current.state !== 'in_review') {
      // Task state changed — reviewer submitted via tool
      const passed = current?.state === 'done';
      // Get the latest review comment
      const comments = sqlite.getTaskComments(taskId);
      const reviewComment = comments.filter(c => c.type === 'review').pop();
      return {
        taskId,
        passed,
        feedback: reviewComment?.content ?? (passed ? 'Approved' : 'Changes requested'),
        reviewerId: meta.agentId,
      };
    }
    // Check if reviewer session ended without submitting
    try {
      const sessionMeta = await adapter.getMetadata(meta.sessionId);
      if (sessionMeta?.status === 'ended') {
        // Reviewer exited without calling review_submit — leave in_review
        return {
          taskId,
          passed: false,
          feedback: 'Reviewer session ended without submitting a review. Use flightdeck_review_submit.',
          reviewerId: meta.agentId,
        };
      }
    } catch { /* session may be cleaned up */ }
  }

  // Timeout — leave in in_review for Lead to handle
  return {
    taskId,
    passed: false,
    feedback: 'Review timed out. Reviewer did not call flightdeck_review_submit in time.',
    reviewerId: meta.agentId,
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

  sqlite.updateTaskState(taskId, 'running');

  return {
    taskId,
    passed: false,
    feedback,
  };
}

import type { TaskId, AgentId } from '@flightdeck-ai/shared';

export interface VerificationResult {
  taskId: TaskId;
  passed: boolean;
  feedback?: string;
  reviewerId: AgentId;
  timestamp: string;
}

/**
 * Verifier orchestrates claim-vs-reality checks.
 * It doesn't run tests or lint — it checks if agent's claim matches artifacts.
 * Actual verification is done by spawning a reviewer agent.
 */
export class Verifier {
  async verify(opts: {
    taskId: TaskId;
    claim: string;
    artifacts: string[];  // file paths or diff references
    reviewerId: AgentId;
  }): Promise<VerificationResult> {
    // In a real implementation, this would spawn a reviewer agent via ACP
    // and ask it to compare claim vs artifacts.
    // For now, this is a stub that returns a pending result.
    return {
      taskId: opts.taskId,
      passed: false, // will be updated by reviewer
      feedback: 'Pending reviewer evaluation',
      reviewerId: opts.reviewerId,
      timestamp: new Date().toISOString(),
    };
  }
}

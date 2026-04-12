import { describe, it, expect } from 'vitest';
import { Verifier } from '../../src/verification/Verifier.js';
import type { TaskId, AgentId } from '@flightdeck-ai/shared';

describe('Verifier', () => {
  it('returns a pending verification result', async () => {
    const verifier = new Verifier();
    const result = await verifier.verify({
      taskId: 'task-1' as TaskId,
      claim: 'Implemented OAuth',
      artifacts: ['src/auth.ts'],
      reviewerId: 'agent-reviewer' as AgentId,
    });
    expect(result.taskId).toBe('task-1');
    expect(result.reviewerId).toBe('agent-reviewer');
    expect(result.passed).toBe(false); // pending
    expect(result.timestamp).toBeTruthy();
  });
});

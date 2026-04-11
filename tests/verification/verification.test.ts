import { describe, it, expect } from 'vitest';
import { VerificationEngine } from '../../src/verification/VerificationEngine.js';
import { type TaskId, type AgentId } from '../../src/core/types.js';

const taskA = 'tk-aaaa' as TaskId;
const writerAgent = 'ag-writer' as AgentId;
const reviewerAgent = 'ag-reviewer' as AgentId;
const reviewerAgent2 = 'ag-reviewer2' as AgentId;

describe('VerificationEngine', () => {
  it('creates a review request', () => {
    const engine = new VerificationEngine();
    const review = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4' });
    expect(review.id).toBeDefined();
    expect(review.writerModel).toBe('gpt-4');
  });

  it('enforces cross-model rule', () => {
    const engine = new VerificationEngine();
    const review = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4' });
    const result = engine.assignReviewer(review.id, reviewerAgent, 'gpt-4');
    expect('error' in result).toBe(true);
  });

  it('allows different model for reviewer', () => {
    const engine = new VerificationEngine();
    const review = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4' });
    const result = engine.assignReviewer(review.id, reviewerAgent, 'claude-3');
    expect('error' in result).toBe(false);
  });

  it('prevents self-review', () => {
    const engine = new VerificationEngine();
    const review = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4' });
    const result = engine.assignReviewer(review.id, writerAgent, 'claude-3');
    expect('error' in result).toBe(true);
  });

  it('enforces fresh reviewer on retry', () => {
    const engine = new VerificationEngine();

    // First review
    const r1 = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4', attempt: 1 });
    engine.assignReviewer(r1.id, reviewerAgent, 'claude-3');
    engine.submitVerdict(r1.id, 'rejected', ['Bad code']);

    // Retry — same reviewer should be rejected
    const r2 = engine.requestReview({ taskId: taskA, writerAgent, writerModel: 'gpt-4', attempt: 2 });
    const result = engine.assignReviewer(r2.id, reviewerAgent, 'claude-3');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('Fresh reviewer');

    // Different reviewer should work
    const result2 = engine.assignReviewer(r2.id, reviewerAgent2, 'claude-3');
    expect('error' in result2).toBe(false);
  });

  it('blocking quality gates prevent commit', () => {
    const engine = new VerificationEngine();
    const gate = engine.addGate(taskA, 'review', true);
    engine.addGate(taskA, 'ci', true);

    // Can't commit with unchecked gates
    let status = engine.canCommit(taskA);
    expect(status.allowed).toBe(false);
    expect(status.blockers.length).toBe(2);

    // Pass one gate
    engine.passGate(gate.id, 'Review passed');
    status = engine.canCommit(taskA);
    expect(status.allowed).toBe(false);
    expect(status.blockers.length).toBe(1);
  });

  it('independent validation records are from orchestrator', () => {
    const engine = new VerificationEngine();
    const result = engine.recordValidation(taskA, true, 'All tests passed: 42/42');
    expect(result.validatedBy).toBe('orchestrator');
    expect(result.passed).toBe(true);
  });
});

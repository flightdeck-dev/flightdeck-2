import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processReview,
  rejectReview,
  buildReviewPrompt,
  parseReviewerResponse,
} from '../../src/verification/ReviewFlow.js';
import type { TaskId, AgentId } from '@flightdeck-ai/shared';
import type { AgentAdapter, AgentMetadata } from '../../src/agents/AgentAdapter.js';
import type { SqliteStore } from '../../src/storage/SqliteStore.js';

// --- Helpers ---

function mockStore(task: any = null): SqliteStore {
  let taskState = task?.state ?? null;
  return {
    getTask: vi.fn().mockImplementation(() => task ? { ...task, state: taskState } : null),
    updateTaskState: vi.fn().mockImplementation((_id: any, state: any) => { taskState = state; }),
    getTaskComments: vi.fn().mockReturnValue([]),
    addTaskComment: vi.fn(),
    // Helper to simulate reviewer calling review_submit tool
    _simulateReviewSubmit(verdict: 'approve' | 'request_changes', comment: string) {
      if (verdict === 'approve') taskState = 'done';
      else taskState = 'running';
    },
  } as unknown as SqliteStore;
}

function mockAdapter(opts: {
  output?: string;
  status?: AgentMetadata['status'];
  spawnError?: Error;
} = {}): AgentAdapter & { spawnedWith: any } {
  const agentId = 'reviewer-001' as AgentId;
  const sessionId = 'session-abc';
  const obj: any = {
    runtime: 'acp',
    spawnedWith: null,
    spawn: vi.fn().mockImplementation(async (spawnOpts: any) => {
      if (opts.spawnError) throw opts.spawnError;
      obj.spawnedWith = spawnOpts;
      return { agentId, sessionId, status: 'running' } as AgentMetadata;
    }),
    steer: vi.fn(),
    kill: vi.fn(),
    getMetadata: vi.fn().mockResolvedValue({
      agentId,
      sessionId,
      status: opts.status ?? 'ended',
    }),
  };
  // getOutput helper for tests
  obj._output = opts.output ?? '';
  return obj;
}

// --- Unit: parseReviewerResponse ---

describe('parseReviewerResponse', () => {
  it('parses VERDICT: APPROVE', () => {
    const r = parseReviewerResponse('VERDICT: APPROVE\nLooks good, clean implementation.');
    expect(r.verdict).toBe('approve');
    expect(r.feedback).toContain('clean implementation');
  });

  it('parses VERDICT: REQUEST-CHANGES', () => {
    const r = parseReviewerResponse('VERDICT: REQUEST-CHANGES\nMissing error handling in line 42.');
    expect(r.verdict).toBe('request-changes');
    expect(r.feedback).toContain('error handling');
  });

  it('parses VERDICT: REJECT', () => {
    const r = parseReviewerResponse('VERDICT: REJECT\nFundamentally wrong approach.');
    expect(r.verdict).toBe('reject');
    expect(r.feedback).toContain('wrong approach');
  });

  it('infers approve from keywords when no VERDICT line', () => {
    const r = parseReviewerResponse('I approve these changes. They look solid.');
    expect(r.verdict).toBe('approve');
  });

  it('infers reject from keywords', () => {
    const r = parseReviewerResponse('I must reject this PR due to security issues.');
    expect(r.verdict).toBe('reject');
  });

  it('defaults to request-changes for ambiguous output', () => {
    const r = parseReviewerResponse('Some issues need fixing before this can merge.');
    expect(r.verdict).toBe('request-changes');
  });

  it('handles empty output', () => {
    const r = parseReviewerResponse('');
    expect(r.verdict).toBe('approve'); // Short/empty output auto-approves
  });

  it('handles case-insensitive verdict', () => {
    const r = parseReviewerResponse('verdict: Approve\nAll good');
    expect(r.verdict).toBe('approve');
  });
});

// --- Unit: buildReviewPrompt ---

describe('buildReviewPrompt', () => {
  it('includes task ID and claim', () => {
    const prompt = buildReviewPrompt({
      id: 'task-42' as TaskId,
      title: 'Fix auth bug',
      claim: 'Fixed the OAuth token refresh',
    });
    expect(prompt).toContain('task-42');
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('OAuth token refresh');
    expect(prompt).toContain('VERDICT: APPROVE');
  });

  it('includes diff when provided', () => {
    const prompt = buildReviewPrompt({
      id: 'task-1' as TaskId,
      diff: '+const x = 1;\n-const x = 2;',
    });
    expect(prompt).toContain('+const x = 1;');
  });

  it('includes artifacts list', () => {
    const prompt = buildReviewPrompt({
      id: 'task-1' as TaskId,
      artifacts: ['src/auth.ts', 'src/login.ts'],
    });
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/login.ts');
  });
});

// --- Integration: processReview ---

describe('processReview', () => {
  it('returns error if task not found', async () => {
    const store = mockStore(null);
    const result = await processReview('task-missing' as TaskId, store);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('not found');
  });

  it('returns error if task not in_review', async () => {
    const store = mockStore({ id: 'task-1', state: 'running' });
    const result = await processReview('task-1' as TaskId, store);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('not in_review');
  });

  it('auto-approves when no adapter provided (backwards compat)', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    const result = await processReview('task-1' as TaskId, store);
    expect(result.passed).toBe(true);
    expect(store.updateTaskState).toHaveBeenCalledWith('task-1', 'done');
  });

  it('spawns reviewer and detects approve via tool', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review', claim: 'Fixed bug' });
    const adapter = mockAdapter({ status: 'ended' });
    // Simulate: reviewer calls review_submit(approve) → task state changes to done
    setTimeout(() => (store as any)._simulateReviewSubmit('approve', 'LGTM'), 500);
    const result = await processReview('task-1' as TaskId, store, adapter, {
      timeoutMs: 3000,
      cwd: '/tmp',
    });
    expect(result.passed).toBe(true);
    expect(result.reviewerId).toBe('reviewer-001');
    expect(adapter.spawn).toHaveBeenCalled();
  });

  it('detects request_changes via tool', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    const adapter = mockAdapter({ status: 'ended' });
    // Simulate: reviewer calls review_submit(request_changes)
    setTimeout(() => (store as any)._simulateReviewSubmit('request_changes', 'Need tests'), 500);
    const result = await processReview('task-1' as TaskId, store, adapter, {
      timeoutMs: 3000,
      cwd: '/tmp',
    });
    expect(result.passed).toBe(false);
  });

  it('handles reviewer exit without submitting review', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    const adapter = mockAdapter({ status: 'ended' });
    // Reviewer session ends but task stays in_review (no review_submit called)
    const result = await processReview('task-1' as TaskId, store, adapter, {
      timeoutMs: 1000,
      cwd: '/tmp',
    });
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('ended without submitting');
  });

  it('handles spawn failure gracefully', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    const adapter = mockAdapter({ spawnError: new Error('Runtime not found') });
    const result = await processReview('task-1' as TaskId, store, adapter, {
      timeoutMs: 1000,
      cwd: '/tmp',
    });
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Failed to spawn reviewer');
  });

  it('handles timeout when reviewer never submits', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    // Adapter stays 'running' — reviewer never calls review_submit
    const adapter = mockAdapter({ status: 'running' });
    const result = await processReview('task-1' as TaskId, store, adapter, {
      timeoutMs: 200,
      cwd: '/tmp',
    });
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('timed out');
  });

});

// --- rejectReview ---

describe('rejectReview', () => {
  it('returns task to running with feedback', async () => {
    const store = mockStore({ id: 'task-1', state: 'in_review' });
    const result = await rejectReview('task-1' as TaskId, 'Needs more tests', store);
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe('Needs more tests');
    expect(store.updateTaskState).toHaveBeenCalledWith('task-1', 'running');
  });

  it('handles missing task', async () => {
    const store = mockStore(null);
    const result = await rejectReview('task-x' as TaskId, 'feedback', store);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('not found');
  });
});

import { describe, it, expect } from 'vitest';
import {
  transition, isTransitionError, taskId,
  type TaskState, type TaskAction, type TaskId,
  TRANSITION_TABLE,
} from '../../src/core/types.js';

describe('State Machine', () => {
  const id = taskId('test-task');

  it('transitions pending → ready on start', () => {
    const result = transition(id, 'pending', 'start');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('ready');
    }
  });

  it('transitions ready → running on start', () => {
    const result = transition(id, 'ready', 'start');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('running');
      expect(result.sideEffects.some(e => e.type === 'emit_event')).toBe(true);
    }
  });

  it('transitions running → done on complete with side effects', () => {
    const result = transition(id, 'running', 'complete');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('done');
      expect(result.sideEffects.some(e => e.type === 'resolve_dependents')).toBe(true);
      expect(result.sideEffects.some(e => e.type === 'compact')).toBe(true);
    }
  });

  it('transitions running → failed on fail with block_dependents', () => {
    const result = transition(id, 'running', 'fail');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('failed');
      expect(result.sideEffects.some(e => e.type === 'block_dependents')).toBe(true);
    }
  });

  it('transitions running → in_review on review with spawn_reviewer', () => {
    const result = transition(id, 'running', 'review');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('in_review');
      expect(result.sideEffects.some(e => e.type === 'spawn_reviewer')).toBe(true);
    }
  });

  it('transitions in_review → done on approve', () => {
    const result = transition(id, 'in_review', 'approve');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('done');
    }
  });

  it('transitions in_review → failed on reject', () => {
    const result = transition(id, 'in_review', 'reject');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('failed');
    }
  });

  it('transitions gated → ready on clear_gate', () => {
    const result = transition(id, 'gated', 'clear_gate');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('ready');
    }
  });

  it('transitions failed → ready on retry', () => {
    const result = transition(id, 'failed', 'retry');
    expect(isTransitionError(result)).toBe(false);
    if (!isTransitionError(result)) {
      expect(result.newState).toBe('ready');
    }
  });

  it('returns error for invalid transition', () => {
    const result = transition(id, 'done', 'start');
    expect(isTransitionError(result)).toBe(true);
    if (isTransitionError(result)) {
      expect(result.reason).toContain('not valid');
    }
  });

  it('returns error for running → retry (not allowed)', () => {
    const result = transition(id, 'running', 'retry');
    expect(isTransitionError(result)).toBe(true);
  });

  it('allows skip from most active states', () => {
    for (const state of ['running', 'blocked', 'paused', 'gated', 'failed'] as TaskState[]) {
      const result = transition(id, state, 'skip');
      expect(isTransitionError(result)).toBe(false);
      if (!isTransitionError(result)) {
        expect(result.newState).toBe('skipped');
      }
    }
  });
});

describe('Hash-based IDs', () => {
  it('generates deterministic IDs with same seed', () => {
    const id1 = taskId('same-seed');
    const id2 = taskId('same-seed');
    expect(id1).toBe(id2);
  });

  it('generates different IDs with different seeds', () => {
    const id1 = taskId('seed-a');
    const id2 = taskId('seed-b');
    expect(id1).not.toBe(id2);
  });

  it('generates IDs with correct prefix', () => {
    const id = taskId('test');
    expect(id.startsWith('tk-')).toBe(true);
  });
});

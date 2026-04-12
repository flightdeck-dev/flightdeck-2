import { describe, it, expect } from 'vitest';
import { transition, isValidTransition } from '../../src/core/types.js';
import type { TaskId, AgentId } from '../../src/core/types.js';

describe('State Machine', () => {
  it('allows valid transitions', () => {
    expect(isValidTransition('pending', 'ready')).toBe(true);
    expect(isValidTransition('ready', 'running')).toBe(true);
    expect(isValidTransition('running', 'in_review')).toBe(true);
    expect(isValidTransition('running', 'done')).toBe(false);
    expect(isValidTransition('in_review', 'done')).toBe(true);
    expect(isValidTransition('failed', 'ready')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(isValidTransition('pending', 'done')).toBe(false);
    expect(isValidTransition('done', 'running')).toBe(false);
    expect(isValidTransition('ready', 'done')).toBe(false);
  });

  it('transition() returns new state and effects', () => {
    const result = transition('ready', 'running');
    expect(result.newState).toBe('running');
    expect(result.effects).toEqual([]);
  });

  it('transition() throws on invalid transition', () => {
    expect(() => transition('pending', 'done')).toThrow('Invalid state transition');
  });

  it('emits spawn_reviewer effect on running->in_review', () => {
    const result = transition('running', 'in_review', { taskId: 'task-abc' as TaskId });
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe('spawn_reviewer');
  });

  it('emits resolve_dependents effect on in_review->done', () => {
    const result = transition('in_review', 'done', { taskId: 'task-abc' as TaskId });
    expect(result.effects.some(e => e.type === 'resolve_dependents')).toBe(true);
    expect(result.effects.some(e => e.type === 'set_timestamp')).toBe(true);
  });

  it('emits escalate effect on failure', () => {
    const result = transition('running', 'failed', { taskId: 'task-abc' as TaskId });
    expect(result.effects.some(e => e.type === 'escalate')).toBe(true);
    expect(result.effects.some(e => e.type === 'block_dependents')).toBe(true);
    expect(result.effects.some(e => e.type === 'clear_assignment')).toBe(true);
  });
});

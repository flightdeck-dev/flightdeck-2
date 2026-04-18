import { describe, it, expect } from 'vitest';
import { STATE_COLORS, MAX_MESSAGES } from '../lib/constants.ts';

describe('STATE_COLORS', () => {
  it('has all expected states', () => {
    const expected = ['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'cancelled', 'paused', 'skipped'];
    for (const state of expected) {
      expect(STATE_COLORS).toHaveProperty(state);
    }
  });

  it('values are CSS variable strings', () => {
    for (const val of Object.values(STATE_COLORS)) {
      expect(val).toMatch(/^var\(--/);
    }
  });
});

describe('MAX_MESSAGES', () => {
  it('is a positive number', () => {
    expect(MAX_MESSAGES).toBeGreaterThan(0);
    expect(typeof MAX_MESSAGES).toBe('number');
  });
});

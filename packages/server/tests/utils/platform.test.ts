import { describe, it, expect } from 'vitest';
import { commandExists } from '../../src/utils/platform.js';

describe('commandExists', () => {
  it('returns true for node', () => {
    expect(commandExists('node')).toBe(true);
  });

  it('returns false for nonexistent binary', () => {
    expect(commandExists('nonexistent-binary-xyz-12345')).toBe(false);
  });
});

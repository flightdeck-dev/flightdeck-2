import { describe, it, expect } from 'vitest';
import { interpolateArgs } from '../../src/agents/interpolateArgs.js';

describe('interpolateArgs', () => {
  it('replaces placeholders with values', () => {
    const result = interpolateArgs(['{name}', '--dir={dir}'], { name: 'test', dir: '/tmp' });
    expect(result).toEqual(['test', '--dir=/tmp']);
  });

  it('leaves args without placeholders unchanged', () => {
    const result = interpolateArgs(['--verbose', 'run'], { name: 'test' });
    expect(result).toEqual(['--verbose', 'run']);
  });

  it('handles missing vars (leaves placeholder)', () => {
    const result = interpolateArgs(['{missing}'], {});
    expect(result).toEqual(['{missing}']);
  });

  it('replaces multiple occurrences in same arg', () => {
    const result = interpolateArgs(['{a}-{a}'], { a: 'x' });
    expect(result).toEqual(['x-x']);
  });

  it('handles empty args array', () => {
    expect(interpolateArgs([], { a: 'b' })).toEqual([]);
  });

  it('handles empty vars', () => {
    expect(interpolateArgs(['hello'], {})).toEqual(['hello']);
  });
});

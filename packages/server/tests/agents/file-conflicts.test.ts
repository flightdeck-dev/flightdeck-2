import { describe, it, expect } from 'vitest';
import { detectFileConflicts } from '../../src/agents/fileConflicts.js';

describe('detectFileConflicts', () => {
  it('returns empty when no conflicts', () => {
    const map = new Map([
      ['task-1', ['src/a.ts', 'src/b.ts']],
      ['task-2', ['src/c.ts', 'src/d.ts']],
    ]);
    expect(detectFileConflicts(map)).toEqual([]);
  });

  it('detects overlapping files between tasks', () => {
    const map = new Map([
      ['task-1', ['src/a.ts', 'src/shared.ts']],
      ['task-2', ['src/b.ts', 'src/shared.ts']],
    ]);
    const conflicts = detectFileConflicts(map);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe('src/shared.ts');
    expect(conflicts[0].taskIds).toEqual(['task-1', 'task-2']);
  });

  it('normalizes backslashes to forward slashes', () => {
    const map = new Map([
      ['task-1', ['src\\shared.ts']],
      ['task-2', ['src/shared.ts']],
    ]);
    const conflicts = detectFileConflicts(map);
    expect(conflicts).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(detectFileConflicts(new Map())).toEqual([]);
  });

  it('detects multiple conflicts', () => {
    const map = new Map([
      ['task-1', ['a.ts', 'b.ts']],
      ['task-2', ['a.ts', 'b.ts']],
    ]);
    const conflicts = detectFileConflicts(map);
    expect(conflicts).toHaveLength(2);
  });

  it('handles three-way conflicts', () => {
    const map = new Map([
      ['task-1', ['shared.ts']],
      ['task-2', ['shared.ts']],
      ['task-3', ['shared.ts']],
    ]);
    const conflicts = detectFileConflicts(map);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].taskIds).toHaveLength(3);
  });
});

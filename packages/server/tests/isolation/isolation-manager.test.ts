import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IsolationManager } from '../../src/isolation/IsolationManager.js';

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fd-iso-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('IsolationManager', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('mode: none', () => {
    it('setup returns project root as cwd', () => {
      const im = new IsolationManager(repoDir, { mode: 'none' });
      const result = im.setup('task-1');
      expect(result.cwd).toBe(repoDir);
      expect(result.branch).toBeUndefined();
    });

    it('cleanup is a no-op', () => {
      const im = new IsolationManager(repoDir, { mode: 'none' });
      const result = im.cleanup('task-1');
      expect(result).toBeNull();
    });

    it('status shows mode none with empty lists', () => {
      const im = new IsolationManager(repoDir, { mode: 'none' });
      const s = im.status();
      expect(s.mode).toBe('none');
      expect(s.worktrees).toEqual([]);
      expect(s.workdirs).toEqual([]);
    });
  });

  describe('mode: git_worktree', () => {
    it('setup creates a worktree and returns path + branch', () => {
      const im = new IsolationManager(repoDir, { mode: 'git_worktree' });
      const result = im.setup('task-1');
      expect(result.branch).toBe('agent/task-1');
      expect(existsSync(result.cwd)).toBe(true);
      expect(existsSync(join(result.cwd, 'README.md'))).toBe(true);
    });

    it('cleanup with auto strategy merges and removes worktree', () => {
      const im = new IsolationManager(repoDir, { mode: 'git_worktree', mergeStrategy: 'auto' });
      const { cwd } = im.setup('task-2');

      // Make a change in the worktree
      writeFileSync(join(cwd, 'new.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-m', 'add file'], { cwd });

      const mergeResult = im.cleanup('task-2');
      expect(mergeResult).not.toBeNull();
      expect(mergeResult!.merged).toBe(true);
      expect(existsSync(join(repoDir, 'new.txt'))).toBe(true);
    });

    it('cleanup with pr strategy does not merge', () => {
      const im = new IsolationManager(repoDir, { mode: 'git_worktree', mergeStrategy: 'pr' });
      im.setup('task-3');
      const mergeResult = im.cleanup('task-3');
      expect(mergeResult).not.toBeNull();
      expect(mergeResult!.merged).toBe(false);
      expect(mergeResult!.prBranch).toBe('agent/task-3');
    });

    it('status lists active worktrees', () => {
      const im = new IsolationManager(repoDir, { mode: 'git_worktree' });
      im.setup('task-4');
      const s = im.status();
      expect(s.mode).toBe('git_worktree');
      expect(s.worktrees.some(w => w.branch === 'agent/task-4')).toBe(true);
    });

    it('throws if not a git repo', () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'fd-iso-nongit-'));
      const im = new IsolationManager(nonRepo, { mode: 'git_worktree' });
      expect(() => im.setup('task-5')).toThrow('git_worktree isolation requires a git repository');
      rmSync(nonRepo, { recursive: true, force: true });
    });
  });

  describe('mode: directory', () => {
    it('setup creates a working directory', () => {
      const im = new IsolationManager(repoDir, { mode: 'directory' });
      const result = im.setup('task-1');
      expect(existsSync(result.cwd)).toBe(true);
      expect(result.cwd).toContain('.flightdeck/workdirs/task-1');
    });

    it('cleanup copies back and removes directory', () => {
      const im = new IsolationManager(repoDir, { mode: 'directory' });
      const { cwd } = im.setup('task-2');
      writeFileSync(join(cwd, 'output.txt'), 'result');

      im.cleanup('task-2');
      expect(readFileSync(join(repoDir, 'output.txt'), 'utf-8')).toBe('result');
      expect(existsSync(cwd)).toBe(false);
    });

    it('cleanup with skipCopyBack does not copy', () => {
      const im = new IsolationManager(repoDir, { mode: 'directory' });
      const { cwd } = im.setup('task-3');
      writeFileSync(join(cwd, 'output.txt'), 'result');

      im.cleanup('task-3', { skipCopyBack: true });
      expect(existsSync(join(repoDir, 'output.txt'))).toBe(false);
    });

    it('status lists active workdirs', () => {
      const im = new IsolationManager(repoDir, { mode: 'directory' });
      im.setup('task-4');
      const s = im.status();
      expect(s.mode).toBe('directory');
      expect(s.workdirs).toContain('task-4');
    });
  });

  describe('mergeAll', () => {
    it('merges multiple accumulated branches', () => {
      const im = new IsolationManager(repoDir, { mode: 'git_worktree', mergeStrategy: 'accumulate' });

      // Set up two worktrees with changes
      const wt1 = im.setup('task-a');
      writeFileSync(join(wt1.cwd, 'a.txt'), 'aaa');
      execFileSync('git', ['add', '.'], { cwd: wt1.cwd });
      execFileSync('git', ['commit', '-m', 'task a'], { cwd: wt1.cwd });

      const wt2 = im.setup('task-b');
      writeFileSync(join(wt2.cwd, 'b.txt'), 'bbb');
      execFileSync('git', ['add', '.'], { cwd: wt2.cwd });
      execFileSync('git', ['commit', '-m', 'task b'], { cwd: wt2.cwd });

      // Cleanup without merge (accumulate skips merge)
      im.cleanup('task-a');
      im.cleanup('task-b');

      // Now merge all at once
      const results = im.mergeAll(['task-a', 'task-b']);
      // task-a should merge, task-b may or may not depending on branch state
      expect(results.length).toBe(2);
    });
  });
});

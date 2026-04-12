import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeManager } from '../../src/agents/WorktreeManager.js';
import { detectFileConflicts } from '../../src/agents/fileConflicts.js';

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fd-wt-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('WorktreeManager', () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoDir = createTempGitRepo();
    manager = new WorktreeManager(repoDir);
  });

  afterEach(() => {
    // Clean up all worktrees first
    try {
      const wts = manager.list();
      for (const wt of wts) {
        if (wt.branch.startsWith('agent/')) {
          const taskId = wt.branch.replace('agent/', '');
          manager.remove(taskId);
        }
      }
    } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('isGitRepo returns true for git repos', () => {
    expect(manager.isGitRepo()).toBe(true);
  });

  it('isGitRepo returns false for non-repos', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'fd-no-git-'));
    const mgr = new WorktreeManager(nonRepo);
    expect(mgr.isGitRepo()).toBe(false);
    rmSync(nonRepo, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a worktree with expected path and branch', () => {
      const result = manager.create('task-1');
      expect(result.branch).toBe('agent/task-1');
      expect(result.path).toContain('.flightdeck/worktrees/task-1');
      expect(existsSync(result.path)).toBe(true);
      expect(existsSync(join(result.path, 'README.md'))).toBe(true);
    });

    it('creates worktree from a specific base branch', () => {
      const result = manager.create('task-2', 'main');
      expect(result.branch).toBe('agent/task-2');
      expect(existsSync(result.path)).toBe(true);
    });
  });

  describe('remove', () => {
    it('removes an existing worktree and branch', () => {
      const result = manager.create('task-3');
      expect(existsSync(result.path)).toBe(true);

      manager.remove('task-3');
      expect(existsSync(result.path)).toBe(false);

      // Branch should also be gone
      const branches = execFileSync('git', ['branch', '--list', 'agent/task-3'], {
        cwd: repoDir, encoding: 'utf-8',
      }).trim();
      expect(branches).toBe('');
    });

    it('tolerates already-removed worktrees', () => {
      // Should not throw
      manager.remove('nonexistent-task');
    });
  });

  describe('list', () => {
    it('lists the main worktree by default', () => {
      const wts = manager.list();
      expect(wts.length).toBeGreaterThanOrEqual(1);
      expect(wts[0].path).toBe(repoDir);
    });

    it('lists created worktrees', () => {
      manager.create('task-list-1');
      manager.create('task-list-2');
      const wts = manager.list();
      const branches = wts.map(w => w.branch);
      expect(branches).toContain('agent/task-list-1');
      expect(branches).toContain('agent/task-list-2');
    });
  });

  describe('merge', () => {
    it('auto merge works when there are changes', () => {
      const wt = manager.create('task-merge-auto');
      // Make a change in the worktree
      writeFileSync(join(wt.path, 'new-file.txt'), 'hello\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path });
      execFileSync('git', ['commit', '-m', 'add file'], { cwd: wt.path });

      const result = manager.merge('task-merge-auto', 'auto');
      expect(result.merged).toBe(true);
      expect(result.strategy).toBe('auto');
      // File should now exist in main worktree
      expect(existsSync(join(repoDir, 'new-file.txt'))).toBe(true);
    });

    it('squash merge works', () => {
      const wt = manager.create('task-merge-squash');
      writeFileSync(join(wt.path, 'squash-file.txt'), 'squashed\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path });
      execFileSync('git', ['commit', '-m', 'commit 1'], { cwd: wt.path });

      const result = manager.merge('task-merge-squash', 'squash');
      expect(result.merged).toBe(true);
      expect(result.strategy).toBe('squash');
    });

    it('pr strategy returns branch without merging', () => {
      manager.create('task-merge-pr');
      const result = manager.merge('task-merge-pr', 'pr');
      expect(result.merged).toBe(false);
      expect(result.prBranch).toBe('agent/task-merge-pr');
    });
  });
});

describe('detectFileConflicts', () => {
  it('detects overlapping files between tasks', () => {
    const running = new Map<string, string[]>([
      ['task-a', ['src/index.ts', 'src/utils.ts']],
      ['task-b', ['src/utils.ts', 'src/other.ts']],
    ]);
    const conflicts = detectFileConflicts(running);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe('src/utils.ts');
    expect(conflicts[0].taskIds).toEqual(['task-a', 'task-b']);
  });

  it('returns empty when no conflicts', () => {
    const running = new Map<string, string[]>([
      ['task-a', ['src/a.ts']],
      ['task-b', ['src/b.ts']],
    ]);
    expect(detectFileConflicts(running)).toHaveLength(0);
  });

  it('normalizes backslashes', () => {
    const running = new Map<string, string[]>([
      ['task-a', ['src\\utils.ts']],
      ['task-b', ['src/utils.ts']],
    ]);
    const conflicts = detectFileConflicts(running);
    expect(conflicts).toHaveLength(1);
  });
});

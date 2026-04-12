import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  bare: boolean;
}

export interface MergeResult {
  strategy: 'auto' | 'squash' | 'pr';
  branch: string;
  merged: boolean;
  /** For 'pr' strategy, the branch name to create a PR from */
  prBranch?: string;
}

/**
 * Manages git worktrees for agent isolation (FR-013).
 * Each task gets its own worktree under `.flightdeck/worktrees/<taskId>/`.
 */
export class WorktreeManager {
  constructor(private projectRoot: string) {}

  /**
   * Check if the project root is a git repository.
   */
  isGitRepo(): boolean {
    try {
      this.git(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a worktree for a task.
   */
  create(taskId: string, baseBranch?: string): { path: string; branch: string } {
    const wtPath = this.worktreePath(taskId);
    const branch = `agent/${taskId}`;

    // If baseBranch specified, ensure we're branching from it
    const args = ['worktree', 'add', wtPath, '-b', branch];
    if (baseBranch) {
      args.push(baseBranch);
    }

    try {
      this.git(args);
    } catch (err) {
      const msg = String(err);
      // If branch already exists, try without -b
      if (msg.includes('already exists')) {
        // Clean up any stale worktree reference first
        try { this.git(['worktree', 'prune']); } catch { /* ignore */ }
        this.git(['worktree', 'add', wtPath, branch]);
      } else {
        throw err;
      }
    }

    return { path: wtPath, branch };
  }

  /**
   * Remove a worktree and its branch. Tolerates already-removed worktrees.
   */
  remove(taskId: string): void {
    const wtPath = this.worktreePath(taskId);
    const branch = `agent/${taskId}`;

    // Remove worktree
    try {
      this.git(['worktree', 'remove', wtPath, '--force']);
    } catch {
      // Already removed or doesn't exist — that's fine
    }

    // Prune stale worktree refs
    try {
      this.git(['worktree', 'prune']);
    } catch { /* ignore */ }

    // Delete branch
    try {
      this.git(['branch', '-D', branch]);
    } catch {
      // Branch may already be deleted
    }
  }

  /**
   * List all worktrees (parsed from `git worktree list --porcelain`).
   */
  list(): WorktreeInfo[] {
    let output: string;
    try {
      output = this.git(['worktree', 'list', '--porcelain']);
    } catch {
      return [];
    }

    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n').filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n');
      let path = '';
      let branch = '';
      let commit = '';
      let bare = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          path = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          commit = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          // refs/heads/agent/task-123 → agent/task-123
          branch = line.slice('branch '.length).replace('refs/heads/', '');
        } else if (line === 'bare') {
          bare = true;
        }
      }

      if (path) {
        worktrees.push({ path, branch, commit, bare });
      }
    }

    return worktrees;
  }

  /**
   * Merge a task's worktree branch back.
   */
  merge(taskId: string, strategy: 'auto' | 'squash' | 'pr'): MergeResult {
    const branch = `agent/${taskId}`;

    if (strategy === 'pr') {
      return { strategy, branch, merged: false, prBranch: branch };
    }

    try {
      if (strategy === 'squash') {
        this.git(['merge', '--squash', branch]);
        // Squash merge leaves changes staged but not committed
        try {
          this.git(['commit', '-m', `feat: merge task ${taskId} (squash)`]);
        } catch {
          // Nothing to commit (no changes)
        }
      } else {
        // auto
        this.git(['merge', branch, '-m', `Merge agent/${taskId}`]);
      }
      return { strategy, branch, merged: true };
    } catch (err) {
      // Merge conflict or other error
      try { this.git(['merge', '--abort']); } catch { /* ignore */ }
      throw new Error(`Merge failed for ${branch}: ${String(err)}`);
    }
  }

  /**
   * Get the worktree path for a task.
   */
  worktreePath(taskId: string): string {
    return resolve(this.projectRoot, '.flightdeck', 'worktrees', taskId);
  }

  /**
   * Run a git command in the project root.
   */
  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

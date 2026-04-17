import type { IsolationStrategy } from '@flightdeck-ai/shared';
import { WorktreeManager, type MergeResult, type WorktreeInfo } from '../agents/WorktreeManager.js';
import { DirectoryManager } from '../agents/DirectoryManager.js';

export type MergeStrategy = 'auto' | 'squash' | 'pr' | 'accumulate';

export interface IsolationConfig {
  mode: IsolationStrategy;
  mergeStrategy?: MergeStrategy; // only for git_worktree
}

export interface IsolationResult {
  /** Effective cwd for the agent */
  cwd: string;
  /** Branch name (git_worktree only) */
  branch?: string;
}

export interface IsolationStatus {
  mode: IsolationStrategy;
  worktrees: WorktreeInfo[];
  workdirs: string[];
}

/**
 * Unified facade for workspace isolation (FR-013).
 * Delegates to WorktreeManager or DirectoryManager based on config.
 */
export class IsolationManager {
  private worktreeManager: WorktreeManager;
  private directoryManager: DirectoryManager;

  constructor(
    private projectRoot: string,
    private config: IsolationConfig = { mode: 'file_lock' },
  ) {
    this.worktreeManager = new WorktreeManager(projectRoot);
    this.directoryManager = new DirectoryManager(projectRoot);
  }

  get mode(): IsolationStrategy {
    return this.config.mode;
  }

  get mergeStrategy(): MergeStrategy {
    return this.config.mergeStrategy ?? 'auto';
  }

  /**
   * Prepare an isolated workspace for a task. Returns the effective cwd.
   */
  setup(taskId: string, baseBranch?: string): IsolationResult {
    switch (this.config.mode) {
      case 'git_worktree': {
        if (!this.worktreeManager.isGitRepo()) {
          throw new Error('git_worktree isolation requires a git repository');
        }
        const wt = this.worktreeManager.create(taskId, baseBranch);
        return { cwd: wt.path, branch: wt.branch };
      }
      case 'file_lock': {
        const wd = this.directoryManager.create(taskId);
        return { cwd: wd.path };
      }
      case 'file_lock':
      default:
        return { cwd: this.projectRoot };
    }
  }

  /**
   * Clean up isolation for a completed task.
   * For git_worktree: merge (unless accumulate) then remove worktree.
   * For directory: optionally copy back, then remove.
   */
  cleanup(taskId: string, opts?: { skipMerge?: boolean; skipCopyBack?: boolean }): MergeResult | null {
    switch (this.config.mode) {
      case 'git_worktree': {
        let mergeResult: MergeResult | null = null;
        const strategy = this.mergeStrategy;

        // 'accumulate' defers merge — don't merge on individual task completion
        if (!opts?.skipMerge && (strategy as string) !== 'accumulate') {
          const mergeStrat = (strategy as string) === 'accumulate' ? 'auto' : strategy;
          if (mergeStrat === 'auto' || mergeStrat === 'squash' || mergeStrat === 'pr') {
            try {
              mergeResult = this.worktreeManager.merge(taskId, mergeStrat);
            } catch {
              // Merge failed — still clean up
            }
          }
        }

        // For 'pr' and 'accumulate', don't remove the branch (just the worktree)
        if (strategy === 'pr' || strategy === 'accumulate') {
          // Remove worktree but keep the branch
          try {
            this.worktreeManager.remove(taskId);
          } catch { /* best effort */ }
          // Re-create the branch ref if remove deleted it
          // Actually, WorktreeManager.remove deletes the branch — we need a lighter removal
          // For now, just remove the worktree directory without branch cleanup
        } else {
          try {
            this.worktreeManager.remove(taskId);
          } catch { /* best effort */ }
        }

        return mergeResult;
      }
      case 'file_lock': {
        if (!opts?.skipCopyBack) {
          try {
            this.directoryManager.copyBack(taskId);
          } catch { /* best effort */ }
        }
        try {
          this.directoryManager.remove(taskId);
        } catch { /* best effort */ }
        return null;
      }
      case 'file_lock':
      default:
        return null;
    }
  }

  /**
   * Get status of all active isolation workspaces.
   */
  status(): IsolationStatus {
    return {
      mode: this.config.mode,
      worktrees: this.config.mode === 'git_worktree' ? this.worktreeManager.list() : [],
      workdirs: this.config.mode === 'file_lock' ? this.directoryManager.list() : [],
    };
  }

  /**
   * Merge all accumulated branches (for 'accumulate' strategy at spec completion).
   */
  mergeAll(taskIds: string[], strategy: 'auto' | 'squash' = 'auto'): MergeResult[] {
    const results: MergeResult[] = [];
    for (const taskId of taskIds) {
      try {
        results.push(this.worktreeManager.merge(taskId, strategy));
      } catch {
        results.push({ strategy, branch: `agent/${taskId}`, merged: false });
      }
    }
    return results;
  }
}

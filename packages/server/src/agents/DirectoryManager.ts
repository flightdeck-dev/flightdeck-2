import { mkdirSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Manages directory-based isolation for agent tasks (FR-013b).
 * Each task gets its own subdirectory under `.flightdeck/workdirs/<taskId>/`.
 */
export class DirectoryManager {
  constructor(private projectRoot: string) {}

  /**
   * Create an isolated working directory for a task.
   * Creates `.flightdeck/workdirs/<taskId>/` and returns the path.
   */
  create(taskId: string): { path: string } {
    const dirPath = this.workdirPath(taskId);
    mkdirSync(dirPath, { recursive: true });
    return { path: dirPath };
  }

  /**
   * Copy results from a task's working directory back to the project root.
   * Skips `.flightdeck` and `node_modules` directories.
   */
  copyBack(taskId: string): void {
    const dirPath = this.workdirPath(taskId);
    if (!existsSync(dirPath)) return;

    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip internal directories
      if (entry.name === '.flightdeck' || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const src = join(dirPath, entry.name);
      const dest = join(this.projectRoot, entry.name);
      cpSync(src, dest, { recursive: true, force: true });
    }
  }

  /**
   * Remove a task's working directory.
   */
  remove(taskId: string): void {
    const dirPath = this.workdirPath(taskId);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  }

  /**
   * List all existing workdir task IDs.
   */
  list(): string[] {
    const baseDir = resolve(this.projectRoot, '.flightdeck', 'workdirs');
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  }

  /**
   * Get the working directory path for a task.
   */
  workdirPath(taskId: string): string {
    return resolve(this.projectRoot, '.flightdeck', 'workdirs', taskId);
  }
}

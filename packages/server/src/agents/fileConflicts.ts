/**
 * Lightweight file conflict detection for non-isolated tasks (FR-013).
 * Best-effort: only works when tasks declare their file paths.
 */

export interface FileConflict {
  file: string;
  taskIds: string[];
}

/**
 * Given a map of taskId → files that task touches, find overlapping files
 * among currently running tasks.
 */
export function detectFileConflicts(
  runningTaskFiles: Map<string, string[]>,
): FileConflict[] {
  const fileToTasks = new Map<string, string[]>();

  for (const [taskId, files] of runningTaskFiles) {
    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');
      const existing = fileToTasks.get(normalized) ?? [];
      existing.push(taskId);
      fileToTasks.set(normalized, existing);
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [file, taskIds] of fileToTasks) {
    if (taskIds.length > 1) {
      conflicts.push({ file, taskIds });
    }
  }

  return conflicts;
}

import { execFileSync } from 'node:child_process';

/**
 * Check if a command exists on PATH (cross-platform).
 * Uses `where` on Windows, `which` on Unix.
 */
export function commandExists(cmd: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checker, [cmd], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

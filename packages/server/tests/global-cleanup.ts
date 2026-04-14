/**
 * Vitest global cleanup: removes all test-* projects from ~/.flightdeck/projects/
 * after the test suite finishes. Prevents residual project accumulation from
 * crashed tests where afterEach didn't run.
 */
import { readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.flightdeck', 'v2', 'projects');

export function teardown(): void {
  if (!existsSync(PROJECTS_DIR)) return;

  const entries = readdirSync(PROJECTS_DIR);
  let cleaned = 0;

  for (const name of entries) {
    if (!name.startsWith('test-')) continue;
    const dir = join(PROJECTS_DIR, name);
    try {
      if (statSync(dir).isDirectory()) {
        rmSync(dir, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
      // ignore — already deleted or permission issue
    }
  }

  if (cleaned > 0) {
    console.log(`[global-cleanup] Removed ${cleaned} test project(s) from ${PROJECTS_DIR}`);
  }
}

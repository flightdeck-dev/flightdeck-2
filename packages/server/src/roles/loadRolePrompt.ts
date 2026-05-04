import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, 'defaults');

/**
 * Load a role prompt from the defaults directory.
 * Director and Scout are Lead facets (分身) — specialized projections of the Lead role.
 *
 * @returns The role prompt body (YAML frontmatter stripped), or empty string if not found.
 */
export function loadRolePrompt(role: string): string {
  try {
    const rolePath = join(DEFAULTS_DIR, `${role}.md`);
    if (!existsSync(rolePath)) return '';
    const raw = readFileSync(rolePath, 'utf-8');
    // Strip YAML frontmatter
    return raw.replace(/^---[\s\S]*?---\n*/, '');
  } catch {
    return '';
  }
}

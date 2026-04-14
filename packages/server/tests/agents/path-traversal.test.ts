import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Tests for the writeTextFile path traversal guard in AcpAdapter.
 *
 * The logic under test (from AcpAdapter.ts):
 *   const filePath = path.resolve(session.cwd, params.path);
 *   const rel = path.relative(session.cwd, filePath);
 *   if (rel.startsWith('..') || path.isAbsolute(rel)) { reject }
 *   const isAllowed = rel.startsWith('.flightdeck') || rel.startsWith('memory') || rel.endsWith('.md');
 */
function validateLeadWrite(cwd: string, requestPath: string): { allowed: boolean; reason?: string } {
  const filePath = path.resolve(cwd, requestPath);
  const rel = path.relative(cwd, filePath);

  // Path traversal check
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { allowed: false, reason: 'path resolves outside project directory' };
  }

  // Role-based restriction
  const isAllowed = rel.startsWith('.flightdeck') || rel.startsWith('memory') || rel.endsWith('.md');
  if (!isAllowed) {
    return { allowed: false, reason: 'not in allowed directories/extensions' };
  }

  return { allowed: true };
}

describe('writeTextFile path traversal guard', () => {
  const cwd = '/home/user/project';

  describe('allowed paths for lead role', () => {
    it('allows memory/notes.md', () => {
      expect(validateLeadWrite(cwd, 'memory/notes.md').allowed).toBe(true);
    });

    it('allows .flightdeck/config.md', () => {
      expect(validateLeadWrite(cwd, '.flightdeck/config.md').allowed).toBe(true);
    });

    it('allows README.md in project root', () => {
      expect(validateLeadWrite(cwd, 'README.md').allowed).toBe(true);
    });

    it('allows nested .md files', () => {
      expect(validateLeadWrite(cwd, 'docs/plan.md').allowed).toBe(true);
    });
  });

  describe('blocked: path traversal', () => {
    it('blocks ../../outside.md (traversal with .md extension)', () => {
      const result = validateLeadWrite(cwd, '../../outside.md');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });

    it('blocks ../sibling/file.md', () => {
      const result = validateLeadWrite(cwd, '../sibling/file.md');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });

    it('blocks absolute path /tmp/evil.md', () => {
      const result = validateLeadWrite(cwd, '/tmp/evil.md');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });

    it('blocks absolute path /etc/passwd', () => {
      const result = validateLeadWrite(cwd, '/etc/passwd');
      expect(result.allowed).toBe(false);
    });

    it('blocks sneaky traversal: memory/../../outside.md', () => {
      const result = validateLeadWrite(cwd, 'memory/../../outside.md');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });

    it('blocks .flightdeck/../../outside.md', () => {
      const result = validateLeadWrite(cwd, '.flightdeck/../../outside.md');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside');
    });
  });
});

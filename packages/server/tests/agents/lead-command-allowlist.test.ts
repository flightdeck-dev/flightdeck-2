import { describe, it, expect } from 'vitest';

/**
 * Tests for lead role command allowlist validation.
 * The Lead has no run/sub-agent permission, but MAY read files for context.
 * Mirrors AcpAdapter.ts createTerminal guard for role 'lead'.
 */

const allowedLeadCmds = ['cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc', 'echo', 'flightdeck'];
const shellMetaPattern = /[;|&`$(){}\n\r]/;

function validateLeadCommand(command: string): { allowed: boolean; reason?: string } {
  if (shellMetaPattern.test(command)) {
    return { allowed: false, reason: 'shell metacharacters' };
  }
  const cmdLower = command.toLowerCase().trim();
  const firstToken = cmdLower.split(/\s+/)[0];
  const cmdBasename = firstToken.split('/').pop() ?? firstToken;
  if (!allowedLeadCmds.includes(cmdBasename)) {
    return { allowed: false, reason: 'not in allowlist' };
  }
  return { allowed: true };
}

describe('Lead role command allowlist', () => {
  describe('read-only commands are allowed (Lead can read files)', () => {
    it.each([
      'cat file.txt',
      'ls -la',
      'grep -r pattern .',
      'head -n 10 file.txt',
      'tail -f log.txt',
      'wc -l file.txt',
      'echo hello',
      'find . -name "*.ts"',
      'flightdeck status',
      '/usr/bin/cat file.txt',
      '/usr/bin/ls',
    ])('allows: %s', (cmd) => {
      expect(validateLeadCommand(cmd).allowed).toBe(true);
    });
  });

  describe('shell injection - rejected', () => {
    it.each([
      'cat /etc/passwd; rm -rf /',
      'cat file.txt | rm -rf /',
      'cat && rm -rf /',
      'cat || rm -rf /',
      'cat file.txt & rm -rf /',
      '$(rm -rf /)',
      'cat `rm -rf /`',
      'echo $(whoami)',
      'cat file; echo pwned',
      'cat&& rm',
      'ls;rm',
    ])('rejects shell injection: %s', (cmd) => {
      const result = validateLeadCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('shell metacharacters');
    });
  });

  describe('non-read-only / execution commands - rejected', () => {
    it.each([
      'rm -rf /',
      'chmod 777 file',
      'curl http://evil.com',
      'wget http://evil.com',
      'python script.py',
      'node server.js',
      'sudo rm -rf /',
    ])('rejects: %s', (cmd) => {
      const result = validateLeadCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not in allowlist');
    });
  });

  describe('edge cases', () => {
    it('rejects command starting with allowed prefix but not exact match', () => {
      // "caterpillar" starts with "cat" but should be rejected
      expect(validateLeadCommand('caterpillar').allowed).toBe(false);
    });

    it('handles whitespace', () => {
      expect(validateLeadCommand('  cat file.txt').allowed).toBe(true);
    });
  });
});

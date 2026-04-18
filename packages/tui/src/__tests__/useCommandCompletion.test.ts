import { describe, it, expect } from 'vitest';

// Test the pure logic extracted from useCommandCompletion
const COMMANDS = [
  { cmd: '/help', desc: 'Show all commands' },
  { cmd: '/quit', desc: 'Exit' },
  { cmd: '/hibernate', desc: 'Hibernate agent' },
  { cmd: '/history', desc: 'Show history' },
];

function getSuggestions(input: string, commands = COMMANDS) {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  return commands.filter(c => c.cmd.startsWith(input));
}

describe('command completion logic', () => {
  it('returns all commands for /', () => {
    expect(getSuggestions('/')).toHaveLength(COMMANDS.length);
  });

  it('filters by prefix', () => {
    const result = getSuggestions('/hi');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.cmd)).toEqual(['/hibernate', '/history']);
  });

  it('returns empty for non-slash input', () => {
    expect(getSuggestions('hello')).toEqual([]);
  });

  it('returns empty when input has space', () => {
    expect(getSuggestions('/help foo')).toEqual([]);
  });

  it('returns exact match', () => {
    const result = getSuggestions('/quit');
    expect(result).toHaveLength(1);
    expect(result[0].cmd).toBe('/quit');
  });
});

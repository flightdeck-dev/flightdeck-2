import { describe, it, expect } from 'vitest';
import { taskId, specId, agentId, decisionId, messageId } from '@flightdeck-ai/shared';

describe('ID Generation', () => {
  it('generates deterministic IDs', () => {
    const id1 = taskId('hello', 'world');
    const id2 = taskId('hello', 'world');
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different inputs', () => {
    const id1 = taskId('hello');
    const id2 = taskId('world');
    expect(id1).not.toBe(id2);
  });

  it('uses correct prefixes', () => {
    expect(taskId('a').startsWith('task-')).toBe(true);
    expect(specId('a').startsWith('spec-')).toBe(true);
    expect(agentId('a').startsWith('agent-')).toBe(true);
    expect(decisionId('a').startsWith('dec-')).toBe(true);
    expect(messageId('a').startsWith('msg-')).toBe(true);
  });
});

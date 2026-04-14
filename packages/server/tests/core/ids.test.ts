import { describe, it, expect } from 'vitest';
import { taskId, specId, agentId, decisionId, messageId } from '@flightdeck-ai/shared';

describe('ID Generation', () => {
  it('generates deterministic IDs for tasks/specs/decisions', () => {
    expect(taskId('hello', 'world')).toBe(taskId('hello', 'world'));
    expect(specId('a', 'b')).toBe(specId('a', 'b'));
    expect(decisionId('x')).toBe(decisionId('x'));
  });

  it('generates unique IDs for agents and messages (random nonce)', () => {
    const a1 = agentId('worker', 'same');
    const a2 = agentId('worker', 'same');
    expect(a1).not.toBe(a2); // Different due to random nonce

    const m1 = messageId('same');
    const m2 = messageId('same');
    expect(m1).not.toBe(m2);
  });

  it('generates different IDs for different inputs', () => {
    expect(taskId('hello')).not.toBe(taskId('world'));
  });

  it('uses correct prefixes', () => {
    expect(taskId('a').startsWith('task-')).toBe(true);
    expect(specId('a').startsWith('spec-')).toBe(true);
    expect(agentId('worker', 'a').startsWith('worker-')).toBe(true);
    expect(decisionId('a').startsWith('dec-')).toBe(true);
    expect(messageId('a').startsWith('msg-')).toBe(true);
  });
});

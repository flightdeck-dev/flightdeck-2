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

  it('never collides for agents spawned in a tight loop (same role, same timestamp)', () => {
    // Guards the entropy in agentId — coarse Date.now() resolution (notably
    // on Windows) must not produce duplicate agents.id values.
    const now = Date.now().toString();
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(agentId('worker', now));
    expect(ids.size).toBe(5000);
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

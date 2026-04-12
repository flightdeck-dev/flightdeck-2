import { describe, it, expect } from 'vitest';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import type { Decision, ProjectConfig, TaskId, AgentId, DecisionId } from '../../src/core/types.js';

function makeConfig(profile: ProjectConfig['governance']): ProjectConfig {
  return {
    name: 'test',
    governance: profile,
    isolation: 'none',
    onCompletion: 'stop',
    costThresholdPerDay: 50,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-test' as DecisionId,
    taskId: 'task-1' as TaskId,
    agentId: 'agent-1' as AgentId,
    type: 'implementation',
    title: 'Test decision',
    reasoning: 'Because',
    alternatives: ['Other'],
    confidence: 0.9,
    reversible: true,
    timestamp: new Date().toISOString(),
    status: 'pending_review',
    ...overrides,
  };
}

describe('GovernanceEngine', () => {
  it('auto-approves high-confidence reversible decisions in autonomous mode', () => {
    const engine = new GovernanceEngine(makeConfig('autonomous'));
    const result = engine.evaluateDecision(makeDecision({ confidence: 0.9, reversible: true }));
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('approve');
  });

  it('gates low-confidence decisions in autonomous mode', () => {
    const engine = new GovernanceEngine(makeConfig('autonomous'));
    const result = engine.evaluateDecision(makeDecision({ confidence: 0.3 }));
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('gate');
  });

  it('gates architecture decisions in collaborative mode', () => {
    const engine = new GovernanceEngine(makeConfig('collaborative'));
    const result = engine.evaluateDecision(makeDecision({ type: 'architecture' }));
    expect(result.allowed).toBe(false);
  });

  it('gates everything in supervised mode', () => {
    const engine = new GovernanceEngine(makeConfig('supervised'));
    const result = engine.evaluateDecision(makeDecision());
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('gate');
  });

  it('blocks when cost threshold exceeded', () => {
    const engine = new GovernanceEngine(makeConfig('autonomous'));
    const result = engine.checkCostThreshold(55);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('block');
  });

  it('warns when approaching cost threshold', () => {
    const engine = new GovernanceEngine(makeConfig('autonomous'));
    const result = engine.checkCostThreshold(42);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('log');
  });
});

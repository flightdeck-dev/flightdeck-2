import { describe, it, expect } from 'vitest';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import type { Decision, ProjectConfig, TaskId, AgentId, DecisionId } from '@flightdeck-ai/shared';

function makeConfig(profile: ProjectConfig['governance']): ProjectConfig {
  return {
    name: 'test',
    governance: profile,
    isolation: 'file_lock',
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

  // New tests for profile defaults
  describe('profileDefaults', () => {
    it('returns autonomous profile with correct gates', () => {
      const config = GovernanceEngine.profileDefaults('autonomous');
      expect(config.profile).toBe('autonomous');
      expect(config.approvalGates).toHaveLength(2);
      expect(config.approvalGates.map(g => g.trigger)).toContain('public_api_change');
      expect(config.approvalGates.map(g => g.trigger)).toContain('security_sensitive');
      expect(config.escalation.consecutiveFailures).toBe(5);
      expect(config.escalation.costThresholdPerDay).toBe(50);
      expect(config.onCompletion).toBe('explore');
    });

    it('returns collaborative profile with propose_and_wait for implementation_start', () => {
      const config = GovernanceEngine.profileDefaults('collaborative');
      expect(config.profile).toBe('collaborative');
      const implGate = config.approvalGates.find(g => g.trigger === 'implementation_start');
      expect(implGate?.action).toBe('propose_and_wait');
      expect(config.escalation.consecutiveFailures).toBe(2);
      expect(config.escalation.costThresholdPerDay).toBe(10);
    });

    it('returns supervised profile that gates everything', () => {
      const config = GovernanceEngine.profileDefaults('supervised');
      expect(config.profile).toBe('supervised');
      expect(config.approvalGates.length).toBeGreaterThanOrEqual(5);
      expect(config.escalation.consecutiveFailures).toBe(1);
      expect(config.onCompletion).toBe('stop');
    });

    it('returns custom profile with empty gates', () => {
      const config = GovernanceEngine.profileDefaults('custom');
      expect(config.profile).toBe('custom');
      expect(config.approvalGates).toHaveLength(0);
    });
  });

  // Gate checking
  describe('checkGate', () => {
    it('approves unknown actions', () => {
      const engine = new GovernanceEngine(makeConfig('autonomous'));
      const result = engine.checkGate('random_action');
      expect(result.allowed).toBe(true);
      expect(result.action).toBe('approve');
    });

    it('gates public_api_change in autonomous mode', () => {
      const engine = new GovernanceEngine(makeConfig('autonomous'));
      const result = engine.checkGate('public_api_change');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('gate_human');
    });

    it('propose_and_wait for implementation_start in collaborative mode', () => {
      const engine = new GovernanceEngine(makeConfig('collaborative'));
      const result = engine.checkGate('implementation_start');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('propose_and_wait');
    });

    it('blocks cost_exceeds in supervised mode', () => {
      const engine = new GovernanceEngine(makeConfig('supervised'));
      const result = engine.checkGate('cost_exceeds');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('block');
    });
  });

  // Escalation
  describe('checkEscalation', () => {
    it('escalates when failure count exceeds threshold', () => {
      const engine = new GovernanceEngine(makeConfig('autonomous'));
      const result = engine.checkEscalation('task-1', 5, 10);
      expect(result.escalate).toBe(true);
      expect(result.reason).toContain('5 consecutive failures');
    });

    it('escalates when cost exceeds threshold', () => {
      const engine = new GovernanceEngine(makeConfig('autonomous'));
      const result = engine.checkEscalation('task-1', 1, 60);
      expect(result.escalate).toBe(true);
      expect(result.reason).toContain('cost');
    });

    it('does not escalate when within thresholds', () => {
      const engine = new GovernanceEngine(makeConfig('autonomous'));
      const result = engine.checkEscalation('task-1', 2, 10);
      expect(result.escalate).toBe(false);
    });

    it('supervised mode escalates on first failure', () => {
      const engine = new GovernanceEngine(makeConfig('supervised'));
      const result = engine.checkEscalation('task-1', 1, 0);
      expect(result.escalate).toBe(true);
    });
  });
});

import type { GovernanceProfile, Decision, TaskState, ProjectConfig } from '@flightdeck-ai/shared';

export interface PolicyResult {
  allowed: boolean;
  action: 'approve' | 'gate' | 'block' | 'log';
  reason?: string;
}

export class GovernanceEngine {
  constructor(private config: ProjectConfig) {}

  evaluateDecision(decision: Decision): PolicyResult {
    const profile = this.config.governance;

    if (profile === 'autonomous') {
      // Auto-approve high-confidence, reversible decisions
      if (decision.confidence >= 0.8 && decision.reversible) {
        return { allowed: true, action: 'approve' };
      }
      // Gate on low-confidence or irreversible
      if (decision.confidence < 0.5 || !decision.reversible) {
        return { allowed: false, action: 'gate', reason: 'Low confidence or irreversible decision requires review' };
      }
      return { allowed: true, action: 'log' };
    }

    if (profile === 'collaborative') {
      // Gate on architecture and API decisions
      if (decision.type === 'architecture' || decision.type === 'api_design') {
        return { allowed: false, action: 'gate', reason: `${decision.type} decisions require approval in collaborative mode` };
      }
      return { allowed: true, action: 'log' };
    }

    if (profile === 'supervised') {
      // Gate on everything
      return { allowed: false, action: 'gate', reason: 'All decisions require approval in supervised mode' };
    }

    // custom — allow by default
    return { allowed: true, action: 'log' };
  }

  shouldGateTaskStart(taskState: TaskState, taskRole?: string): boolean {
    if (this.config.governance === 'autonomous') return false;
    if (this.config.governance === 'supervised') {
      // Supervised lets trivial tasks through (reviewer role tasks are trivial)
      if (taskRole === 'reviewer') return false;
      return true;
    }
    if (this.config.governance === 'collaborative') return true;
    // custom — check costThresholdPerDay as a proxy for gate strictness
    return false;
  }

  checkCostThreshold(currentCost: number): PolicyResult {
    const threshold = this.config.costThresholdPerDay;
    if (!threshold) return { allowed: true, action: 'approve' };
    if (currentCost >= threshold) {
      return { allowed: false, action: 'block', reason: `Daily cost threshold exceeded: $${currentCost.toFixed(2)} >= $${threshold}` };
    }
    if (currentCost >= threshold * 0.8) {
      return { allowed: true, action: 'log', reason: `Approaching cost threshold: $${currentCost.toFixed(2)} / $${threshold}` };
    }
    return { allowed: true, action: 'approve' };
  }

  updateConfig(config: ProjectConfig): void {
    this.config = config;
  }
}

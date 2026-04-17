import type { GovernanceProfile, Decision, TaskState, ProjectConfig } from '@flightdeck-ai/shared';
import type { SqliteStore } from '../storage/SqliteStore.js';

export interface ApprovalGate {
  trigger: string; // 'architecture_change' | 'dependency_upgrade' | 'public_api_change' | etc
  action: 'gate_human' | 'propose_and_wait' | 'log_and_continue' | 'block';
  threshold?: number;
}

export interface EscalationConfig {
  consecutiveFailures: number;
  costThresholdPerDay: number;
  uncertaintyThreshold: number;
  staleTaskTimeout: string; // e.g. '2h'
}

export interface ReportingConfig {
  cadence: 'per_task' | 'per_milestone' | 'hourly' | 'daily' | 'on_demand';
}

export interface VerificationConfig {
  /** Whether to spawn a fresh reviewer on retry (vs reusing the same one). */
  freshReviewerOnRetry: boolean;
  /** Additional automated checks to run alongside reviewer. */
  additionalChecks: string[];
}

export interface GovernanceConfig {
  profile: GovernanceProfile;
  approvalGates: ApprovalGate[];
  escalation: EscalationConfig;
  reporting: ReportingConfig;
  onCompletion: 'explore' | 'stop' | 'ask';
  verification: VerificationConfig;
}

export interface GateResult {
  allowed: boolean;
  action: 'gate_human' | 'propose_and_wait' | 'log_and_continue' | 'block' | 'approve';
  reason?: string;
  gate?: ApprovalGate;
}

export interface EscalationResult {
  escalate: boolean;
  reason?: string;
}

export interface PolicyResult {
  allowed: boolean;
  action: 'approve' | 'gate' | 'block' | 'log';
  reason?: string;
}

export class GovernanceEngine {
  private _config: ProjectConfig;
  private _governanceConfig: GovernanceConfig;

  constructor(config: ProjectConfig, private sqlite?: SqliteStore) {
    this._config = config;
    this._governanceConfig = GovernanceEngine.profileDefaults(config.governance);
  }

  get governanceConfig(): GovernanceConfig {
    return this._governanceConfig;
  }

  /** Hot-reload governance profile at runtime. */
  setProfile(profile: GovernanceProfile): void {
    this._config.governance = profile;
    this._governanceConfig = GovernanceEngine.profileDefaults(profile);
  }

  // ── Legacy API (backward compat) ──

  evaluateDecision(decision: Decision): PolicyResult {
    const profile = this._config.governance;

    if (profile === 'autonomous') {
      if (decision.confidence >= 0.8 && decision.reversible) {
        return { allowed: true, action: 'approve' };
      }
      if (decision.confidence < 0.5 || !decision.reversible) {
        return { allowed: false, action: 'gate', reason: 'Low confidence or irreversible decision requires review' };
      }
      return { allowed: true, action: 'log' };
    }

    if (profile === 'collaborative') {
      if (decision.type === 'architecture' || decision.type === 'api_design') {
        return { allowed: false, action: 'gate', reason: `${decision.type} decisions require approval in collaborative mode` };
      }
      return { allowed: true, action: 'log' };
    }

    if (profile === 'supervised') {
      return { allowed: false, action: 'gate', reason: 'All decisions require approval in supervised mode' };
    }

    return { allowed: true, action: 'log' };
  }

  shouldGateTaskStart(taskState: TaskState, taskRole?: string): boolean {
    if (this._config.governance === 'autonomous') return false;
    if (this._config.governance === 'supervised') {
      if (taskRole === 'reviewer') return false;
      return true;
    }
    if (this._config.governance === 'collaborative') return true;
    return false;
  }

  /** Whether the Lead should auto-approve plans without asking the user. */
  shouldAutoApprovePlan(): boolean {
    return this._config.governance === 'autonomous';
  }

  checkCostThreshold(currentCost: number): PolicyResult {
    const threshold = this._config.costThresholdPerDay;
    if (!threshold) return { allowed: true, action: 'approve' };
    if (currentCost >= threshold) {
      return { allowed: false, action: 'block', reason: `Daily cost threshold exceeded: $${currentCost.toFixed(2)} >= $${threshold}` };
    }
    if (currentCost >= threshold * 0.8) {
      return { allowed: true, action: 'log', reason: `Approaching cost threshold: $${currentCost.toFixed(2)} / $${threshold}` };
    }
    return { allowed: true, action: 'approve' };
  }

  // ── New Governance API ──

  checkGate(action: string, _context?: Record<string, unknown>): GateResult {
    const gate = this._governanceConfig.approvalGates.find(g => g.trigger === action);
    if (!gate) {
      return { allowed: true, action: 'approve' };
    }
    switch (gate.action) {
      case 'log_and_continue':
        return { allowed: true, action: 'log_and_continue', gate };
      case 'gate_human':
        return { allowed: false, action: 'gate_human', reason: `Action '${action}' requires human approval`, gate };
      case 'propose_and_wait':
        return { allowed: false, action: 'propose_and_wait', reason: `Action '${action}' proposed — waiting for approval`, gate };
      case 'block':
        return { allowed: false, action: 'block', reason: `Action '${action}' is blocked by governance policy`, gate };
      default:
        return { allowed: true, action: 'approve' };
    }
  }

  checkEscalation(taskId: string, failureCount: number, cost: number): EscalationResult {
    const esc = this._governanceConfig.escalation;
    if (failureCount >= esc.consecutiveFailures) {
      return { escalate: true, reason: `Task ${taskId} has ${failureCount} consecutive failures (threshold: ${esc.consecutiveFailures})` };
    }
    if (cost >= esc.costThresholdPerDay) {
      return { escalate: true, reason: `Daily cost $${cost.toFixed(2)} exceeds threshold $${esc.costThresholdPerDay}` };
    }
    return { escalate: false };
  }

  recordDecision(decision: Decision): void {
    // Evaluate the decision against governance rules to set status
    const result = this.evaluateDecision(decision);
    if (result.allowed && result.action === 'approve') {
      decision.status = 'auto_approved';
    } else if (!result.allowed) {
      decision.status = 'pending_review';
    }
    // Store in sqlite if available (decisions table or via JSONL handled externally)
  }

  getPendingDecisions(): Decision[] {
    // This would query from a store; stub returns empty
    return [];
  }

  updateConfig(config: ProjectConfig): void {
    this._config = config;
    this._governanceConfig = GovernanceEngine.profileDefaults(config.governance);
  }

  setGovernanceConfig(gc: GovernanceConfig): void {
    this._governanceConfig = gc;
  }

  // ── Profile Defaults ──

  static profileDefaults(profile: string): GovernanceConfig {
    switch (profile) {
      case 'autonomous':
        return {
          profile: 'autonomous',
          approvalGates: [
            { trigger: 'public_api_change', action: 'gate_human' },
            { trigger: 'security_sensitive', action: 'gate_human' },
          ],
          escalation: {
            consecutiveFailures: 5,
            costThresholdPerDay: 50,
            uncertaintyThreshold: 0.3,
            staleTaskTimeout: '4h',
          },
          reporting: { cadence: 'daily' },
          onCompletion: 'explore',
          verification: {
            freshReviewerOnRetry: true,
            additionalChecks: [],
          },
        };
      case 'collaborative':
        return {
          profile: 'collaborative',
          approvalGates: [
            { trigger: 'implementation_start', action: 'propose_and_wait' },
            { trigger: 'architecture_change', action: 'gate_human' },
            { trigger: 'dependency_upgrade', action: 'gate_human' },
            { trigger: 'public_api_change', action: 'gate_human' },
          ],
          escalation: {
            consecutiveFailures: 2,
            costThresholdPerDay: 10,
            uncertaintyThreshold: 0.5,
            staleTaskTimeout: '1h',
          },
          reporting: { cadence: 'per_milestone' },
          onCompletion: 'ask',
          verification: {
            freshReviewerOnRetry: true,
            additionalChecks: [],
          },
        };
      case 'supervised':
        return {
          profile: 'supervised',
          approvalGates: [
            { trigger: 'implementation_start', action: 'gate_human' },
            { trigger: 'architecture_change', action: 'gate_human' },
            { trigger: 'dependency_upgrade', action: 'gate_human' },
            { trigger: 'public_api_change', action: 'gate_human' },
            { trigger: 'security_sensitive', action: 'gate_human' },
            { trigger: 'cost_exceeds', action: 'block', threshold: 5 },
          ],
          escalation: {
            consecutiveFailures: 1,
            costThresholdPerDay: 5,
            uncertaintyThreshold: 0.7,
            staleTaskTimeout: '30m',
          },
          reporting: { cadence: 'per_task' },
          onCompletion: 'stop',
          verification: {
            freshReviewerOnRetry: true,
            additionalChecks: [],
          },
        };
      case 'custom':
      default:
        return {
          profile: 'custom',
          approvalGates: [],
          escalation: {
            consecutiveFailures: 3,
            costThresholdPerDay: 25,
            uncertaintyThreshold: 0.5,
            staleTaskTimeout: '2h',
          },
          reporting: { cadence: 'daily' },
          onCompletion: 'ask',
          verification: {
            freshReviewerOnRetry: true,
            additionalChecks: [],
          },
        };
    }
  }
}

// Verification & Trust Module
// Inspired by: Ry Walker's research (trust & verification is THE core problem),
// beads (gate primitives for async coordination)
//
// Key insights:
// 1. Agents self-certify success even when broken → cross-model review
// 2. No path from FAIL to COMMIT without human/reviewer approval → blocking quality gates
// 3. Orchestrator runs tests directly, never asks "did tests pass?" → independent validation
// 4. Fresh reviewer on retry to prevent anchoring bias

import {
  type TaskId, type AgentId, type RoleId, type GateId,
  gateId,
} from '../core/types.js';

export type ReviewVerdict = 'approved' | 'rejected' | 'needs_changes';

export interface ReviewRequest {
  id: string;
  taskId: TaskId;
  writerAgent: AgentId;
  writerModel: string;
  reviewerAgent?: AgentId;
  reviewerModel?: string;
  verdict?: ReviewVerdict;
  comments: string[];
  createdAt: Date;
  completedAt?: Date;
  attempt: number; // Track retry attempts for fresh reviewer rule
}

export interface QualityGate {
  id: GateId;
  taskId: TaskId;
  type: 'review' | 'ci' | 'human_approval' | 'test_suite';
  required: boolean; // Blocking gate
  passed: boolean;
  evidence?: string; // What was checked and result
  checkedBy?: AgentId;
  checkedAt?: Date;
}

export interface ValidationResult {
  taskId: TaskId;
  passed: boolean;
  evidence: string;
  validatedBy: 'orchestrator'; // Never by the agent that did the work
  timestamp: Date;
}

export class VerificationEngine {
  private reviews: Map<string, ReviewRequest> = new Map();
  private gates: Map<string, QualityGate[]> = new Map(); // taskId → gates
  private validations: Map<string, ValidationResult[]> = new Map();

  // Model blacklist for cross-model review: writerModel → reviewer can't use same model
  private modelDiversity: boolean = true;

  /**
   * Request a review for a task.
   * Rule: writer agent ≠ reviewer agent, different models when possible.
   */
  requestReview(input: {
    taskId: TaskId;
    writerAgent: AgentId;
    writerModel: string;
    attempt?: number;
  }): ReviewRequest {
    const review: ReviewRequest = {
      id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: input.taskId,
      writerAgent: input.writerAgent,
      writerModel: input.writerModel,
      comments: [],
      createdAt: new Date(),
      attempt: input.attempt ?? 1,
    };

    this.reviews.set(review.id, review);
    return review;
  }

  /**
   * Assign a reviewer to a review request.
   * Enforces cross-model rule: reviewer model ≠ writer model.
   * Enforces fresh reviewer rule: on retry, must be different agent than previous reviewer.
   */
  assignReviewer(
    reviewId: string,
    reviewerAgent: AgentId,
    reviewerModel: string,
  ): { ok: true } | { error: string } {
    const review = this.reviews.get(reviewId);
    if (!review) return { error: 'Review not found' };

    // Cross-model rule
    if (this.modelDiversity && reviewerModel === review.writerModel) {
      return { error: `Cross-model rule: reviewer model '${reviewerModel}' must differ from writer model '${review.writerModel}'` };
    }

    // Fresh reviewer rule: if retrying, find previous reviews for same task
    if (review.attempt > 1) {
      const previousReviews = Array.from(this.reviews.values()).filter(
        r => r.taskId === review.taskId && r.id !== reviewId && r.reviewerAgent,
      );
      if (previousReviews.some(r => r.reviewerAgent === reviewerAgent)) {
        return { error: 'Fresh reviewer rule: on retry, must use a different reviewer agent' };
      }
    }

    // Same agent can't review their own work
    if (reviewerAgent === review.writerAgent) {
      return { error: 'Self-review not allowed' };
    }

    review.reviewerAgent = reviewerAgent;
    review.reviewerModel = reviewerModel;
    return { ok: true };
  }

  submitVerdict(reviewId: string, verdict: ReviewVerdict, comments: string[]): ReviewRequest | { error: string } {
    const review = this.reviews.get(reviewId);
    if (!review) return { error: 'Review not found' };
    if (!review.reviewerAgent) return { error: 'No reviewer assigned' };

    review.verdict = verdict;
    review.comments = comments;
    review.completedAt = new Date();
    return review;
  }

  // ---- Quality Gates ----

  /**
   * Add a blocking quality gate to a task.
   * No path from FAIL to COMMIT without clearing all required gates.
   */
  addGate(taskId: TaskId, type: QualityGate['type'], required: boolean = true): QualityGate {
    const gate: QualityGate = {
      id: gateId(),
      taskId,
      type,
      required,
      passed: false,
    };

    const key = taskId as string;
    if (!this.gates.has(key)) {
      this.gates.set(key, []);
    }
    this.gates.get(key)!.push(gate);
    return gate;
  }

  /**
   * Check if all required gates for a task are passed.
   * This is what prevents FAIL → COMMIT without proper review.
   */
  canCommit(taskId: TaskId): { allowed: boolean; blockers: QualityGate[] } {
    const gates = this.gates.get(taskId as string) ?? [];
    const blockers = gates.filter(g => g.required && !g.passed);
    return { allowed: blockers.length === 0, blockers };
  }

  passGate(gateId: GateId, evidence: string, checkedBy?: AgentId): boolean {
    for (const gates of this.gates.values()) {
      const gate = gates.find(g => g.id === gateId);
      if (gate) {
        gate.passed = true;
        gate.evidence = evidence;
        gate.checkedBy = checkedBy;
        gate.checkedAt = new Date();
        return true;
      }
    }
    return false;
  }

  // ---- Independent Validation ----

  /**
   * Record validation result. Key rule: orchestrator runs tests directly,
   * never trusts agent self-report.
   */
  recordValidation(taskId: TaskId, passed: boolean, evidence: string): ValidationResult {
    const result: ValidationResult = {
      taskId,
      passed,
      evidence,
      validatedBy: 'orchestrator',
      timestamp: new Date(),
    };

    const key = taskId as string;
    if (!this.validations.has(key)) {
      this.validations.set(key, []);
    }
    this.validations.get(key)!.push(result);
    return result;
  }

  getReview(id: string): ReviewRequest | undefined {
    return this.reviews.get(id);
  }

  getReviewsForTask(taskId: TaskId): ReviewRequest[] {
    return Array.from(this.reviews.values()).filter(r => r.taskId === taskId);
  }

  getGatesForTask(taskId: TaskId): QualityGate[] {
    return this.gates.get(taskId as string) ?? [];
  }

  getValidationsForTask(taskId: TaskId): ValidationResult[] {
    return this.validations.get(taskId as string) ?? [];
  }

  setModelDiversity(enabled: boolean): void {
    this.modelDiversity = enabled;
  }
}

// Spec & Plan Layer
// Inspired by: OpenSpec (spec/change separation), spec-kit (template structure),
// sudocode (spec↔issue dual layer)

import {
  type Spec, type SpecId, type Change, type ChangeId, type ChangeStatus,
  type Plan, type PlanId, type Task, type TaskId, type Requirement,
  type UserScenario,
  specId, changeId, planId,
} from '../core/types.js';
import type { TaskDAG, TaskInput } from '../dag/TaskDAG.js';

export class SpecStore {
  private specs: Map<SpecId, Spec> = new Map();
  private changes: Map<ChangeId, Change> = new Map();
  private plans: Map<PlanId, Plan> = new Map();

  createSpec(input: { title: string; requirements: Requirement[]; userScenarios?: UserScenario[] }): Spec {
    const id = specId();
    const now = new Date();
    const spec: Spec = {
      id,
      title: input.title,
      requirements: input.requirements,
      userScenarios: input.userScenarios ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.specs.set(id, spec);
    return spec;
  }

  getSpec(id: SpecId): Spec | undefined {
    return this.specs.get(id);
  }

  /**
   * Propose a change to a spec (from OpenSpec: don't modify specs directly).
   * Changes go through review → merge flow.
   */
  proposeChange(specIdVal: SpecId, input: {
    title: string;
    description: string;
    diff: Partial<Pick<Spec, 'title' | 'requirements' | 'userScenarios'>>;
  }): Change | { error: string } {
    const spec = this.specs.get(specIdVal);
    if (!spec) return { error: 'Spec not found' };

    const id = changeId();
    const now = new Date();
    const change: Change = {
      id,
      specId: specIdVal,
      title: input.title,
      description: input.description,
      status: 'proposed',
      diff: input.diff,
      createdAt: now,
      updatedAt: now,
    };
    this.changes.set(id, change);
    return change;
  }

  approveChange(id: ChangeId): Change | { error: string } {
    const change = this.changes.get(id);
    if (!change) return { error: 'Change not found' };
    if (change.status !== 'proposed') return { error: `Cannot approve change in '${change.status}' state` };
    change.status = 'approved';
    change.updatedAt = new Date();
    return change;
  }

  rejectChange(id: ChangeId): Change | { error: string } {
    const change = this.changes.get(id);
    if (!change) return { error: 'Change not found' };
    if (change.status !== 'proposed') return { error: `Cannot reject change in '${change.status}' state` };
    change.status = 'rejected';
    change.updatedAt = new Date();
    return change;
  }

  /**
   * Merge an approved change back into the spec.
   * Returns IDs of requirements that were modified (for staleness tracking).
   */
  mergeChange(id: ChangeId): { affectedRequirementIds: string[] } | { error: string } {
    const change = this.changes.get(id);
    if (!change) return { error: 'Change not found' };
    if (change.status !== 'approved') return { error: 'Change must be approved before merging' };

    const spec = this.specs.get(change.specId);
    if (!spec) return { error: 'Spec not found' };

    const affectedRequirementIds: string[] = [];

    if (change.diff.title !== undefined) {
      spec.title = change.diff.title;
    }
    if (change.diff.requirements !== undefined) {
      // Track which requirements changed
      const oldIds = new Set(spec.requirements.map(r => r.id));
      const newIds = new Set(change.diff.requirements.map(r => r.id));

      // Modified = exists in both but might have changed
      for (const req of change.diff.requirements) {
        if (oldIds.has(req.id)) {
          const old = spec.requirements.find(r => r.id === req.id);
          if (old && (old.description !== req.description || JSON.stringify(old.acceptanceCriteria) !== JSON.stringify(req.acceptanceCriteria))) {
            affectedRequirementIds.push(req.id);
          }
        }
      }
      // Removed requirements affect their tasks too
      for (const id of oldIds) {
        if (!newIds.has(id)) affectedRequirementIds.push(id);
      }

      spec.requirements = change.diff.requirements;
    }
    if (change.diff.userScenarios !== undefined) {
      spec.userScenarios = change.diff.userScenarios;
    }

    spec.updatedAt = new Date();
    change.status = 'merged';
    change.updatedAt = new Date();

    return { affectedRequirementIds };
  }

  /**
   * Create a plan from a spec, generating task inputs mapped to requirements.
   */
  createPlan(specIdVal: SpecId, title: string, taskMapping: Array<{
    requirementId: string;
    tasks: TaskInput[];
  }>, dag: TaskDAG): Plan | { error: string } {
    const spec = this.specs.get(specIdVal);
    if (!spec) return { error: 'Spec not found' };

    const id = planId();
    const taskIds: TaskId[] = [];
    const requirementMapping: Record<string, TaskId[]> = {};

    for (const mapping of taskMapping) {
      // Verify requirement exists in spec
      const req = spec.requirements.find(r => r.id === mapping.requirementId);
      if (!req) return { error: `Requirement '${mapping.requirementId}' not found in spec` };

      requirementMapping[mapping.requirementId] = [];

      for (const taskInput of mapping.tasks) {
        const task = dag.addTask({
          ...taskInput,
          specRequirementId: mapping.requirementId,
          planId: id,
        });
        if ('error' in task) return task;
        taskIds.push(task.id);
        requirementMapping[mapping.requirementId].push(task.id);
      }
    }

    const now = new Date();
    const plan: Plan = {
      id,
      specId: specIdVal,
      title,
      taskIds,
      requirementMapping,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(id, plan);
    return plan;
  }

  getPlan(id: PlanId): Plan | undefined {
    return this.plans.get(id);
  }

  getChangesForSpec(specIdVal: SpecId): Change[] {
    return Array.from(this.changes.values()).filter(c => c.specId === specIdVal);
  }

  /**
   * Get traceability: which tasks implement which requirements.
   */
  getTraceability(planIdVal: PlanId): Record<string, TaskId[]> | { error: string } {
    const plan = this.plans.get(planIdVal);
    if (!plan) return { error: 'Plan not found' };
    return plan.requirementMapping;
  }
}

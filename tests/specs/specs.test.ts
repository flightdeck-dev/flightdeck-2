import { describe, it, expect } from 'vitest';
import { SpecStore } from '../../src/specs/SpecStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { type RoleId, type Requirement } from '../../src/core/types.js';

const role = 'role-dev' as RoleId;

describe('SpecStore', () => {
  it('creates a spec with requirements', () => {
    const store = new SpecStore();
    const spec = store.createSpec({
      title: 'Auth System',
      requirements: [
        { id: 'req-1', type: 'functional', description: 'Login with email', acceptanceCriteria: ['User can log in'] },
        { id: 'req-2', type: 'functional', description: 'Password reset', acceptanceCriteria: ['Reset email sent'] },
      ],
    });
    expect(spec.id.startsWith('sp-')).toBe(true);
    expect(spec.requirements.length).toBe(2);
  });

  it('change proposal lifecycle: propose → approve → merge', () => {
    const store = new SpecStore();
    const spec = store.createSpec({
      title: 'Auth',
      requirements: [
        { id: 'req-1', type: 'functional', description: 'Login', acceptanceCriteria: ['Works'] },
      ],
    });

    // Propose a change
    const change = store.proposeChange(spec.id, {
      title: 'Add OAuth',
      description: 'Support OAuth2 login',
      diff: {
        requirements: [
          { id: 'req-1', type: 'functional', description: 'Login', acceptanceCriteria: ['Works'] },
          { id: 'req-3', type: 'functional', description: 'OAuth2 login', acceptanceCriteria: ['Google login works'] },
        ],
      },
    });
    expect('error' in change).toBe(false);
    if ('error' in change) return;
    expect(change.status).toBe('proposed');

    // Approve
    const approved = store.approveChange(change.id);
    expect('error' in approved).toBe(false);

    // Merge
    const merged = store.mergeChange(change.id);
    expect('error' in merged).toBe(false);
    if (!('error' in merged)) {
      // req-1 unchanged, no new reqs removed
      expect(merged.affectedRequirementIds.length).toBe(0);
    }

    // Spec now has 2 requirements
    const updated = store.getSpec(spec.id);
    expect(updated?.requirements.length).toBe(2);
  });

  it('rejects merging unapproved change', () => {
    const store = new SpecStore();
    const spec = store.createSpec({ title: 'Test', requirements: [] });
    const change = store.proposeChange(spec.id, { title: 'X', description: 'Y', diff: {} });
    if ('error' in change) return;

    const result = store.mergeChange(change.id);
    expect('error' in result).toBe(true);
  });

  it('tracks affected requirements on merge', () => {
    const store = new SpecStore();
    const spec = store.createSpec({
      title: 'API',
      requirements: [
        { id: 'req-1', type: 'functional', description: 'GET /users', acceptanceCriteria: ['Returns list'] },
      ],
    });

    const change = store.proposeChange(spec.id, {
      title: 'Update endpoint',
      description: 'Change response format',
      diff: {
        requirements: [
          { id: 'req-1', type: 'functional', description: 'GET /users v2', acceptanceCriteria: ['Returns paginated'] },
        ],
      },
    });
    if ('error' in change) return;

    store.approveChange(change.id);
    const result = store.mergeChange(change.id);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.affectedRequirementIds).toContain('req-1');
    }
  });

  it('creates plan with spec→task traceability', () => {
    const store = new SpecStore();
    const dag = new TaskDAG();

    const spec = store.createSpec({
      title: 'Auth',
      requirements: [
        { id: 'req-1', type: 'functional', description: 'Login', acceptanceCriteria: ['Works'] },
        { id: 'req-2', type: 'functional', description: 'Logout', acceptanceCriteria: ['Session cleared'] },
      ],
    });

    const plan = store.createPlan(spec.id, 'Auth Implementation', [
      {
        requirementId: 'req-1',
        tasks: [{ title: 'Implement login', description: 'Build login endpoint', role }],
      },
      {
        requirementId: 'req-2',
        tasks: [{ title: 'Implement logout', description: 'Build logout endpoint', role }],
      },
    ], dag);

    expect('error' in plan).toBe(false);
    if ('error' in plan) return;

    expect(plan.taskIds.length).toBe(2);

    // Traceability
    const trace = store.getTraceability(plan.id);
    expect('error' in trace).toBe(false);
    if (!('error' in trace)) {
      expect(Object.keys(trace)).toContain('req-1');
      expect(Object.keys(trace)).toContain('req-2');
    }

    // Tasks link back to spec requirements
    for (const tid of plan.taskIds) {
      const task = dag.getTask(tid);
      expect(task?.specRequirementId).toBeDefined();
    }
  });

  it('marks tasks stale when spec requirement changes', () => {
    const store = new SpecStore();
    const dag = new TaskDAG();

    const spec = store.createSpec({
      title: 'API',
      requirements: [{ id: 'req-1', type: 'functional', description: 'Endpoint', acceptanceCriteria: [] }],
    });

    store.createPlan(spec.id, 'Plan', [
      { requirementId: 'req-1', tasks: [{ title: 'Build it', description: '', role }] },
    ], dag);

    // Simulate spec change affecting req-1
    const stale = dag.markStaleByRequirement('req-1');
    expect(stale.length).toBe(1);
    expect(dag.getTask(stale[0])?.stale).toBe(true);
  });
});

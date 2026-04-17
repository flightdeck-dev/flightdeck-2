import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoleRegistry } from '../../src/roles/RoleRegistry.js';

describe('RoleRegistry', () => {
  let registry: RoleRegistry;

  beforeEach(() => {
    registry = new RoleRegistry();
  });

  it('lists all built-in roles', () => {
    const roles = registry.list();
    expect(roles.length).toBeGreaterThanOrEqual(7);
    const ids = roles.map(r => r.id);
    expect(ids).toContain('lead');
    expect(ids).toContain('planner');
    expect(ids).toContain('worker');
    expect(ids).toContain('reviewer');
    expect(ids).toContain('product-thinker');
    expect(ids).toContain('qa-tester');
    expect(ids).toContain('tech-writer');
  });

  it('gets a role by id', () => {
    const lead = registry.get('lead');
    expect(lead).not.toBeNull();
    expect(lead!.id).toBe('lead');
    expect(lead!.name).toBe('Lead');
    expect(lead!.icon).toBe('👑');
    expect(lead!.permissions.plan_approve).toBe(true);
  });

  it('returns null for unknown role', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('hasPermission checks correctly', () => {
    expect(registry.hasPermission('lead', 'plan_approve')).toBe(true);
    expect(registry.hasPermission('planner', 'agent_spawn')).toBe(true);
    expect(registry.hasPermission('worker', 'agent_spawn')).toBe(false);
    expect(registry.hasPermission('worker', 'task_claim')).toBe(true);
    expect(registry.hasPermission('reviewer', 'task_complete')).toBe(true);
    expect(registry.hasPermission('planner', 'declare_tasks')).toBe(true);
  });

  it('getPermissions returns permissions object', () => {
    const perms = registry.getPermissions('worker');
    expect(perms.task_claim).toBe(true);
    expect(perms.task_submit).toBe(true);
    expect(perms.agent_spawn).toBeUndefined();
  });

  it('getSpecialists returns empty for roles without specialists', () => {
    expect(registry.getSpecialists('worker')).toEqual([]);
  });

  it('built-in roles have instructions', () => {
    const worker = registry.get('worker');
    expect(worker!.instructions).toBeTruthy();
    expect(worker!.instructions.length).toBeGreaterThan(0);
  });
});

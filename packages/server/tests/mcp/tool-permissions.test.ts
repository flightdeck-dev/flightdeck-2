import { describe, it, expect } from 'vitest';
import { getToolsForRole, ROLE_TOOLS } from '../../src/mcp/toolPermissions.js';

describe('toolPermissions', () => {
  it('returns correct tools for known roles', () => {
    expect(getToolsForRole('lead')).toBe(ROLE_TOOLS.lead);
    expect(getToolsForRole('worker')).toBe(ROLE_TOOLS.worker);
    expect(getToolsForRole('reviewer')).toBe(ROLE_TOOLS.reviewer);
    expect(getToolsForRole('director')).toBe(ROLE_TOOLS.director);
  });

  it('falls back to worker tools for unknown roles', () => {
    expect(getToolsForRole('unknown-role')).toBe(ROLE_TOOLS.worker);
    expect(getToolsForRole('')).toBe(ROLE_TOOLS.worker);
  });

  it('lead has at least as many tools as worker', () => {
    expect(ROLE_TOOLS.lead.length).toBeGreaterThanOrEqual(ROLE_TOOLS.worker.length);
  });

  it('all roles include flightdeck_status', () => {
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      expect(tools, `${role} should have flightdeck_status`).toContain('flightdeck_status');
    }
  });

  it('all roles include flightdeck_tools_available', () => {
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      expect(tools, `${role} should have flightdeck_tools_available`).toContain('flightdeck_tools_available');
    }
  });

  it('most roles include flightdeck_escalate', () => {
    // Lead uses escalate_to_human instead of escalate
    const rolesWithEscalate = Object.entries(ROLE_TOOLS).filter(([role]) => role !== 'lead');
    for (const [role, tools] of rolesWithEscalate) {
      expect(tools, `${role} should have flightdeck_escalate`).toContain('flightdeck_escalate');
    }
  });

  it('lead and director have correct agent management split', () => {
    // Director manages agents (spawn/terminate)
    expect(ROLE_TOOLS.director).toContain('flightdeck_agent_spawn');
    expect(ROLE_TOOLS.director).toContain('flightdeck_agent_terminate');
    // Lead can view but not manage agents directly
    expect(ROLE_TOOLS.lead).toContain('flightdeck_agent_list');
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_agent_spawn');
    // Workers/reviewers can't manage agents
    expect(ROLE_TOOLS.worker).not.toContain('flightdeck_agent_spawn');
    expect(ROLE_TOOLS.reviewer).not.toContain('flightdeck_agent_spawn');
  });

  it('lead has plan approval tools', () => {
    expect(ROLE_TOOLS.lead).toContain('flightdeck_plan_review');
    expect(ROLE_TOOLS.director).not.toContain('flightdeck_plan_review');
  });

  it('worker can claim and submit tasks', () => {
    expect(ROLE_TOOLS.worker).toContain('flightdeck_task_claim');
    expect(ROLE_TOOLS.worker).toContain('flightdeck_task_submit');
  });

  it('reviewer can complete and fail tasks', () => {
    expect(ROLE_TOOLS.reviewer).toContain('flightdeck_task_complete');
    expect(ROLE_TOOLS.reviewer).toContain('flightdeck_task_fail');
    expect(ROLE_TOOLS.reviewer).toContain('flightdeck_task_get');
  });

  it('lead does NOT have task_complete (reviews are automated)', () => {
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_task_complete');
  });

  it('lead does NOT have task_submit (that is for workers)', () => {
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_task_submit');
  });
});

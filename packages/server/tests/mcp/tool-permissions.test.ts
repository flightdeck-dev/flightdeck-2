import { describe, it, expect } from 'vitest';
import { getToolsForRole, ROLE_TOOLS } from '../../src/mcp/toolPermissions.js';

describe('toolPermissions', () => {
  it('returns correct tools for known roles', () => {
    expect(getToolsForRole('lead')).toBe(ROLE_TOOLS.lead);
    expect(getToolsForRole('director')).toBe(ROLE_TOOLS.director);
  });

  it('all non-lead/non-director roles fall back to agent tools', () => {
    expect(getToolsForRole('worker')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('reviewer')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('scout')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('product-thinker')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('qa-tester')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('tech-writer')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('unknown-role')).toBe(ROLE_TOOLS.agent);
    expect(getToolsForRole('')).toBe(ROLE_TOOLS.agent);
  });

  it('director has the most tools', () => {
    expect(ROLE_TOOLS.director.length).toBeGreaterThanOrEqual(ROLE_TOOLS.lead.length);
    expect(ROLE_TOOLS.director.length).toBeGreaterThanOrEqual(ROLE_TOOLS.agent.length);
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

  it('non-lead roles include flightdeck_escalate', () => {
    // Lead uses escalate_to_human instead of escalate
    expect(ROLE_TOOLS.director).toContain('flightdeck_escalate');
    expect(ROLE_TOOLS.agent).toContain('flightdeck_escalate');
  });

  it('lead and director have correct agent management split', () => {
    expect(ROLE_TOOLS.director).toContain('flightdeck_agent_spawn');
    expect(ROLE_TOOLS.director).toContain('flightdeck_agent_terminate');
    expect(ROLE_TOOLS.lead).toContain('flightdeck_agent_list');
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_agent_spawn');
    expect(ROLE_TOOLS.agent).not.toContain('flightdeck_agent_spawn');
  });

  it('lead has plan approval tools', () => {
    expect(ROLE_TOOLS.lead).toContain('flightdeck_plan_review');
    expect(ROLE_TOOLS.director).not.toContain('flightdeck_plan_review');
  });

  it('agent can submit and complete tasks', () => {
    expect(ROLE_TOOLS.agent).not.toContain('flightdeck_task_delegate');
    expect(ROLE_TOOLS.director).toContain('flightdeck_task_delegate');
    expect(ROLE_TOOLS.agent).toContain('flightdeck_task_submit');
    expect(ROLE_TOOLS.agent).toContain('flightdeck_task_fail');
    expect(ROLE_TOOLS.agent).toContain('flightdeck_task_get');
  });

  it('lead does NOT have task_complete (reviews are automated)', () => {
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_task_complete');
  });

  it('lead does NOT have task_submit (that is for agents)', () => {
    expect(ROLE_TOOLS.lead).not.toContain('flightdeck_task_submit');
  });

  it('only 3 permission tiers exist', () => {
    expect(Object.keys(ROLE_TOOLS).sort()).toEqual(['agent', 'director', 'lead']);
  });
});

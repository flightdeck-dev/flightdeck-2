import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotSdkAdapter } from '../../src/agents/CopilotSdkAdapter.js';

// We can't test the full SDK (needs copilot CLI), but we can test:
// 1. Tool building (correct tools for each role)
// 2. Role-based tool gating

describe('CopilotSdkAdapter', () => {
  describe('buildTools', () => {
    let adapter: CopilotSdkAdapter;

    beforeEach(() => {
      adapter = new CopilotSdkAdapter({ gatewayUrl: 'http://localhost:9999' });
    });

    it('worker gets base tools but not lead tools', () => {
      // Access private method via any
      const tools = (adapter as any).buildTools('worker-1', 'worker', 'test');
      const names = tools.map((t: any) => t.name);

      // Worker should have these
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_task_claim');
      expect(names).toContain('flightdeck_task_submit');
      expect(names).toContain('flightdeck_review_submit');
      expect(names).toContain('flightdeck_escalate');
      expect(names).toContain('flightdeck_search');
      expect(names).toContain('flightdeck_memory_read');
      expect(names).toContain('flightdeck_memory_write');
      expect(names).toContain('flightdeck_learning_add');

      // Worker should NOT have lead-only tools
      expect(names).not.toContain('flightdeck_task_add');
      expect(names).not.toContain('flightdeck_declare_tasks');
      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_agent_terminate');
      expect(names).not.toContain('flightdeck_cost_report');
      expect(names).not.toContain('flightdeck_spec_create');
    });

    it('reviewer gets base tools but not lead tools', () => {
      const tools = (adapter as any).buildTools('reviewer-1', 'reviewer', 'test');
      const names = tools.map((t: any) => t.name);

      expect(names).toContain('flightdeck_review_submit');
      expect(names).toContain('flightdeck_task_comment');
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_search');

      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_declare_tasks');
    });

    it('lead gets all tools including lead-only', () => {
      const tools = (adapter as any).buildTools('lead-1', 'lead', 'test');
      const names = tools.map((t: any) => t.name);

      // Lead gets everything
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_task_add');
      expect(names).toContain('flightdeck_declare_tasks');
      expect(names).toContain('flightdeck_agent_spawn');
      expect(names).toContain('flightdeck_agent_list');
      expect(names).toContain('flightdeck_agent_terminate');
      expect(names).toContain('flightdeck_cost_report');
      expect(names).toContain('flightdeck_decision_log');
      expect(names).toContain('flightdeck_spec_create');
      expect(names).toContain('flightdeck_task_complete');
      expect(names).toContain('flightdeck_task_pause');
      expect(names).toContain('flightdeck_task_resume');
    });

    it('planner gets lead tools', () => {
      const tools = (adapter as any).buildTools('planner-1', 'planner', 'test');
      const names = tools.map((t: any) => t.name);

      expect(names).toContain('flightdeck_declare_tasks');
      expect(names).toContain('flightdeck_spec_create');
    });

    it('all tools have skipPermission: true', () => {
      const tools = (adapter as any).buildTools('lead-1', 'lead', 'test');
      for (const tool of tools) {
        expect(tool.skipPermission).toBe(true);
      }
    });

    it('all tools have name, description, and handler', () => {
      const tools = (adapter as any).buildTools('worker-1', 'worker', 'test');
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('tool count: worker ~16, lead ~27', () => {
      const workerTools = (adapter as any).buildTools('w', 'worker', 'test');
      const leadTools = (adapter as any).buildTools('l', 'lead', 'test');

      expect(workerTools.length).toBeGreaterThanOrEqual(14);
      expect(workerTools.length).toBeLessThan(22);
      expect(leadTools.length).toBeGreaterThanOrEqual(25);
    });
  });
});

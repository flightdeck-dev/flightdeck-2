import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotSdkAdapter } from '../../src/agents/CopilotSdkAdapter.js';

const mockFetch = vi.fn();

describe('CopilotSdkAdapter', () => {
  let adapter: CopilotSdkAdapter;

  beforeEach(() => {
    adapter = new CopilotSdkAdapter({ gatewayUrl: 'http://localhost:9999' });
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function getTool(role: string, name: string) {
    const tools = (adapter as any).buildTools('agent-1', role, 'test-project');
    return tools.find((t: any) => t.name === name);
  }

  function getAllTools(role: string) {
    return (adapter as any).buildTools('agent-1', role, 'test-project');
  }

  function getToolNames(role: string) {
    return getAllTools(role).map((t: any) => t.name);
  }

  // ─── Role-Based Tool Gating ─────────────────────────────────

  describe('role-based tool gating', () => {
    it('worker gets task tools but not lead-only tools', () => {
      const names = getToolNames('worker');
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_task_claim');
      expect(names).toContain('flightdeck_task_submit');
      expect(names).toContain('flightdeck_escalate');
      expect(names).toContain('flightdeck_search');
      expect(names).toContain('flightdeck_status');

      // Worker should NOT have lead/planner tools
      expect(names).not.toContain('flightdeck_task_add');
      expect(names).not.toContain('flightdeck_declare_tasks');
      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_plan_review');
    });

    it('lead has plan_review but NOT agent_spawn or declare_tasks', () => {
      const names = getToolNames('lead');
      expect(names).toContain('flightdeck_plan_review');
      expect(names).toContain('flightdeck_task_list');
      expect(names).not.toContain('flightdeck_task_add');
      expect(names).toContain('flightdeck_role_list');
      expect(names).toContain('flightdeck_tools_available');

      // Lead no longer has these (moved to Planner)
      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_declare_tasks');
    });

    it('planner has agent_spawn and declare_tasks', () => {
      const names = getToolNames('planner');
      expect(names).toContain('flightdeck_agent_spawn');
      expect(names).toContain('flightdeck_declare_tasks');
      expect(names).toContain('flightdeck_task_pause');
      expect(names).toContain('flightdeck_task_resume');
      expect(names).not.toContain('flightdeck_plan_review');
    });

    it('lead tools are a proper subset of built tools after filtering', () => {
      const leadTools = getToolNames('lead');
      const workerTools = getToolNames('worker');
      // Lead should have more tools than worker
      expect(leadTools.length).toBeGreaterThan(workerTools.length);
    });
  });

  // ─── Tool Schema Validation ─────────────────────────────────

  describe('tool schema validation', () => {
    it('all tools have skipPermission: true', () => {
      for (const tool of getAllTools('lead')) {
        expect(tool.skipPermission).toBe(true);
      }
    });

    it('all tools have name, description, parameters, and handler', () => {
      for (const tool of getAllTools('lead')) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('no duplicate tool names within a role', () => {
      for (const role of ['worker', 'reviewer', 'lead', 'planner']) {
        const names = getToolNames(role);
        expect(new Set(names).size).toBe(names.length);
      }
    });

    it('all tool names start with flightdeck_', () => {
      for (const tool of getAllTools('lead')) {
        expect(tool.name).toMatch(/^flightdeck_/);
      }
    });
  });

  // ─── Tool Handler HTTP Calls ────────────────────────────────

  describe('tool handler HTTP calls', () => {
    function mockJsonResponse(data: unknown) {
      mockFetch.mockResolvedValueOnce({ json: async () => data });
    }

    it('task_list calls GET /tasks', async () => {
      const tool = getTool('worker', 'flightdeck_task_list');
      mockJsonResponse([{ id: 'task-1', state: 'ready' }]);
      const result = await tool.handler({ state: 'ready' });
      expect(JSON.parse(result)).toEqual([{ id: 'task-1', state: 'ready' }]);
      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tasks');
    });

    it('task_claim calls POST /tasks/:id/claim', async () => {
      const tool = getTool('worker', 'flightdeck_task_claim');
      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc' });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/claim');
      expect(opts.method).toBe('POST');
    });

    it('task_submit calls POST /tasks/:id/submit', async () => {
      const tool = getTool('worker', 'flightdeck_task_submit');
      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc', claim: 'Did the thing' });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/submit');
      expect(JSON.parse(opts.body)).toEqual({ claim: 'Did the thing' });
    });

    it('escalate calls POST /escalate', async () => {
      const tool = getTool('worker', 'flightdeck_escalate');
      mockJsonResponse({ ok: true });
      await tool.handler({ reason: 'Blocked' });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/escalate');
    });

    it('search calls GET /search', async () => {
      const tool = getTool('worker', 'flightdeck_search');
      mockJsonResponse({ results: [] });
      await tool.handler({ query: 'bug fix' });
      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/search');
    });

    it('status calls GET /status', async () => {
      const tool = getTool('worker', 'flightdeck_status');
      mockJsonResponse({ tasks: 5 });
      const result = await tool.handler({});
      expect(JSON.parse(result)).toEqual({ tasks: 5 });
    });

    it('declare_tasks available for planner', async () => {
      const tool = getTool('planner', 'flightdeck_declare_tasks');
      expect(tool).toBeDefined();
      mockJsonResponse({ created: 2 });
      await tool.handler({ tasks: [{ title: 'A' }] });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/declare');
      expect(opts.method).toBe('POST');
    });

    it('agent_spawn available for planner', async () => {
      const tool = getTool('planner', 'flightdeck_agent_spawn');
      expect(tool).toBeDefined();
      mockJsonResponse({ agentId: 'w-1' });
      await tool.handler({ role: 'worker' });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/agents/spawn');
    });

    it('plan_review available for lead', async () => {
      const tool = getTool('lead', 'flightdeck_plan_review');
      expect(tool).toBeDefined();
    });

    it('tools_available returns role info', async () => {
      const tool = getTool('lead', 'flightdeck_tools_available');
      expect(tool).toBeDefined();
      const result = JSON.parse(await tool.handler({}));
      expect(result.role).toBe('lead');
      expect(result.tools).toContain('flightdeck_plan_review');
    });
  });

  // ─── HTTP Headers ───────────────────────────────────────────

  describe('HTTP headers', () => {
    function mockJsonResponse(data: unknown) {
      mockFetch.mockResolvedValueOnce({ json: async () => data });
    }

    it('all requests include X-Agent-Id and X-Agent-Role headers', async () => {
      const tool = getTool('worker', 'flightdeck_status');
      mockJsonResponse({});
      await tool.handler({});
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-Agent-Id']).toBe('agent-1');
      expect(opts.headers['X-Agent-Role']).toBe('worker');
    });
  });

  // ─── AgentAdapter Interface ─────────────────────────────────

  describe('AgentAdapter interface', () => {
    it('has runtime property', () => {
      expect(adapter.runtime).toBeDefined();
    });

    it('getMetadata returns null for unknown session', async () => {
      expect(await adapter.getMetadata('nonexistent')).toBeNull();
    });

    it('kill is silent for unknown session', async () => {
      await adapter.kill('nonexistent');
    });

    it('shutdown is idempotent', async () => {
      await adapter.shutdown();
      await adapter.shutdown();
    });
  });
});

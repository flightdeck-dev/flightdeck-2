import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotSdkAdapter } from '../../src/agents/CopilotSdkAdapter.js';

// Mock global fetch for tool handler tests
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

  // Helper: get a tool by name from buildTools
  function getTool(role: string, name: string) {
    const tools = (adapter as any).buildTools('agent-1', role, 'test-project');
    return tools.find((t: any) => t.name === name);
  }

  function getAllTools(role: string) {
    return (adapter as any).buildTools('agent-1', role, 'test-project');
  }

  // ─── Role-Based Tool Gating ─────────────────────────────────

  describe('role-based tool gating', () => {
    it('worker gets base tools but not lead tools', () => {
      const names = getAllTools('worker').map((t: any) => t.name);
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_task_claim');
      expect(names).toContain('flightdeck_task_submit');
      expect(names).toContain('flightdeck_review_submit');
      expect(names).toContain('flightdeck_escalate');
      expect(names).toContain('flightdeck_search');
      expect(names).toContain('flightdeck_memory_read');
      expect(names).toContain('flightdeck_memory_write');
      expect(names).toContain('flightdeck_learning_add');
      expect(names).toContain('flightdeck_learning_search');
      expect(names).toContain('flightdeck_task_get');
      expect(names).toContain('flightdeck_task_fail');
      expect(names).toContain('flightdeck_msg_send');
      expect(names).toContain('flightdeck_read');
      expect(names).toContain('flightdeck_status');

      expect(names).not.toContain('flightdeck_task_add');
      expect(names).not.toContain('flightdeck_declare_tasks');
      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_agent_terminate');
      expect(names).not.toContain('flightdeck_agent_list');
      expect(names).not.toContain('flightdeck_cost_report');
      expect(names).not.toContain('flightdeck_spec_create');
      expect(names).not.toContain('flightdeck_decision_log');
      expect(names).not.toContain('flightdeck_task_complete');
      expect(names).not.toContain('flightdeck_task_pause');
      expect(names).not.toContain('flightdeck_task_resume');
    });

    it('reviewer gets same base tools as worker', () => {
      const workerNames = new Set(getAllTools('worker').map((t: any) => t.name));
      const reviewerNames = new Set(getAllTools('reviewer').map((t: any) => t.name));
      // Reviewer and worker should have identical tool sets (both base)
      expect(reviewerNames).toEqual(workerNames);
    });

    it('lead gets all base + lead-only tools', () => {
      const names = getAllTools('lead').map((t: any) => t.name);
      // base tools
      expect(names).toContain('flightdeck_task_list');
      expect(names).toContain('flightdeck_search');
      // lead-only
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

    it('planner gets lead-only tools', () => {
      const names = getAllTools('planner').map((t: any) => t.name);
      expect(names).toContain('flightdeck_declare_tasks');
      expect(names).toContain('flightdeck_agent_spawn');
      expect(names).toContain('flightdeck_spec_create');
    });

    it('tool count: worker ~16, lead ~27', () => {
      const wCount = getAllTools('worker').length;
      const lCount = getAllTools('lead').length;
      expect(wCount).toBeGreaterThanOrEqual(14);
      expect(wCount).toBeLessThan(22);
      expect(lCount).toBeGreaterThanOrEqual(25);
      expect(lCount).toBeGreaterThan(wCount);
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
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.type).toBe('object');
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('tools with required params declare them in schema', () => {
      const tool = getTool('worker', 'flightdeck_task_claim');
      expect(tool.parameters.required).toContain('taskId');

      const submit = getTool('worker', 'flightdeck_task_submit');
      expect(submit.parameters.required).toContain('taskId');

      const review = getTool('worker', 'flightdeck_review_submit');
      expect(review.parameters.required).toContain('taskId');
      expect(review.parameters.required).toContain('verdict');
      expect(review.parameters.required).toContain('comment');
    });

    it('no duplicate tool names within a role', () => {
      for (const role of ['worker', 'reviewer', 'lead', 'planner']) {
        const names = getAllTools(role).map((t: any) => t.name);
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

    it('task_list calls GET /tasks with optional state filter', async () => {
      const tool = getTool('worker', 'flightdeck_task_list');

      mockJsonResponse([{ id: 'task-1', state: 'ready' }]);
      const result = await tool.handler({ state: 'ready' });
      expect(JSON.parse(result)).toEqual([{ id: 'task-1', state: 'ready' }]);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tasks');
      expect(url.toString()).toContain('state=ready');
    });

    it('task_list without state filter omits query param', async () => {
      const tool = getTool('worker', 'flightdeck_task_list');

      mockJsonResponse([]);
      await tool.handler({});

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).not.toContain('state=');
    });

    it('task_claim calls POST /tasks/:id/claim', async () => {
      const tool = getTool('worker', 'flightdeck_task_claim');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/claim');
      expect(opts.method).toBe('POST');
    });

    it('task_submit calls POST /tasks/:id/submit with claim', async () => {
      const tool = getTool('worker', 'flightdeck_task_submit');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc', claim: 'Did the thing' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/submit');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ claim: 'Did the thing' });
    });

    it('review_submit calls POST /tasks/:id/review with verdict + comment', async () => {
      const tool = getTool('worker', 'flightdeck_review_submit');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc', verdict: 'approve', comment: 'LGTM' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/review');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.verdict).toBe('approve');
      expect(body.comment).toBe('LGTM');
    });

    it('task_comment calls POST /tasks/:id/comments', async () => {
      const tool = getTool('worker', 'flightdeck_task_comment');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc', comment: 'Need help' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/comments');
      expect(JSON.parse(opts.body)).toEqual({ message: 'Need help' });
    });

    it('escalate calls POST /escalate', async () => {
      const tool = getTool('worker', 'flightdeck_escalate');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc', reason: 'Blocked' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/escalate');
      expect(JSON.parse(opts.body)).toEqual({ taskId: 'task-abc', reason: 'Blocked' });
    });

    it('msg_send calls POST /messages', async () => {
      const tool = getTool('worker', 'flightdeck_msg_send');

      mockJsonResponse({ ok: true });
      await tool.handler({ to: 'lead-1', content: 'Hello' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/messages');
      expect(JSON.parse(opts.body)).toEqual({ to: 'lead-1', content: 'Hello' });
    });

    it('search calls GET /search with query param', async () => {
      const tool = getTool('worker', 'flightdeck_search');

      mockJsonResponse({ results: [] });
      await tool.handler({ query: 'bug fix' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/search');
      expect(url.toString()).toContain('q=bug+fix');
    });

    it('search with source filter passes it as param', async () => {
      const tool = getTool('worker', 'flightdeck_search');

      mockJsonResponse({ results: [] });
      await tool.handler({ query: 'test', source: 'memory' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('source=memory');
    });

    it('status calls GET /status', async () => {
      const tool = getTool('worker', 'flightdeck_status');

      mockJsonResponse({ tasks: 5, agents: 2 });
      const result = await tool.handler({});
      expect(JSON.parse(result)).toEqual({ tasks: 5, agents: 2 });
    });

    it('task_get calls GET /tasks/:id', async () => {
      const tool = getTool('worker', 'flightdeck_task_get');

      mockJsonResponse({ id: 'task-1', title: 'Fix bug' });
      await tool.handler({ taskId: 'task-1' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tasks/task-1');
    });

    it('task_fail calls POST /tasks/:id/fail', async () => {
      const tool = getTool('worker', 'flightdeck_task_fail');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-1', reason: 'Cannot reproduce' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-1/fail');
      expect(JSON.parse(opts.body)).toEqual({ reason: 'Cannot reproduce' });
    });

    it('memory_read calls GET /memory/:filename', async () => {
      const tool = getTool('worker', 'flightdeck_memory_read');

      mockJsonResponse({ content: 'hello world' });
      await tool.handler({ filename: 'notes.md' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/memory/notes.md');
    });

    it('memory_write calls PUT /memory/:filename', async () => {
      const tool = getTool('worker', 'flightdeck_memory_write');

      mockJsonResponse({ ok: true });
      await tool.handler({ filename: 'notes.md', content: 'updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/memory/notes.md');
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body)).toEqual({ content: 'updated' });
    });

    it('learning_add calls POST /learnings', async () => {
      const tool = getTool('worker', 'flightdeck_learning_add');

      mockJsonResponse({ ok: true });
      await tool.handler({ content: 'Always check types', tags: 'typescript,lint' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/learnings');
      expect(JSON.parse(opts.body)).toEqual({ content: 'Always check types', tags: 'typescript,lint' });
    });

    it('learning_search calls GET /learnings/search', async () => {
      const tool = getTool('worker', 'flightdeck_learning_search');

      mockJsonResponse([]);
      await tool.handler({ query: 'typescript' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/learnings/search');
      expect(url.toString()).toContain('query=typescript');
    });

    it('read (messages) calls GET /messages', async () => {
      const tool = getTool('worker', 'flightdeck_read');

      mockJsonResponse([]);
      await tool.handler({ channel: 'general', limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/messages');
      expect(url.toString()).toContain('channel=general');
      expect(url.toString()).toContain('limit=10');
    });
  });

  // ─── Lead-Only Tool Handlers ────────────────────────────────

  describe('lead-only tool handlers', () => {
    function mockJsonResponse(data: unknown) {
      mockFetch.mockResolvedValueOnce({ json: async () => data });
    }

    it('task_add calls POST /tasks', async () => {
      const tool = getTool('lead', 'flightdeck_task_add');

      mockJsonResponse({ id: 'task-new' });
      await tool.handler({ title: 'New task', description: 'Do something', priority: 1 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.title).toBe('New task');
      expect(body.priority).toBe(1);
    });

    it('declare_tasks calls POST /tasks/declare', async () => {
      const tool = getTool('lead', 'flightdeck_declare_tasks');
      const tasks = [{ title: 'A' }, { title: 'B', dependsOn: ['A'] }];

      mockJsonResponse({ created: 2 });
      await tool.handler({ tasks });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/declare');
      expect(JSON.parse(opts.body).tasks).toEqual(tasks);
    });

    it('agent_spawn calls POST /agents/spawn', async () => {
      const tool = getTool('lead', 'flightdeck_agent_spawn');

      mockJsonResponse({ agentId: 'worker-1' });
      await tool.handler({ role: 'worker', model: 'fast' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/agents/spawn');
      expect(JSON.parse(opts.body)).toEqual({ role: 'worker', model: 'fast' });
    });

    it('agent_list calls GET /agents', async () => {
      const tool = getTool('lead', 'flightdeck_agent_list');

      mockJsonResponse([{ id: 'w-1' }]);
      await tool.handler({});

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/agents');
    });

    it('agent_terminate calls POST /agents/:id/terminate', async () => {
      const tool = getTool('lead', 'flightdeck_agent_terminate');

      mockJsonResponse({ ok: true });
      await tool.handler({ agentId: 'worker-1' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/agents/worker-1/terminate');
    });

    it('task_complete calls POST /tasks/:id/complete', async () => {
      const tool = getTool('lead', 'flightdeck_task_complete');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-1' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-1/complete');
    });

    it('task_pause calls POST /tasks/:id/pause', async () => {
      const tool = getTool('lead', 'flightdeck_task_pause');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-1' });

      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:9999/api/projects/test-project/tasks/task-1/pause');
    });

    it('task_resume calls POST /tasks/:id/resume', async () => {
      const tool = getTool('lead', 'flightdeck_task_resume');

      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-1' });

      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:9999/api/projects/test-project/tasks/task-1/resume');
    });

    it('cost_report calls GET /cost', async () => {
      const tool = getTool('lead', 'flightdeck_cost_report');

      mockJsonResponse({ total: 1.23 });
      const result = await tool.handler({});
      expect(JSON.parse(result)).toEqual({ total: 1.23 });
    });

    it('decision_log calls POST /decisions', async () => {
      const tool = getTool('lead', 'flightdeck_decision_log');

      mockJsonResponse({ ok: true });
      await tool.handler({ title: 'Use SDK', rationale: 'Fewer hops', taskId: 'task-1' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/decisions');
      const body = JSON.parse(opts.body);
      expect(body.title).toBe('Use SDK');
      expect(body.rationale).toBe('Fewer hops');
    });

    it('spec_create calls POST /specs', async () => {
      const tool = getTool('lead', 'flightdeck_spec_create');

      mockJsonResponse({ id: 'spec-1' });
      await tool.handler({ title: 'Auth spec', content: '## Requirements\n...' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/specs');
      expect(JSON.parse(opts.body).title).toBe('Auth spec');
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

    it('POST requests include Content-Type: application/json', async () => {
      const tool = getTool('worker', 'flightdeck_task_claim');
      mockJsonResponse({});
      await tool.handler({ taskId: 'task-1' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['Content-Type']).toBe('application/json');
    });
  });

  // ─── URL Encoding ──────────────────────────────────────────

  describe('URL encoding', () => {
    function mockJsonResponse(data: unknown) {
      mockFetch.mockResolvedValueOnce({ json: async () => data });
    }

    it('task IDs with special chars are encoded', async () => {
      const tool = getTool('worker', 'flightdeck_task_claim');
      mockJsonResponse({});
      await tool.handler({ taskId: 'task/special&chars' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('task%2Fspecial%26chars');
    });

    it('memory filenames with paths are encoded', async () => {
      const tool = getTool('worker', 'flightdeck_memory_read');
      mockJsonResponse({});
      await tool.handler({ filename: 'sub/dir/notes.md' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('sub%2Fdir%2Fnotes.md');
    });
  });

  // ─── AgentAdapter Interface ─────────────────────────────────

  describe('AgentAdapter interface', () => {
    it('has runtime property', () => {
      expect(adapter.runtime).toBeDefined();
    });

    it('getMetadata returns null for unknown session', async () => {
      const meta = await adapter.getMetadata('nonexistent');
      expect(meta).toBeNull();
    });

    it('getSession returns undefined for unknown session', () => {
      const session = adapter.getSession('nonexistent');
      expect(session).toBeUndefined();
    });

    it('steer throws for unknown session', async () => {
      await expect(adapter.steer('nonexistent', { content: 'hello' }))
        .rejects.toThrow('Session not found');
    });

    it('kill is silent for unknown session', async () => {
      await adapter.kill('nonexistent'); // should not throw
    });

    it('shutdown is idempotent', async () => {
      await adapter.shutdown();
      await adapter.shutdown(); // no error
    });
  });
});

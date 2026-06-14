import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotSdkAdapter, excludedNativeToolsForRole } from '../../src/agents/CopilotSdkAdapter.js';

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

  // ─── Excluded Native Tools (run permission + sub-agents) ────

  describe('excluded native tools by role', () => {
    it('lead has no run permission (shell/exec tools excluded)', () => {
      const excluded = excludedNativeToolsForRole('lead')!;
      for (const t of ['bash', 'write_bash', 'shell', 'exec', 'run_in_terminal']) {
        expect(excluded).toContain(t);
      }
    });

    it('lead has no sub-agents (task/subagent launchers excluded)', () => {
      const excluded = excludedNativeToolsForRole('lead')!;
      for (const t of ['task', 'subagent', 'run_subagent', 'launch_agent', 'spawn_agent']) {
        expect(excluded).toContain(t);
      }
    });

    it('lead still excludes write/edit tools', () => {
      const excluded = excludedNativeToolsForRole('lead')!;
      expect(excluded).toContain('write_file');
      expect(excluded).toContain('edit');
    });

    it('lead keeps read tools (can read files for context)', () => {
      const excluded = excludedNativeToolsForRole('lead')!;
      for (const t of ['view', 'read_file', 'grep', 'glob']) {
        expect(excluded).not.toContain(t);
      }
    });

    it('director excludes write/execute but is not stripped of sub-agents', () => {
      const excluded = excludedNativeToolsForRole('director')!;
      expect(excluded).toContain('bash');
      expect(excluded).toContain('write_bash');
      expect(excluded).not.toContain('task');
      expect(excluded).not.toContain('subagent');
      expect(excluded).not.toContain('shell');
    });

    it('non-management roles get no exclusions', () => {
      expect(excludedNativeToolsForRole('worker')).toBeUndefined();
      expect(excludedNativeToolsForRole('reviewer')).toBeUndefined();
    });

    it('returns a de-duplicated list', () => {
      const excluded = excludedNativeToolsForRole('lead')!;
      expect(excluded.length).toBe(new Set(excluded).size);
    });
  });

  // ─── Role-Based Tool Gating ─────────────────────────────────

  describe('role-based tool gating', () => {
    it('worker gets task tools but not lead-only tools', () => {
      const names = getToolNames('worker');
      expect(names).toContain('flightdeck_task_list');
      expect(names).not.toContain('flightdeck_task_delegate');
      expect(names).toContain('flightdeck_task_submit');
      expect(names).toContain('flightdeck_escalate');
      expect(names).toContain('flightdeck_search');
      expect(names).toContain('flightdeck_status');

      // Worker should NOT have lead/director tools
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

      // Lead no longer has these (moved to Director)
      expect(names).not.toContain('flightdeck_agent_spawn');
      expect(names).not.toContain('flightdeck_declare_tasks');
    });

    it('director has agent_spawn and declare_tasks', () => {
      const names = getToolNames('director');
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
      for (const role of ['worker', 'reviewer', 'lead', 'director']) {
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
      mockFetch.mockResolvedValueOnce({ text: async () => JSON.stringify(data), ok: true, status: 200 });
    }

    it('task_list calls GET /tasks', async () => {
      const tool = getTool('worker', 'flightdeck_task_list');
      mockJsonResponse([{ id: 'task-1', state: 'ready' }]);
      const result = await tool.handler({ state: 'ready' });
      expect(JSON.parse(result)).toEqual([{ id: 'task-1', state: 'ready' }]);
      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tasks');
    });

    it('task_delegate calls POST /tasks/:id/delegate', async () => {
      const tool = getTool('director', 'flightdeck_task_delegate');
      mockJsonResponse({ ok: true });
      await tool.handler({ taskId: 'task-abc' });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/task-abc/delegate');
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

    it('declare_tasks available for director', async () => {
      const tool = getTool('director', 'flightdeck_declare_tasks');
      expect(tool).toBeDefined();
      mockJsonResponse({ created: 2 });
      await tool.handler({ tasks: [{ title: 'A' }] });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9999/api/projects/test-project/tasks/declare');
      expect(opts.method).toBe('POST');
    });

    it('agent_spawn available for director', async () => {
      const tool = getTool('director', 'flightdeck_agent_spawn');
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
      mockFetch.mockResolvedValueOnce({ text: async () => JSON.stringify(data), ok: true, status: 200 });
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

  // ─── Stream event processing (dedup + ACP-style chunk synthesis) ─────

  describe('processStreamEvent', () => {
    function makeSession() {
      const chunks: any[] = [];
      const session: any = { onOutputChunk: (u: any) => chunks.push(u) };
      return { session, chunks };
    }
    const process = (session: any, event: any) =>
      (adapter as any).processStreamEvent(session, event);

    it('rewrites the full assistant.message to message_final after deltas were streamed', () => {
      const { session, chunks } = makeSession();
      expect(process(session, { type: 'assistant.message_delta', data: { deltaContent: 'hello ' } })).toBeTruthy();
      expect(process(session, { type: 'assistant.message_delta', data: { deltaContent: 'world' } })).toBeTruthy();
      // Full message repeats the streamed text — forwarded as a REPLACE event
      // so the UI swaps the accumulated stream for the authoritative text
      const fwd = process(session, { type: 'assistant.message', data: { content: 'hello world' } });
      expect(fwd).toEqual({ type: 'assistant.message_final', data: { content: 'hello world' } });
      const texts = chunks.filter(c => c.sessionUpdate === 'agent_message_chunk').map(c => c.content.text);
      expect(texts).toEqual(['hello ', 'world']);
    });

    it('forwards the full assistant.message unchanged when nothing was streamed', () => {
      const { session, chunks } = makeSession();
      const event = { type: 'assistant.message', data: { content: 'hello world' } };
      expect(process(session, event)).toBe(event);
      expect(chunks).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello world' } }]);
    });

    it('resets delta tracking at turn boundary (session.idle)', () => {
      const { session } = makeSession();
      process(session, { type: 'assistant.message_delta', data: { deltaContent: 'a' } });
      process(session, { type: 'session.idle' });
      // Next turn answers without streaming — full message passes through unchanged
      const event = { type: 'assistant.message', data: { content: 'next turn' } };
      expect(process(session, event)).toBe(event);
    });

    it('drops duplicate reasoning (thinking does not need replace fidelity)', () => {
      const { session } = makeSession();
      process(session, { type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking…' } });
      expect(process(session, { type: 'assistant.reasoning', data: { content: 'thinking…' } })).toBeNull();
    });

    it('synthesizes ACP-style tool call updates for onOutputChunk', () => {
      const { session, chunks } = makeSession();
      process(session, { type: 'tool.execution_start', data: { toolCallId: 't1', name: 'grep', arguments: { q: 'x' } } });
      process(session, { type: 'tool.execution_complete', data: { toolCallId: 't1', name: 'grep', content: 'match' } });
      expect(chunks[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep', status: 'pending' });
      expect(chunks[1]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'grep', status: 'completed', content: [{ type: 'text', text: 'match' }] });
    });

    it('works without onOutputChunk wired (workers)', () => {
      const session: any = {};
      expect(process(session, { type: 'assistant.message_delta', data: { deltaContent: 'x' } })).toBeTruthy();
      expect(process(session, { type: 'assistant.message', data: { content: 'x' } }))
        .toEqual({ type: 'assistant.message_final', data: { content: 'x' } });
    });

    it('mapper marks message_final as a replace broadcast', async () => {
      const { mapCopilotSdkEvent } = await import('../../src/agents/copilotSdkEventMapper.js');
      expect(mapCopilotSdkEvent({ type: 'assistant.message_final', data: { content: 'final text' } }))
        .toEqual({ delta: 'final text', contentType: 'text', replace: true });
      // Plain deltas and unstreamed full messages stay append-mode
      expect(mapCopilotSdkEvent({ type: 'assistant.message_delta', data: { deltaContent: 'x' } }))
        .toEqual({ delta: 'x', contentType: 'text' });
      expect(mapCopilotSdkEvent({ type: 'assistant.message', data: { content: 'y' } }))
        .toEqual({ delta: 'y', contentType: 'text' });
    });
  });
});

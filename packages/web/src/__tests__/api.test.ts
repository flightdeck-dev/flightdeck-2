import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test the api module which uses fetch internally
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('api module', () => {
  // We test the internal helpers indirectly through api methods
  
  it('getProjects calls /api/projects and returns projects array', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects: [{ name: 'p1', governance: 'autonomous', agent_count: 2, task_stats: { running: 1 }, total_cost: 0.5 }] }),
    });
    const { api } = await import('../lib/api.ts');
    const result = await api.getProjects();
    expect(global.fetch).toHaveBeenCalledWith('/api/projects');
    expect(result).toEqual([{ name: 'p1', governance: 'autonomous', agentCount: 2, taskStats: { running: 1 }, totalCost: 0.5 }]);
  });

  it('getStatus calls correct project path', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ config: { name: 'test' }, task_stats: {}, agent_count: 0, total_cost: 0 }),
    });
    const { api } = await import('../lib/api.ts');
    await api.getStatus('my-project');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/my-project/status');
  });

  it('getTasks calls correct endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 't1', title: 'Task 1', state: 'running' }]),
    });
    const { api } = await import('../lib/api.ts');
    const tasks = await api.getTasks('proj');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/tasks');
    expect(tasks).toEqual([{ id: 't1', title: 'Task 1', state: 'running' }]);
  });

  it('throws on non-200 response for GET', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const { api } = await import('../lib/api.ts');
    await expect(api.getTasks('proj')).rejects.toThrow('GET /api/projects/proj/tasks: 404');
  });

  it('createTask sends POST with body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 't2', title: 'New', state: 'pending' }),
    });
    const { api } = await import('../lib/api.ts');
    await api.createTask('proj', { title: 'New' });
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/tasks', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'New' }),
    }));
  });

  it('throws on non-200 POST', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { api } = await import('../lib/api.ts');
    await expect(api.createTask('proj', { title: 'x' })).rejects.toThrow('POST');
  });

  it('sendMessage posts content', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'm1', content: 'hi' }),
    });
    const { api } = await import('../lib/api.ts');
    await api.sendMessage('proj', 'hello');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }));
  });

  it('getMessages builds query params', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { api } = await import('../lib/api.ts');
    await api.getMessages('proj', { limit: 50, author_types: 'user,lead' });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('limit=50');
    expect(url).toContain('author_types=user%2Clead');
  });

  it('encodes project name in URL', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { api } = await import('../lib/api.ts');
    await api.getTasks('my project');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/my%20project/tasks');
  });

  it('updateProjectConfig uses PUT', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ config: {} }),
    });
    const { api } = await import('../lib/api.ts');
    await api.updateProjectConfig('proj', { governance: 'supervised' });
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ governance: 'supervised' }),
    }));
  });

  it('throws on non-200 PUT', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const { api } = await import('../lib/api.ts');
    await expect(api.updateProjectConfig('proj', {})).rejects.toThrow('PUT');
  });

  it('deleteProject sends DELETE', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: 'deleted' }),
    });
    const { api } = await import('../lib/api.ts');
    await api.deleteProject('proj');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj', { method: 'DELETE' });
  });

  it('getReport returns text on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('# Report'),
    });
    const { api } = await import('../lib/api.ts');
    const report = await api.getReport('proj');
    expect(report).toBe('# Report');
  });

  it('getReport returns fallback on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const { api } = await import('../lib/api.ts');
    const report = await api.getReport('proj');
    expect(report).toBe('No report available.');
  });

  it('listCron calls correct endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { api } = await import('../lib/api.ts');
    await api.listCron('proj');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/cron');
  });

  it('hibernateAgent sends POST', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const { api } = await import('../lib/api.ts');
    await api.hibernateAgent('proj', 'agent-1');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/agents/agent-1/hibernate', expect.objectContaining({ method: 'POST' }));
  });

  it('camelizeKeys converts snake_case recursively', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task_stats: { in_review: 2 }, agent_count: 3, total_cost: 1.5, config: { lead_model: 'gpt-4' } }),
    });
    const { api } = await import('../lib/api.ts');
    const status = await api.getStatus('proj');
    expect(status).toEqual({ taskStats: { inReview: 2 }, agentCount: 3, totalCost: 1.5, config: { leadModel: 'gpt-4' } });
  });

  it('getEscalations adds status param', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { api } = await import('../lib/api.ts');
    await api.getEscalations('proj', 'pending');
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/escalations?status=pending');
  });

  it('search encodes query', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tasks: [], agents: [], messages: [] }),
    });
    const { api } = await import('../lib/api.ts');
    await api.search('proj', 'hello world');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('q=hello%20world');
  });
});

import { Flightdeck } from '../../src/facade.js';
import type { Task, Agent, Decision, Message } from '../../src/core/types.js';

interface ApiResult {
  status: number;
  data: any;
}

type Router = (method: string, pathname: string, params: URLSearchParams, body: any) => Promise<ApiResult | null>;

export function createApiRouter(projectName: string): Router {
  const fd = new Flightdeck(projectName);

  // Simple route matching
  function match(pattern: string, pathname: string): Record<string, string> | null {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }

  return async (method, pathname, searchParams, body): Promise<ApiResult | null> => {
    // GET /api/status
    if (method === 'GET' && pathname === '/api/status') {
      const status = fd.status();
      return { status: 200, data: status };
    }

    // GET /api/specs
    if (method === 'GET' && pathname === '/api/specs') {
      const specs = fd.listSpecs();
      return { status: 200, data: specs };
    }

    // POST /api/specs
    if (method === 'POST' && pathname === '/api/specs') {
      const { title, content } = body;
      if (!title) return { status: 400, data: { error: 'title required' } };
      const spec = fd.createSpec(title, content || '');
      return { status: 201, data: spec };
    }

    // GET /api/specs/:id
    {
      const m = match('/api/specs/:id', pathname);
      if (method === 'GET' && m) {
        const specs = fd.listSpecs();
        const spec = specs.find(s => s.id === m.id);
        if (!spec) return { status: 404, data: { error: 'Spec not found' } };
        // Also get tasks for this spec
        const tasks = fd.listTasks(m.id as any);
        return { status: 200, data: { ...spec, tasks } };
      }
    }

    // GET /api/tasks
    if (method === 'GET' && pathname === '/api/tasks') {
      const specId = searchParams.get('spec') || undefined;
      const tasks = fd.listTasks(specId as any);
      const statusFilter = searchParams.get('status');
      const filtered = statusFilter ? tasks.filter(t => t.state === statusFilter) : tasks;
      return { status: 200, data: filtered };
    }

    // POST /api/tasks
    if (method === 'POST' && pathname === '/api/tasks') {
      const { title, description, specId, role, dependsOn, priority } = body;
      if (!title) return { status: 400, data: { error: 'title required' } };
      const task = fd.addTask({ title, description, specId, role, dependsOn, priority });
      return { status: 201, data: task };
    }

    // PATCH /api/tasks/:id
    {
      const m = match('/api/tasks/:id', pathname);
      if (method === 'PATCH' && m) {
        const { action, agentId, claim } = body;
        try {
          let task: Task;
          switch (action) {
            case 'claim':
              task = fd.claimTask(m.id as any, agentId);
              break;
            case 'submit':
              task = fd.submitTask(m.id as any, claim);
              break;
            case 'complete':
              task = fd.completeTask(m.id as any);
              break;
            case 'fail':
              task = fd.failTask(m.id as any);
              break;
            default:
              return { status: 400, data: { error: 'Invalid action' } };
          }
          return { status: 200, data: task };
        } catch (err: any) {
          return { status: 400, data: { error: err.message } };
        }
      }
    }

    // GET /api/agents
    if (method === 'GET' && pathname === '/api/agents') {
      const agents = fd.listAgents();
      return { status: 200, data: agents };
    }

    // GET /api/decisions
    if (method === 'GET' && pathname === '/api/decisions') {
      const decisions = fd.decisions.readAll();
      const specFilter = searchParams.get('spec');
      const filtered = specFilter ? decisions.filter(d => (d as any).specId === specFilter) : decisions;
      return { status: 200, data: filtered };
    }

    // GET /api/messages/:channel
    {
      const m = match('/api/messages/:channel', pathname);
      if (method === 'GET' && m) {
        const since = searchParams.get('since') || undefined;
        const messages = fd.readMessages(m.channel, since);
        return { status: 200, data: messages };
      }
    }

    // POST /api/messages/:channel
    {
      const m = match('/api/messages/:channel', pathname);
      if (method === 'POST' && m) {
        fd.sendMessage(body, m.channel);
        return { status: 201, data: { ok: true } };
      }
    }

    return null;
  };
}

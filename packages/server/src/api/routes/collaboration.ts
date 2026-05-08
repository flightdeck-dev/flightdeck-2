import { errorJson } from './utils.js';
import type { ProjectScopedDeps } from './types.js';

export async function handleCollaborationRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, json, readBody, req, url } = deps;

  if (subPath === '/escalate' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.taskId || !body.reason) { json(400, { error: 'Missing taskId or reason' }); return true; }
      const { messageId } = await import('@flightdeck-ai/shared');
      const msg = {
        id: messageId(agentId, 'escalation', Date.now().toString()),
        from: agentId as import('@flightdeck-ai/shared').AgentId,
        to: null, channel: 'escalations',
        content: `ESCALATION for task ${body.taskId}: ${body.reason}`,
        timestamp: new Date().toISOString(),
      };
      fd.sendMessage(msg, 'escalations');
      json(200, { status: 'escalated', taskId: body.taskId });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/learnings' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.content) { json(400, { error: 'Missing content' }); return true; }
      const learning = fd.learnings.append({ agentId, content: body.content, tags: body.tags ?? [], category: body.category });
      json(201, learning);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/learnings/search' && method === 'GET') {
    const query = url.searchParams.get('query');
    if (!query) { json(400, { error: 'Missing query parameter' }); return true; }
    json(200, fd.learnings.search(query));
    return true;
  }

  if (subPath === '/escalations' && method === 'GET') {
    const status = url.searchParams.get('status') as 'pending' | 'resolved' | undefined;
    json(200, fd.sqlite.listEscalations(status || undefined));
    return true;
  }

  if (subPath === '/escalations' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'lead';
      if (!body.title || !body.description) { json(400, { error: 'Missing title or description' }); return true; }
      const esc = fd.sqlite.createEscalation(agentId, body.title, body.description, body.priority);
      if (wsServer) wsServer.broadcast({ type: 'escalation:created', project: projectName, escalation: esc });
      json(201, esc);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/escalations\/\d+\/resolve$/) && method === 'POST') {
    try {
      const id = parseInt(subPath.split('/')[2], 10);
      const body = await readBody();
      if (!body.resolution) { json(400, { error: 'Missing resolution' }); return true; }
      const esc = fd.sqlite.resolveEscalation(id, body.resolution);
      if (!esc) { json(404, { error: 'Escalation not found' }); return true; }
      if (wsServer) wsServer.broadcast({ type: 'escalation:resolved', project: projectName, escalation: esc });
      json(200, { success: true, escalation: esc });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/suggestions' && method === 'GET') {
    const specId = url.searchParams.get('spec_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    json(200, fd.suggestions.list({ specId, status: status as any }));
    return true;
  }

  if (subPath.match(/^\/suggestions\/[^/]+\/approve$/) && method === 'POST') {
    const id = subPath.split('/')[2];
    const s = fd.suggestions.updateStatus(id, 'approved');
    if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    return true;
  }

  if (subPath.match(/^\/suggestions\/[^/]+\/reject$/) && method === 'POST') {
    const id = subPath.split('/')[2];
    const s = fd.suggestions.updateStatus(id, 'rejected');
    if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    return true;
  }

  return false;
}

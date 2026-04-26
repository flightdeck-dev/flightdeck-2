import type { ProjectScopedDeps } from './types.js';

export async function handleMemoryRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, json, readBody, req, url } = deps;

  if (subPath === '/memory' && method === 'GET') {
    const files = fd.memory.list();
    const result = files.map(f => {
      const content = fd.memory.read(f);
      const size = content ? Buffer.byteLength(content, 'utf-8') : 0;
      return { filename: f, size, preview: content ? content.slice(0, 200) : '' };
    });
    json(200, { files: result });
    return true;
  }

  if (subPath === '/memory/daily-log' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.entry) { json(400, { error: 'Missing entry' }); return true; }
      fd.memory.appendDailyLog(body.entry);
      json(200, { status: 'logged', filename: fd.memory.getDailyLogFilename() });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/memory\/[^/]+$/) && method === 'GET') {
    const filename = decodeURIComponent(subPath.split('/')[2]);
    const content = fd.memory.read(filename);
    if (content === null) { json(404, { error: `Memory file not found: ${filename}` }); return true; }
    json(200, { content });
    return true;
  }

  if (subPath.match(/^\/memory\/[^/]+$/) && method === 'PUT') {
    const filename = decodeURIComponent(subPath.split('/')[2]);
    try {
      const body = await readBody();
      fd.writeMemory(filename, body.content);
      json(200, { status: 'written', path: `memory/${filename}` });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/cost' && method === 'GET') {
    const costCallerId = req.headers['x-agent-id'] as string;
    if (costCallerId) {
      const costCaller = fd.sqlite.getAgent(costCallerId as import('@flightdeck-ai/shared').AgentId);
      if (costCaller && costCaller.role !== 'lead' && costCaller.role !== 'director') {
        json(403, { error: `Error: Agent '${costCallerId}' (role: ${costCaller.role}) cannot view cost reports. Only lead/director roles can view cost reports.` }); return true;
      }
    }
    json(200, { totalCost: fd.sqlite.getTotalCost(), byAgent: fd.sqlite.getCostByAgent(), byTask: fd.sqlite.getCostByTask() });
    return true;
  }

  if (subPath === '/token-usage' && method === 'GET') {
    json(200, { total: fd.sqlite.getTokenUsageTotal(), byAgent: fd.sqlite.getTokenUsageByAgent() });
    return true;
  }

  return false;
}

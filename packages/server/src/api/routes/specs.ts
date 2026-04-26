import type { ProjectScopedDeps } from './types.js';

export async function handleSpecRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, json, readBody, url, res } = deps;

  if (subPath === '/decisions' && method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
    json(200, fd.decisions.readAll().slice(0, limit));
    return true;
  }

  if (subPath === '/report' && method === 'GET') {
    try {
      const { DailyReport } = await import('../../reporting/DailyReport.js');
      const report = new DailyReport(fd.sqlite, fd.decisions);
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(report.generate({}));
    } catch { json(200, { report: 'No report available yet.' }); }
    return true;
  }

  if (subPath === '/specs' && method === 'GET') {
    json(200, fd.listSpecs());
    return true;
  }

  if (subPath.match(/^\/specs\/[^/]+$/) && method === 'GET') {
    const specFilename = decodeURIComponent(subPath.split('/')[2]);
    const spec = fd.specs.read(specFilename);
    if (spec) json(200, spec); else json(404, { error: 'Spec not found' });
    return true;
  }

  if (subPath === '/specs' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.title || !body.content) { json(400, { error: 'Missing title or content' }); return true; }
      const spec = fd.createSpec(body.title, body.content);
      json(201, spec);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/specs\/[^/]+\/cancel$/) && method === 'POST') {
    const specId = decodeURIComponent(subPath.split('/')[2]);
    const cancelled = fd.sqlite.cancelTasksBySpec(specId as any);
    json(200, { specId, cancelledTasks: cancelled });
    return true;
  }

  if (subPath === '/spec-changes' && method === 'GET') {
    json(200, fd.orchestrator.getRecentSpecChanges());
    return true;
  }

  if (subPath === '/threads' && method === 'GET') {
    json(200, fd.messages?.listThreads() ?? []);
    return true;
  }

  if (subPath === '/threads' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.originId && !body.origin_id) { json(400, { error: 'Missing originId' }); return true; }
      if (!fd.messages) { json(500, { error: 'MessageStore not available' }); return true; }
      const thread = fd.messages.createThread({ originId: body.originId ?? body.origin_id, title: body.title });
      json(201, thread);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/search/sessions' && method === 'GET') {
    const query = url.searchParams.get('query');
    if (!query) { json(400, { error: 'Missing query parameter' }); return true; }
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const { SessionStore } = await import('../../acp/SessionStore.js');
    const store = new SessionStore(projectName, fd.sqlite.db);
    const results = store.searchEvents(query, { limit });
    json(200, { count: results.length, results });
    return true;
  }

  if (subPath === '/search' && method === 'GET') {
    const q = url.searchParams.get('q');
    if (!q) { json(400, { error: 'Missing q parameter' }); return true; }
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;

    const allTasks = fd.sqlite.listTasks();
    const matchedTasks = allTasks.filter(t =>
      t.title.toLowerCase().includes(q.toLowerCase()) ||
      (t.description ?? '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);

    const allAgents = fd.sqlite.listAgents(true);
    const matchedAgents = allAgents.filter(a =>
      a.id.toLowerCase().includes(q.toLowerCase()) ||
      (a.role ?? '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);

    const matchedMessages = fd.messages?.searchMessages(q, { limit }) ?? [];

    const source = url.searchParams.get('source');
    const memoryResults: Array<{ source: string; filename: string; line: number; snippet: string }> = [];
    if (!source || source === 'memory') {
      try {
        const { readdirSync, readFileSync } = await import('node:fs');
        const { join: pjoin } = await import('node:path');
        const memDir = fd.project.subpath('memory');
        const searchDir = (dir: string) => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = pjoin(dir, entry.name);
              if (entry.isDirectory()) { searchDir(full); continue; }
              if (!entry.name.endsWith('.md')) continue;
              try {
                const content = readFileSync(full, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(q!.toLowerCase())) {
                    memoryResults.push({ source: 'memory', filename: full.replace(fd.project.subpath('.') + '/', '').replace('memory/', ''), line: i + 1, snippet: lines[i].slice(0, 200) });
                    if (memoryResults.length >= limit) break;
                  }
                }
              } catch {}
              if (memoryResults.length >= limit) break;
            }
          } catch {}
        };
        searchDir(memDir);
      } catch {}
    }

    const results = [
      ...matchedTasks.map(t => ({ source: 'task', id: t.id, title: t.title, state: t.state })),
      ...matchedAgents.map(a => ({ source: 'agent', id: a.id, role: a.role, status: a.status })),
      ...matchedMessages.map(m => ({ source: 'message', id: m.id, content: m.content.slice(0, 200) })),
      ...memoryResults,
    ];

    json(200, {
      results,
      tasks: matchedTasks.map(t => ({ id: t.id, title: t.title, state: t.state, type: 'task' as const })),
      agents: matchedAgents.map(a => ({ id: a.id, name: a.id, role: a.role, status: a.status, type: 'agent' as const })),
      messages: matchedMessages.map(m => ({ id: m.id, content: m.content.slice(0, 200), authorType: m.authorType, authorId: m.authorId, type: 'message' as const })),
      memory: memoryResults,
    });
    return true;
  }

  return false;
}

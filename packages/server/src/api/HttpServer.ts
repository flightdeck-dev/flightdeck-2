import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Flightdeck } from '../facade.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { WebhookNotifier } from '../integrations/WebhookNotifier.js';
import { leadResponseEvent } from '../integrations/WebhookNotifier.js';

export interface HttpServerDeps {
  projectManager: ProjectManager;
  leadManagers: Map<string, LeadManager>;
  port: number;
  corsOrigin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServers: Map<string, any>;
  /** Auth check function. Returns true if request was blocked (401 sent). */
  authCheck?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Webhook notifiers per project, for firing lead_response and agent_message events. */
  webhookNotifiers?: Map<string, WebhookNotifier>;
}

/**
 * Create the HTTP server with multi-project API routes.
 * All project routes are scoped under /api/projects/:name/*.
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const { projectManager, leadManagers, port, corsOrigin, wsServers, authCheck, webhookNotifiers } = deps;

  let modelCfg: InstanceType<typeof import('../agents/ModelConfig.js').ModelConfig> | null = null;
  let presetNames: string[] = [];
  let modRegistry: typeof import('../agents/ModelTiers.js').modelRegistry | null = null;
  let displayModule: typeof import('@flightdeck-ai/shared') | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serverDisplayConfig: any = null;

  const ensureModules = async () => {
    if (!modelCfg) {
      const { ModelConfig: MC, PRESET_NAMES } = await import('../agents/ModelConfig.js');
      modelCfg = new MC(process.cwd());
      presetNames = PRESET_NAMES;
    }
    if (!modRegistry) {
      modRegistry = (await import('../agents/ModelTiers.js')).modelRegistry;
    }
    if (!displayModule) {
      displayModule = await import('@flightdeck-ai/shared');
      serverDisplayConfig = { ...displayModule.DEFAULT_DISPLAY };
    }
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await ensureModules();
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    const MAX_BODY = 1024 * 1024;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readBody = (): Promise<any> => new Promise((resolve, reject) => {
      let size = 0;
      let data = '';
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
        data += chunk.toString();
      });
      req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // CORS
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Auth check
    if (authCheck && authCheck(req, res)) return;

    // ── Health ──
    if (url.pathname === '/health') {
      json(200, { status: 'ok', projects: projectManager.list() });
      return;
    }

    // ── Gateway state (for restart recovery) ──
    if (url.pathname === '/api/gateway/state' && method === 'GET') {
      const agents: Array<{ project: string; agentId: string; role: string; acpSessionId: string | null }> = [];
      for (const name of projectManager.list()) {
        const fd = projectManager.get(name);
        if (!fd) continue;
        for (const a of fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle')) {
          agents.push({ project: name, agentId: a.id, role: a.role, acpSessionId: null });
        }
      }
      json(200, agents);
      return;
    }

    // ── Project list / create ──
    if (url.pathname === '/api/projects' && method === 'GET') {
      json(200, { projects: projectManager.list().map(name => ({ name })) });
      return;
    }
    if (url.pathname === '/api/projects' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.name || typeof body.name !== 'string') { json(400, { error: 'Missing required field: name' }); return; }
        const name = body.name.trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) { json(400, { error: 'Project name must be alphanumeric (with - and _)' }); return; }
        if (projectManager.list().includes(name)) { json(409, { error: `Project "${name}" already exists` }); return; }
        projectManager.create(name);
        json(201, { name, message: `Project "${name}" created` });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
      return;
    }

    // ── Project-scoped routes: /api/projects/:name/* ──
    const m = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); res.end('Not found'); return; }

    const projectName = decodeURIComponent(m[1]);
    const subPath = m[2] || '/';

    // DELETE project
    if (subPath === '/' && method === 'DELETE') {
      if (projectManager.delete(projectName)) json(200, { message: `Project "${projectName}" deleted` });
      else json(404, { error: `Project "${projectName}" not found` });
      return;
    }

    const fd = projectManager.get(projectName);
    if (!fd) { json(404, { error: `Project "${projectName}" not found` }); return; }

    const wsServer = wsServers.get(projectName);
    const leadManager = leadManagers.get(projectName);
    const notifier = webhookNotifiers?.get(projectName);

    // ── Route dispatch ──

    if (subPath === '/status' && method === 'GET') {
      json(200, fd.status());
    } else if (subPath === '/messages' && method === 'GET') {
      const threadId = url.searchParams.get('thread_id') ?? undefined;
      const taskId = url.searchParams.get('task_id') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      json(200, (fd.chatMessages?.listMessages({ threadId, taskId, limit }) ?? []).reverse());
    } else if (subPath === '/messages' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.content || typeof body.content !== 'string') { json(400, { error: 'Missing required field: content' }); return; }
        const isAsync = url.searchParams.get('async') === 'true' || url.searchParams.get('async') === '1';
        let userMsg = null;
        if (fd.chatMessages) {
          userMsg = fd.chatMessages.createMessage({ threadId: null, parentId: null, taskId: null, authorType: 'user', authorId: 'http-api', content: body.content, metadata: null });
          if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: userMsg });
        }
        if (isAsync) {
          // Fire-and-forget: steer Lead in background, return immediately
          if (leadManager) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content } as any }).then(raw => {
              if (raw?.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
                if (fd.chatMessages) {
                  const leadMsg = fd.chatMessages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: raw.trim(), metadata: null });
                  if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
                }
                // Fire webhook for Lead response
                if (notifier) {
                  notifier.notify(leadResponseEvent(projectName, raw.trim(), body.content));
                }
              }
            }).catch(err => { console.error('Failed to steer Lead (async):', err instanceof Error ? err.message : String(err)); });
          }
          json(202, { message: userMsg, status: 'accepted' });
        } else {
          let leadResponse: string | null = null;
          let leadMsg = null;
          if (leadManager) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const raw = await leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content } as any });
              if (raw?.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
                leadResponse = raw.trim();
                if (fd.chatMessages) {
                  leadMsg = fd.chatMessages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: leadResponse, metadata: null });
                  if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
                }
                // Fire webhook for Lead response
                if (notifier) {
                  notifier.notify(leadResponseEvent(projectName, leadResponse, body.content));
                }
              }
            } catch (err: unknown) { console.error('Failed to steer Lead:', err instanceof Error ? err.message : String(err)); }
          }
          json(200, { message: userMsg, response: leadMsg ?? leadResponse });
        }
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/tasks' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.title || typeof body.title !== 'string') { json(400, { error: 'Missing required field: title' }); return; }
        const task = fd.addTask({ title: body.title, description: body.description, role: body.role || 'worker' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: task as any });
        json(201, task);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/tasks' && method === 'GET') {
      json(200, fd.listTasks());
    } else if (subPath.match(/^\/tasks\/[^/]+$/) && method === 'GET') {
      const taskId = subPath.split('/').pop()!;
      const task = fd.listTasks().find(t => t.id === taskId);
      if (task) json(200, task); else json(404, { error: 'Task not found' });
    } else if (subPath === '/agents' && method === 'GET') {
      json(200, fd.listAgents());
    } else if (subPath === '/decisions' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      json(200, fd.decisions.readAll().slice(0, limit));
    } else if (subPath === '/report' && method === 'GET') {
      try {
        const { DailyReport } = await import('../reporting/DailyReport.js');
        const report = new DailyReport(fd.sqlite, fd.decisions);
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(report.generate({}));
      } catch { json(200, { report: 'No report available yet.' }); }
    } else if (subPath === '/threads' && method === 'GET') {
      json(200, fd.chatMessages?.listThreads() ?? []);
    } else if (subPath === '/models' && method === 'GET') {
      json(200, { roles: modelCfg!.getRoleConfigs(), presets: presetNames });
    } else if (subPath === '/models/available' && method === 'GET') {
      const result: Record<string, unknown> = {};
      for (const rt of modRegistry!.getRuntimes()) result[rt] = modRegistry!.getModelsGrouped(rt);
      json(200, result);
    } else if (subPath.startsWith('/models/preset/') && method === 'POST') {
      const preset = subPath.split('/').pop()!;
      if (modelCfg!.applyPreset(preset)) json(200, { success: true, roles: modelCfg!.getRoleConfigs() });
      else json(400, { error: `Unknown preset: ${preset}. Available: ${presetNames.join(', ')}` });
    } else if (subPath === '/display' && method === 'GET') {
      json(200, serverDisplayConfig!);
    } else if (subPath === '/display' && method === 'PUT') {
      try {
        const body = await readBody();
        if (!displayModule!.isValidDisplayConfig(body)) { json(400, { error: 'Invalid display config' }); return; }
        serverDisplayConfig = displayModule!.mergeDisplayConfig(serverDisplayConfig, body);
        if (wsServer) wsServer.broadcast({ type: 'display:config', config: serverDisplayConfig });
        json(200, serverDisplayConfig);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath.match(/^\/display\/preset\/[^/]+$/) && method === 'POST') {
      const preset = subPath.split('/').pop()!;
      if (preset in displayModule!.DISPLAY_PRESETS) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverDisplayConfig = { ...(displayModule!.DISPLAY_PRESETS as any)[preset] };
        json(200, serverDisplayConfig);
      } else json(400, { error: `Unknown preset: ${preset}. Available: ${displayModule!.DISPLAY_PRESET_NAMES.join(', ')}` });
    } else if (subPath.match(/^\/models\/[^/]+$/) && method === 'PUT') {
      const role = subPath.split('/').pop()!;
      try {
        const body = await readBody();
        if (body.runtime) modelCfg!.setRole(role, `${body.runtime}:${body.model ?? 'medium'}`);
        else if (body.model) modelCfg!.setRole(role, body.model);
        else { json(400, { error: 'Provide runtime and/or model' }); return; }
        json(200, { success: true, config: modelCfg!.getRoleConfig(role) });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid request body' }); }
    } else if (subPath === '/orchestrator/pause' && method === 'POST') {
      fd.orchestrator.pause(); json(200, { paused: true });
    } else if (subPath === '/orchestrator/resume' && method === 'POST') {
      fd.orchestrator.resume(); json(200, { paused: false });
    } else if (subPath === '/orchestrator/status' && method === 'GET') {
      json(200, { paused: fd.orchestrator.paused, running: fd.orchestrator.isRunning() });
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });

  return httpServer;
}

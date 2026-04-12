import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Flightdeck } from '../facade.js';
import type { LeadManager } from '../lead/LeadManager.js';

export interface HttpServerDeps {
  fd: Flightdeck;
  projectName: string;
  port: number;
  corsOrigin: string;
  leadManager: LeadManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WS server type from untyped API
  wsServer: any;
}

/**
 * Create the HTTP server with all API route handlers.
 * Returns the raw http.Server (not yet listening).
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const { fd, projectName, port, corsOrigin, leadManager, wsServer } = deps;

  // Lazy-loaded modules (resolved on first request)
  let modelCfg: InstanceType<typeof import('../agents/ModelConfig.js').ModelConfig> | null = null;
  let presetNames: string[] = [];
  let modRegistry: typeof import('../agents/ModelTiers.js').modelRegistry | null = null;
  let displayModule: typeof import('@flightdeck-ai/shared') | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- display config shape managed at runtime
  let serverDisplayConfig: any = null;

  const ensureModules = async () => {
    if (!modelCfg) {
      const { ModelConfig: ModelCfg, PRESET_NAMES } = await import('../agents/ModelConfig.js');
      modelCfg = new ModelCfg(process.cwd());
      presetNames = PRESET_NAMES;
    }
    if (!modRegistry) {
      const { modelRegistry } = await import('../agents/ModelTiers.js');
      modRegistry = modelRegistry;
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

    // Helper to read JSON body (1MB limit)
    const MAX_BODY = 1024 * 1024; // 1MB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic body parser returns arbitrary JSON
    const readBody = (): Promise<any> => new Promise((resolve, reject) => {
      let size = 0;
      let data = '';
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(new Error('Body too large'));
          return;
        }
        data += chunk.toString();
      });
      req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/health') {
      json(200, { status: 'ok', project: projectName });
    } else if (url.pathname === '/api/status' || url.pathname === '/status') {
      json(200, fd.status());
    } else if (url.pathname === '/api/messages' && method === 'GET') {
      const threadId = url.searchParams.get('thread_id') ?? undefined;
      const taskId = url.searchParams.get('task_id') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      const msgs = fd.chatMessages?.listMessages({ threadId, taskId, limit }) ?? [];
      json(200, msgs.reverse());
    } else if (url.pathname === '/api/messages' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.content || typeof body.content !== 'string') { json(400, { error: 'Missing required field: content' }); return; }
        // Store user message
        let userMsg = null;
        if (fd.chatMessages) {
          userMsg = fd.chatMessages.createMessage({
            threadId: null,
            parentId: null,
            taskId: null,
            authorType: 'user',
            authorId: 'http-api',
            content: body.content,
            metadata: null,
          });
          if (wsServer) wsServer.broadcast({ type: 'chat:message', message: userMsg });
        }
        // Steer Lead
        let leadResponse: string | null = null;
        let leadMsg = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
          const raw = await leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content } as any });
          if (raw && raw.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
            leadResponse = raw.trim();
            if (fd.chatMessages) {
              leadMsg = fd.chatMessages.createMessage({
                threadId: null,
                parentId: userMsg?.id ?? null,
                taskId: null,
                authorType: 'lead',
                authorId: 'lead',
                content: leadResponse,
                metadata: null,
              });
              if (wsServer) wsServer.broadcast({ type: 'chat:message', message: leadMsg });
            }
          }
        } catch (err: unknown) {
          console.error('Failed to steer Lead:', err instanceof Error ? err.message : String(err));
        }
        json(200, { message: userMsg, response: leadMsg ?? leadResponse });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (url.pathname === '/api/tasks' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.title || typeof body.title !== 'string') { json(400, { error: 'Missing required field: title' }); return; }
        const role = body.role || 'worker';
        const task = fd.addTask({ title: body.title, description: body.description, role });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
        if (wsServer) wsServer.broadcast({ type: 'chat:message', message: task as any });
        json(201, task);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (url.pathname === '/api/tasks' && method === 'GET') {
      json(200, fd.listTasks());
    } else if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && method === 'GET') {
      const taskId = url.pathname.split('/').pop()!;
      const tasks = fd.listTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task) json(200, task);
      else json(404, { error: 'Task not found' });
    } else if (url.pathname === '/api/agents' && method === 'GET') {
      json(200, fd.listAgents());
    } else if (url.pathname === '/api/decisions' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      const decisions = fd.decisions.readAll().slice(0, limit);
      json(200, decisions);
    } else if (url.pathname === '/api/report' && method === 'GET') {
      try {
        const { DailyReport } = await import('../reporting/DailyReport.js');
        const report = new DailyReport(fd.sqlite, fd.decisions);
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(report.generate({}));
      } catch { json(200, { report: 'No report available yet.' }); }
    } else if (url.pathname === '/api/threads' && method === 'GET') {
      const threads = fd.chatMessages?.listThreads() ?? [];
      json(200, threads);
    } else if (url.pathname === '/api/models' && method === 'GET') {
      json(200, { roles: modelCfg!.getRoleConfigs(), presets: presetNames });
    } else if (url.pathname === '/api/models/available' && method === 'GET') {
      const result: Record<string, unknown> = {};
      for (const rt of modRegistry!.getRuntimes()) {
        result[rt] = modRegistry!.getModelsGrouped(rt);
      }
      json(200, result);
    } else if (url.pathname.startsWith('/api/models/preset/') && method === 'POST') {
      const preset = url.pathname.split('/').pop()!;
      if (modelCfg!.applyPreset(preset)) {
        json(200, { success: true, roles: modelCfg!.getRoleConfigs() });
      } else {
        json(400, { error: `Unknown preset: ${preset}. Available: ${presetNames.join(', ')}` });
      }
    } else if (url.pathname === '/api/display' && method === 'GET') {
      json(200, serverDisplayConfig!);
    } else if (url.pathname === '/api/display' && method === 'PUT') {
      try {
        const body = await readBody();
        if (!displayModule!.isValidDisplayConfig(body)) { json(400, { error: 'Invalid display config' }); return; }
        serverDisplayConfig = displayModule!.mergeDisplayConfig(serverDisplayConfig, body);
        // Broadcast updated server config to all WS clients
        if (wsServer) {
          wsServer.broadcast({ type: 'display:config', config: serverDisplayConfig });
        }
        json(200, serverDisplayConfig);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (url.pathname.match(/^\/api\/display\/preset\/[^/]+$/) && method === 'POST') {
      const preset = url.pathname.split('/').pop()!;
      if (preset in displayModule!.DISPLAY_PRESETS) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-checked non-null
        serverDisplayConfig = { ...(displayModule!.DISPLAY_PRESETS as any)[preset] };
        json(200, serverDisplayConfig);
      } else {
        json(400, { error: `Unknown preset: ${preset}. Available: ${displayModule!.DISPLAY_PRESET_NAMES.join(', ')}` });
      }
    } else if (url.pathname.match(/^\/api\/models\/[^/]+$/) && method === 'PUT') {
      const role = url.pathname.split('/').pop()!;
      try {
        const body = await readBody();
        if (body.runtime) modelCfg!.setRole(role, `${body.runtime}:${body.model ?? 'medium'}`);
        else if (body.model) modelCfg!.setRole(role, body.model);
        else { json(400, { error: 'Provide runtime and/or model' }); return; }
        json(200, { success: true, config: modelCfg!.getRoleConfig(role) });
      } catch (e: unknown) {
        json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
      }
    } else if (url.pathname === '/api/orchestrator/pause' && method === 'POST') {
      fd.orchestrator.pause();
      json(200, { paused: true });
    } else if (url.pathname === '/api/orchestrator/resume' && method === 'POST') {
      fd.orchestrator.resume();
      json(200, { paused: false });
    } else if (url.pathname === '/api/orchestrator/status' && method === 'GET') {
      json(200, { paused: fd.orchestrator.paused, running: fd.orchestrator.isRunning() });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return httpServer;
}

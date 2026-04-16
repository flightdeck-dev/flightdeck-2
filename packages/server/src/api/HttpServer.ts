import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Flightdeck } from '../facade.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { WebhookNotifier } from '../integrations/WebhookNotifier.js';
import { leadResponseEvent } from '../integrations/WebhookNotifier.js';

import type { AgentManager } from '../agents/AgentManager.js';
import type { AgentRole } from '@flightdeck-ai/shared';
import type { CronStore } from '../cron/CronStore.js';

export interface HttpServerDeps {
  projectManager: ProjectManager;
  leadManagers: Map<string, LeadManager>;
  agentManagers?: Map<string, AgentManager>;
  port: number;
  corsOrigin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServers: Map<string, any>;
  /** Auth check function. Returns true if request was blocked (401 sent). */
  authCheck?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Webhook notifiers per project, for firing lead_response and agent_message events. */
  webhookNotifiers?: Map<string, WebhookNotifier>;
  /** Cron stores per project. */
  cronStores?: Map<string, CronStore>;
}

/**
 * Create the HTTP server with multi-project API routes.
 * All project routes are scoped under /api/projects/:name/*.
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const { projectManager, leadManagers, port, corsOrigin, wsServers, authCheck, webhookNotifiers, agentManagers, cronStores } = deps;

  let modelCfgCache = new Map<string, InstanceType<typeof import('../agents/ModelConfig.js').ModelConfig>>();
  let presetNames: string[] = [];
  let modRegistry: typeof import('../agents/ModelTiers.js').modelRegistry | null = null;
  let displayModule: typeof import('@flightdeck-ai/shared') | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serverDisplayConfig: any = null;

  const ensureModules = async () => {
    if (presetNames.length === 0) {
      const { PRESET_NAMES } = await import('../agents/ModelConfig.js');
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

  /** Get or create a per-project ModelConfig instance. */
  const getModelConfig = async (fd: Flightdeck, projName: string): Promise<InstanceType<typeof import('../agents/ModelConfig.js').ModelConfig>> => {
    let mc = modelCfgCache.get(projName);
    if (!mc) {
      const { ModelConfig: MC } = await import('../agents/ModelConfig.js');
      mc = new MC(fd.project.subpath('.'));
      modelCfgCache.set(projName, mc);
    }
    return mc;
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
          agents.push({ project: name, agentId: a.id, role: a.role, acpSessionId: a.acpSessionId });
        }
      }
      json(200, agents);
      return;
    }

    // ── Project list / create ──
    if (url.pathname === '/api/projects' && method === 'GET') {
      const summaries = projectManager.list().map(name => {
        try {
          const fd = projectManager.get(name);
          if (!fd) return { name };
          const stats = fd.getTaskStats();
          return {
            name,
            governance: fd.governance.governanceConfig.profile ?? 'autonomous',
            agentCount: fd.listAgents().length,
            taskStats: stats,
            totalCost: fd.sqlite.getTotalCost(),
          };
        } catch {
          return { name };
        }
      });
      json(200, { projects: summaries });
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
      json(200, (fd.messages?.listMessages({ threadId, taskId, limit }) ?? []).reverse());
    } else if (subPath === '/messages' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.content || typeof body.content !== 'string') { json(400, { error: 'Missing required field: content' }); return; }
        const isAsync = url.searchParams.get('async') === 'true' || url.searchParams.get('async') === '1';
        let userMsg = null;
        if (fd.messages) {
          userMsg = fd.messages.createMessage({ threadId: null, parentId: null, taskId: null, authorType: 'user', authorId: 'http-api', content: body.content, metadata: null });
          if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: userMsg });
        }
        if (isAsync) {
          // Fire-and-forget: steer Lead in background, return immediately
          if (leadManager) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content } as any }).then(raw => {
              if (raw?.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
                if (fd.messages) {
                  const leadMsg = fd.messages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: raw.trim(), metadata: null });
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
                if (fd.messages) {
                  leadMsg = fd.messages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: leadResponse, metadata: null });
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
        const task = fd.addTask({ title: body.title, description: body.description, role: body.role || 'worker', needsReview: body.needsReview });
        if (wsServer) {
          wsServer.broadcast({ type: 'state:update' as any, stats: fd.getTaskStats() } as any);
        }
        json(201, task);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/tasks' && method === 'GET') {
      json(200, fd.listTasks());
    } else if (subPath.match(/^\/tasks\/[^/]+$/) && method === 'GET') {
      const taskId = subPath.split('/').pop()!;
      const task = fd.listTasks().find(t => t.id === taskId);
      if (task) json(200, task); else json(404, { error: 'Task not found' });
    } else if (subPath.match(/^\/tasks\/[^/]+\/comments$/) && method === 'POST') {
      // POST /api/projects/:name/tasks/:id/comments — broadcast a pre-created task comment
      try {
        const body = await readBody();
        if (!body.message) { json(400, { error: 'Missing required field: message' }); return; }
        const taskId = subPath.split('/')[2];
        if (wsServer) {
          wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: body.message });
        }
        json(200, { status: 'broadcast' });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/tool-events' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.toolName) { json(400, { error: 'Missing required field: toolName' }); return; }
        if (wsServer) {
          wsServer.broadcast({ type: 'tool:event', project: projectName, ...body });
        }
        json(200, { status: 'broadcast' });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/agents' && method === 'GET') {
      const includeRetired = url.searchParams.get('includeRetired') === 'true';
      json(200, fd.listAgents(includeRetired));
    } else if (subPath === '/agents/spawn' && method === 'POST') {
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available for this project' }); return; }
      try {
        const body = await readBody();
        if (!body.role) { json(400, { error: 'Missing required field: role' }); return; }
        // Resolve per-role runtime from project config
        let resolvedRuntime = body.runtime;
        if (!resolvedRuntime) {
          try {
            const { ModelConfig } = await import('../agents/ModelConfig.js');
            const mc = new ModelConfig(fd.project.subpath('.'));
            resolvedRuntime = mc.getRoleConfig(body.role).runtime;
          } catch { /* fallback to adapter default */ }
        }
        const newAgent = await am.spawnAgent({
          role: body.role as AgentRole,
          model: body.model,
          runtime: resolvedRuntime,
          task: body.task,
          cwd: body.cwd ?? fd.project.subpath('.'),
          projectName,
        });
        json(201, newAgent);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'Body too large') json(413, { error: msg });
        else if (msg === 'Invalid JSON') json(400, { error: msg });
        else json(500, { error: `Failed to spawn agent: ${msg}` });
      }
    } else if (subPath.match(/^\/agents\/[^/]+\/terminate$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        await am.terminateAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, { success: true });
      } catch (e: unknown) { json(500, { error: `Failed to terminate agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/restart$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        const restarted = await am.restartAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, restarted);
      } catch (e: unknown) { json(500, { error: `Failed to restart agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/interrupt$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        const body = await readBody();
        if (!body.message) { json(400, { error: 'Missing required field: message' }); return; }
        await am.interruptAgent(agentId as import('@flightdeck-ai/shared').AgentId, body.message);
        json(200, { success: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'Body too large' || msg === 'Invalid JSON') json(400, { error: msg });
        else json(500, { error: `Failed to interrupt agent: ${msg}` });
      }
    } else if (subPath.match(/^\/agents\/[^/]+\/send$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        const body = await readBody();
        if (!body.message) { json(400, { error: 'Missing required field: message' }); return; }
        await am.sendToAgent(agentId as import('@flightdeck-ai/shared').AgentId, body.message);
        json(200, { success: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'Body too large' || msg === 'Invalid JSON') json(400, { error: msg });
        else json(500, { error: `Failed to send to agent: ${msg}` });
      }
    } else if (subPath.match(/^\/agents\/[^/]+\/hibernate$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        await am.hibernateAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, { success: true });
      } catch (e: unknown) { json(500, { error: `Failed to hibernate agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/wake$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        const woken = await am.wakeAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, woken);
      } catch (e: unknown) { json(500, { error: `Failed to wake agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/retire$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        await am.retireAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, { success: true });
      } catch (e: unknown) { json(500, { error: `Failed to retire agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/unretire$/) && method === 'POST') {
      const agentId = subPath.split('/')[2];
      try {
        fd.sqlite.unretireAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, { success: true });
      } catch (e: unknown) { json(500, { error: `Failed to unretire agent: ${e instanceof Error ? e.message : String(e)}` }); }
    } else if (subPath.match(/^\/agents\/[^/]+\/model$/) && method === 'PUT') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      try {
        const body = await readBody();
        if (!body.model) { json(400, { error: 'Missing required field: model' }); return; }
        await am.setAgentModel(agentId as import('@flightdeck-ai/shared').AgentId, body.model);
        json(200, { success: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        json(500, { error: `Failed to set agent model: ${msg}` });
      }
    } else if (subPath.match(/^\/agents\/[^/]+\/output$/) && method === 'GET') {
      const agentId = subPath.split('/')[2];
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available' }); return; }
      const tail = parseInt(url.searchParams.get('tail') ?? '50', 10) || 50;
      try {
        const output = am.getAgentOutput(agentId as import('@flightdeck-ai/shared').AgentId, tail);
        json(200, output);
      } catch (e: unknown) { json(404, { error: e instanceof Error ? e.message : String(e) }); }
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
    } else if (subPath === '/specs' && method === 'GET') {
      json(200, fd.listSpecs());
    } else if (subPath.match(/^\/specs\/[^/]+$/) && method === 'GET') {
      const specFilename = decodeURIComponent(subPath.split('/')[2]);
      const spec = fd.specs.read(specFilename);
      if (spec) json(200, spec);
      else json(404, { error: 'Spec not found' });
    } else if (subPath === '/threads' && method === 'GET') {
      json(200, fd.messages?.listThreads() ?? []);
    } else if (subPath === '/search/sessions' && method === 'GET') {
      const query = url.searchParams.get('query');
      if (!query) { json(400, { error: 'Missing query parameter' }); return; }
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const { SessionStore } = await import('../acp/SessionStore.js');
      const store = new SessionStore(projectName, fd.sqlite.db);
      const results = store.searchEvents(query, { limit });
      json(200, { count: results.length, results });
    } else if (subPath === '/search' && method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q) { json(400, { error: 'Missing q parameter' }); return; }
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
      const pattern = `%${q}%`;

      // Search tasks
      const allTasks = fd.sqlite.listTasks();
      const matchedTasks = allTasks.filter(t =>
        t.title.toLowerCase().includes(q.toLowerCase()) ||
        (t.description ?? '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, limit);

      // Search agents
      const allAgents = fd.sqlite.listAgents(true);
      const matchedAgents = allAgents.filter(a =>
        a.id.toLowerCase().includes(q.toLowerCase()) ||
        (a.role ?? '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, limit);

      // Search messages (uses FTS5)
      const matchedMessages = fd.messages?.searchMessages(q, { limit }) ?? [];

      json(200, {
        tasks: matchedTasks.map(t => ({ id: t.id, title: t.title, state: t.state, type: 'task' as const })),
        agents: matchedAgents.map(a => ({ id: a.id, name: a.id, role: a.role, status: a.status, type: 'agent' as const })),
        messages: matchedMessages.map(m => ({ id: m.id, content: m.content.slice(0, 200), authorType: m.authorType, authorId: m.authorId, type: 'message' as const })),
      });
    } else if (subPath === '/models' && method === 'GET') {
      const mc = await getModelConfig(fd, projectName);
      json(200, { roles: mc.getRoleConfigs(), presets: presetNames });
    } else if (subPath === '/models/available' && method === 'GET') {
      const result: Record<string, unknown> = {};
      for (const rt of modRegistry!.getRuntimes()) result[rt] = modRegistry!.getModelsGrouped(rt);
      json(200, result);
    } else if (subPath === '/runtimes' && method === 'GET') {
      const { RUNTIME_REGISTRY } = await import('../agents/runtimes.js');
      const runtimes = Object.entries(RUNTIME_REGISTRY).map(([id, r]) => ({
        id, name: r.name, command: r.command, supportsAcp: r.supportsAcp, adapter: r.adapter,
        systemPromptMethod: r.systemPromptMethod, supportsSessionLoad: r.supportsSessionLoad,
        supportsModelDiscovery: r.supportsModelDiscovery !== false,
        icon: r.icon, docsUrl: r.docsUrl, setupLinks: r.setupLinks,
        loginInstructions: r.loginInstructions, installHint: r.installHint,
        disabledByDefault: r.disabledByDefault ?? false,
      }));
      json(200, runtimes);
    } else if (subPath.match(/^\/runtimes\/([^/]+)\/test$/) && method === 'POST') {
      const runtimeId = subPath.match(/^\/runtimes\/([^/]+)\/test$/)![1];
      const { RUNTIME_REGISTRY } = await import('../agents/runtimes.js');
      const rt = RUNTIME_REGISTRY[runtimeId];
      if (!rt) { json(404, { error: `Unknown runtime: ${runtimeId}` }); return; }
      try {
        const { execFileSync } = await import('node:child_process');
        // Check if binary exists
        try {
          execFileSync('which', [rt.command], { stdio: 'pipe', timeout: 5000 });
        } catch {
          json(200, { success: false, installed: false, message: `Binary "${rt.command}" not found on PATH` });
          return;
        }
        // Try getting version
        let version: string | undefined;
        try {
          version = execFileSync(rt.command, ['--version'], { stdio: 'pipe', timeout: 10000 }).toString().trim().split('\n')[0];
        } catch { /* version check optional */ }
        json(200, { success: true, installed: true, version, message: `${rt.name} is installed${version ? ` (${version})` : ''}` });
      } catch (e: unknown) {
        json(500, { error: e instanceof Error ? e.message : 'Test failed' });
      }
    } else if (subPath.match(/^\/runtimes\/([^/]+)\/discover$/) && method === 'POST') {
      const runtimeId = subPath.match(/^\/runtimes\/([^/]+)\/discover$/)![1];
      try {
        const { discoverRuntimeModels } = await import('../agents/AcpAdapter.js');
        const models = await discoverRuntimeModels(runtimeId);
        json(200, { runtime: runtimeId, models });
      } catch (e: unknown) {
        json(500, { error: e instanceof Error ? e.message : String(e) });
      }
    } else if (subPath === '/role-preference' && method === 'GET') {
      const { readFileSync: rfs, existsSync: efs } = await import('node:fs');
      const { join: pjoin } = await import('node:path');
      const prefPath = pjoin(fd.project.subpath('.'), 'role-preference.md');
      if (efs(prefPath)) {
        json(200, { content: rfs(prefPath, 'utf-8') });
      } else {
        json(200, { content: '' });
      }
    } else if (subPath === '/role-preference' && method === 'PUT') {
      try {
        const body = await readBody();
        if (typeof body.content !== 'string') { json(400, { error: 'Missing content field' }); return; }
        const { writeTextAtomicSync: wtas } = await import('../infra/json-files.js');
        const { join: pjoin } = await import('node:path');
        const prefPath = pjoin(fd.project.subpath('.'), 'role-preference.md');
        wtas(prefPath, body.content);
        json(200, { success: true });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    } else if (subPath === '/roles' && method === 'GET') {
      const mc = await getModelConfig(fd, projectName);
      const roleConfigs = mc.getRoleConfigs();
      const { RoleRegistry } = await import('../roles/RoleRegistry.js');
      const registry = new RoleRegistry(projectName);
      // Discover repo roles if cwd available
      const cwd = fd.project.getConfig().cwd;
      if (cwd) registry.discoverRepoRoles(cwd);
      const roles = registry.list().map(r => {
        const rc = roleConfigs.find(c => c.role === r.id);
        return {
          id: r.id, name: r.name, description: r.description, icon: r.icon, color: r.color,
          source: 'built-in' as string, // TODO: distinguish global/project/repo
          enabledModels: rc?.enabledModels ?? [],
          permissions: r.permissions,
          instructions: r.instructions,
        };
      });
      json(200, roles);
    } else if (subPath.match(/^\/roles\/[^/]+\/models$/) && method === 'PUT') {
      const roleId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (!Array.isArray(body.models)) { json(400, { error: 'Expected { models: [...] }' }); return; }
        const mc = await getModelConfig(fd, projectName);
        mc.setRoleEnabledModels(roleId, body.models);
        modelCfgCache.delete(projectName);
        json(200, { success: true, enabledModels: mc.getRoleEnabledModels(roleId) });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    } else if (subPath.match(/^\/roles\/[^/]+\/prompt$/) && method === 'PUT') {
      const roleId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (typeof body.content !== 'string') { json(400, { error: 'Missing content field' }); return; }
        // Only allow editing project-level roles
        const { writeTextAtomicSync: wtas } = await import('../infra/json-files.js');
        const { join: pjoin } = await import('node:path');
        const { mkdirSync, existsSync: efs } = await import('node:fs');
        const { FD_HOME: fdHome } = await import('../cli/constants.js');
        const rolesDir = pjoin(fdHome, 'projects', projectName, 'roles');
        mkdirSync(rolesDir, { recursive: true });
        // Write the role .md with frontmatter preserved + new body
        const { RoleRegistry } = await import('../roles/RoleRegistry.js');
        const registry = new RoleRegistry(projectName);
        const existing = registry.get(roleId);
        const frontmatter = `---\nid: ${roleId}\nname: ${existing?.name ?? roleId}\ndescription: ${existing?.description ?? ''}\nicon: ${existing?.icon ?? '🔧'}\ncolor: "${existing?.color ?? '#888888'}"\npermissions:\n${Object.entries(existing?.permissions ?? {}).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n---\n`;
        wtas(pjoin(rolesDir, `${roleId}.md`), frontmatter + body.content);
        json(200, { success: true });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    } else if (subPath === '/roles' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.id || !body.name) { json(400, { error: 'Missing required fields: id, name' }); return; }
        const { writeTextAtomicSync: wtas } = await import('../infra/json-files.js');
        const { join: pjoin } = await import('node:path');
        const { mkdirSync } = await import('node:fs');
        const { FD_HOME: fdHome } = await import('../cli/constants.js');
        const rolesDir = pjoin(fdHome, 'projects', projectName, 'roles');
        mkdirSync(rolesDir, { recursive: true });
        const frontmatter = `---\nid: ${body.id}\nname: ${body.name}\ndescription: ${body.description ?? ''}\nicon: ${body.icon ?? '🔧'}\ncolor: "${body.color ?? '#888888'}"\npermissions:\n  task_claim: true\n  task_submit: true\n  escalate: true\n---\n`;
        wtas(pjoin(rolesDir, `${body.id}.md`), frontmatter + (body.instructions ?? `You are a ${body.name} agent. Complete your assigned tasks.`));
        json(201, { success: true, id: body.id });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    } else if (subPath.match(/^\/roles\/[^/]+$/) && method === 'DELETE') {
      const roleId = subPath.split('/')[2];
      try {
        const { join: pjoin } = await import('node:path');
        const { existsSync: efs, unlinkSync } = await import('node:fs');
        const { FD_HOME: fdHome } = await import('../cli/constants.js');
        const rolePath = pjoin(fdHome, 'projects', projectName, 'roles', `${roleId}.md`);
        if (!efs(rolePath)) { json(404, { error: `Role '${roleId}' not found at project level` }); return; }
        unlinkSync(rolePath);
        json(200, { success: true });
      } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : 'Failed to delete role' }); }
    } else if (subPath.startsWith('/models/preset/') && method === 'POST') {
      const preset = subPath.split('/').pop()!;
      const mc = await getModelConfig(fd, projectName);
      if (mc.applyPreset(preset)) json(200, { success: true, roles: mc.getRoleConfigs() });
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
        const mc = await getModelConfig(fd, projectName);
        if (body.runtime) mc.setRole(role, `${body.runtime}:${body.model ?? 'medium'}`);
        else if (body.model) mc.setRole(role, body.model);
        else { json(400, { error: 'Provide runtime and/or model' }); return; }
        // Invalidate cache so next read picks up changes
        modelCfgCache.delete(projectName);
        json(200, { success: true, config: mc.getRoleConfig(role) });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid request body' }); }
    } else if (subPath === '/orchestrator/pause' && method === 'POST') {
      fd.orchestrator.pause(); json(200, { paused: true });
    } else if (subPath === '/orchestrator/resume' && method === 'POST') {
      fd.orchestrator.resume(); json(200, { paused: false });
    } else if (subPath === '/orchestrator/status' && method === 'GET') {
      json(200, { paused: fd.orchestrator.paused, running: fd.orchestrator.isRunning() });
    } else if (subPath === '/notifications' && method === 'GET') {
      const cfg = fd.project.getConfig();
      json(200, cfg.notifications ?? { webhooks: [] });
    } else if (subPath === '/notifications' && method === 'PUT') {
      try {
        const body = await readBody();
        if (!body.webhooks || !Array.isArray(body.webhooks)) { json(400, { error: 'Expected { webhooks: [...] }' }); return; }
        // Persist to project config
        const cfg = fd.project.getConfig();
        cfg.notifications = { webhooks: body.webhooks };
        fd.project.setConfig(cfg);
        // Hot-reload into active notifier
        const activeNotifier = notifier ?? webhookNotifiers?.get(projectName) ?? null;
        if (activeNotifier) {
          activeNotifier.setWebhooks(body.webhooks);
        } else {
          // Create notifier if orchestrator has one now
          const orchNotifier = fd.orchestrator.getWebhookNotifier();
          if (orchNotifier) {
            orchNotifier.setWebhooks(body.webhooks);
            webhookNotifiers?.set(projectName, orchNotifier);
          }
        }
        json(200, { notifications: cfg.notifications, active: true });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/config' && method === 'PUT') {
      try {
        const body = await readBody();
        const cfg = fd.project.getConfig();
        if (body.governance !== undefined) {
          const { GOVERNANCE_PROFILES } = await import('@flightdeck-ai/shared');
          if (!GOVERNANCE_PROFILES.includes(body.governance)) { json(400, { error: `Invalid governance. Options: ${GOVERNANCE_PROFILES.join(', ')}` }); return; }
          cfg.governance = body.governance;
        }
        if (body.heartbeatEnabled !== undefined) {
          (cfg as any).heartbeatEnabled = !!body.heartbeatEnabled;
        }
        if (body.heartbeatIdleTimeoutDays !== undefined) {
          const days = Number(body.heartbeatIdleTimeoutDays);
          if (isNaN(days) || days < 0 || days > 30) { json(400, { error: 'heartbeatIdleTimeoutDays must be 0-30' }); return; }
          cfg.heartbeatIdleTimeoutDays = days;
        }
        if (body.disabledRuntimes !== undefined) {
          if (!Array.isArray(body.disabledRuntimes) || !body.disabledRuntimes.every((r: unknown) => typeof r === 'string')) {
            json(400, { error: 'disabledRuntimes must be string[]' }); return;
          }
          (cfg as any).disabledRuntimes = body.disabledRuntimes;
        }
        fd.project.setConfig(cfg);
        json(200, { config: cfg });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/cron' && method === 'GET') {
      const cronStore = cronStores?.get(projectName);
      if (!cronStore) { json(500, { error: 'Cron not available for this project' }); return; }
      json(200, cronStore.listJobs());
    } else if (subPath === '/cron' && method === 'POST') {
      const cronStore = cronStores?.get(projectName);
      if (!cronStore) { json(500, { error: 'Cron not available for this project' }); return; }
      try {
        const body = await readBody();
        if (!body.name || !body.prompt) { json(400, { error: 'Missing required fields: name, prompt' }); return; }
        const schedule = body.schedule || '0 * * * *';
        const job = cronStore.addJob({
          name: body.name,
          description: body.description,
          schedule: { kind: 'cron', expr: typeof schedule === 'string' ? schedule : (schedule.cron || schedule.expr || '0 * * * *'), tz: typeof schedule === 'object' ? schedule.tz : undefined },
          prompt: body.prompt,
          skill: body.skill,
          enabled: body.enabled ?? true,
        });
        json(201, job);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath.match(/^\/cron\/[^/]+\/enable$/) && method === 'PUT') {
      const cronStore = cronStores?.get(projectName);
      if (!cronStore) { json(500, { error: 'Cron not available' }); return; }
      const jobId = subPath.split('/')[2];
      if (cronStore.enableJob(jobId)) json(200, { success: true });
      else json(404, { error: 'Cron job not found' });
    } else if (subPath.match(/^\/cron\/[^/]+\/disable$/) && method === 'PUT') {
      const cronStore = cronStores?.get(projectName);
      if (!cronStore) { json(500, { error: 'Cron not available' }); return; }
      const jobId = subPath.split('/')[2];
      if (cronStore.disableJob(jobId)) json(200, { success: true });
      else json(404, { error: 'Cron job not found' });
    } else if (subPath.match(/^\/cron\/[^/]+$/) && method === 'DELETE') {
      const cronStore = cronStores?.get(projectName);
      if (!cronStore) { json(500, { error: 'Cron not available' }); return; }
      const jobId = subPath.split('/')[2];
      if (cronStore.removeJob(jobId)) json(200, { success: true });
      else json(404, { error: 'Cron job not found' });
    } else if (subPath.match(/^\/cron\/[^/]+\/run$/) && method === 'POST') {
      const cronStore = cronStores?.get(projectName);
      const lm = leadManagers.get(projectName);
      if (!cronStore || !lm) { json(500, { error: 'Cron or Lead not available' }); return; }
      const jobId = subPath.split('/')[2];
      const job = cronStore.getJob(jobId);
      if (!job) { json(404, { error: 'Cron job not found' }); return; }
      // Fire and forget
      lm.steerLead({ type: 'cron', job: { id: job.id, name: job.name, prompt: job.prompt, skill: job.skill } }).catch(() => {});
      json(202, { status: 'triggered' });
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });

  return httpServer;
}

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Flightdeck } from '../facade.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { WebhookNotifier } from '../integrations/WebhookNotifier.js';
import { leadResponseEvent } from '../integrations/WebhookNotifier.js';

import type { AgentManager } from '../agents/AgentManager.js';
import type { AgentRole } from '@flightdeck-ai/shared';
import type { CronStore } from '../cron/CronStore.js';
import type { ChatMessage } from '../comms/MessageStore.js';

/** Minimal interface for WebSocket servers used by the HTTP API. */
export interface WsBroadcaster {
  broadcast(event: Record<string, unknown>): void;
}

export interface HttpServerDeps {
  projectManager: ProjectManager;
  leadManagers: Map<string, LeadManager>;
  agentManagers?: Map<string, AgentManager>;
  port: number;
  corsOrigin: string;
  wsServers: Map<string, WsBroadcaster>;
  /** Auth check function. Returns true if request was blocked (401 sent). */
  authCheck?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Webhook notifiers per project, for firing lead_response and agent_message events. */
  webhookNotifiers?: Map<string, WebhookNotifier>;
  /** Cron stores per project. */
  cronStores?: Map<string, CronStore>;
  /** Called after a project is created or unarchived to set up LeadManager, WS, Orchestrator, etc. */
  onProjectSetup?: (projectName: string) => Promise<void>;
}

/**
 * Create the HTTP server with multi-project API routes.
 * All project routes are scoped under /api/projects/:name/*.
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const { projectManager, leadManagers, port, corsOrigin, wsServers, authCheck, webhookNotifiers, agentManagers, cronStores, onProjectSetup } = deps;

  const modelCfgCache = new Map<string, InstanceType<typeof import('../agents/ModelConfig.js').ModelConfig>>();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON body is inherently untyped
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Id, X-Agent-Role');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Auth check
    if (authCheck && authCheck(req, res)) return;

    // ── Health ──
    if (url.pathname === '/health') {
      json(200, { status: 'ok', projects: projectManager.list() });
      return;
    }

    // ── Global models (works even with zero projects) ──
    if (url.pathname === '/api/models/available' && method === 'GET') {
      await ensureModules();
      const result: Record<string, unknown> = {};
      for (const rt of modRegistry!.getRuntimes()) result[rt] = modRegistry!.getModels(rt);
      json(200, result);
      return;
    }

    // ── Global config (runtime toggles, display prefs shared across projects) ──
    if (url.pathname === '/api/global-config' && method === 'GET') {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { FD_HOME } = await import('../cli/constants.js');
      const cfgPath = join(FD_HOME, 'global-config.json');
      try {
        json(200, existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {});
      } catch { json(200, {}); }
      return;
    }
    if (url.pathname === '/api/global-config' && method === 'PUT') {
      try {
        const body = await readBody();
        const { GlobalConfigSchema } = await import('@flightdeck-ai/shared/config-schema');
        const parsed = GlobalConfigSchema.partial().safeParse(body);
        if (!parsed.success) { json(400, { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { FD_HOME } = await import('../cli/constants.js');
        mkdirSync(FD_HOME, { recursive: true });
        const cfgPath = join(FD_HOME, 'global-config.json');
        const existing = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {};
        Object.assign(existing, parsed.data);
        writeFileSync(cfgPath, JSON.stringify(existing, null, 2));
        json(200, existing);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
      return;
    }

    // ── Directory browser (for file picker in create project dialog) ──
    if (url.pathname === '/api/browse-directory' && method === 'GET') {
      const { readdirSync, statSync } = await import('node:fs');
      const { resolve: resolvePath } = await import('node:path');
      const { homedir } = await import('node:os');
      const startPath = url.searchParams.get('path') || homedir();
      try {
        const resolved = resolvePath(startPath);
        const entries = readdirSync(resolved, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({ name: e.name, path: resolvePath(resolved, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        json(200, { path: resolved, parent: resolvePath(resolved, '..'), entries });
      } catch {
        json(200, { path: startPath, parent: startPath, entries: [] });
      }
      return;
    }
    if (url.pathname === '/api/create-directory' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.path) { json(400, { error: 'Missing path' }); return; }
        const { mkdirSync } = await import('node:fs');
        mkdirSync(body.path, { recursive: true });
        json(200, { created: true, path: body.path });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
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
            agentCount: fd.listAgents().filter((a: any) => !['retired', 'hibernated', 'errored'].includes(a.status)).length,
            busyAgentCount: fd.listAgents().filter((a: any) => a.status === 'busy').length,
            hibernatedCount: fd.listAgents().filter((a: any) => a.status === 'hibernated').length,
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
        // Hot-register: set up orchestrator, LeadManager, WebSocket for the new project
        const fd = projectManager.get(name);
        if (fd) {
          fd.orchestrator.start();
          if (onProjectSetup) {
            await onProjectSetup(name);
          }
        }
        json(201, { name, message: `Project "${name}" created` });
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
      return;
    }

    // ── Project-scoped routes: /api/projects/:name/* ──
    const m = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); res.end('Not found'); return; }

    const projectName = decodeURIComponent(m[1]);
    const subPath = m[2] || '/';

    // DELETE project (permanent)
    if (subPath === '/' && method === 'DELETE') {
      // Clean up LeadManager and state for this project
      const lm = leadManagers?.get(projectName);
      if (lm) {
        try { lm.stop?.(); } catch { /* best effort */ }
        leadManagers?.delete(projectName);
      }
      if (wsServers?.has(projectName)) wsServers.delete(projectName);
      modelCfgCache.delete(projectName);
      if (projectManager.delete(projectName)) {
        // Sessions are stored in the project's own SQLite, which is deleted with the project.
        // No extra cleanup needed.
        json(200, { message: `Project "${projectName}" deleted` });
      }
      else json(404, { error: `Project "${projectName}" not found` });
      return;
    }

    // Archive project (hide but keep data)
    if (subPath === '/archive' && method === 'POST') {
      if (projectManager.archive(projectName)) {
        const lm = leadManagers?.get(projectName);
        if (lm) { try { lm.stop(); } catch {} leadManagers?.delete(projectName); }
        json(200, { message: `Project "${projectName}" archived` });
      } else json(404, { error: `Project "${projectName}" not found` });
      return;
    }

    // Unarchive project
    if (subPath === '/unarchive' && method === 'POST') {
      if (projectManager.unarchive(projectName)) {
        // Re-register project runtime (LeadManager, WS, Orchestrator)
        const unarchivedFd = projectManager.get(projectName);
        if (unarchivedFd) {
          unarchivedFd.orchestrator.start();
          if (onProjectSetup) {
            await onProjectSetup(projectName);
          }
        }
        json(200, { message: `Project "${projectName}" unarchived` });
      }
      else json(404, { error: `Project "${projectName}" not found or not archived` });
      return;
    }

    // List archived projects
    if (url.pathname === '/api/projects/archived' && method === 'GET') {
      const all = projectManager.listAll();
      const archived = all.filter(n => projectManager.isArchived(n));
      json(200, { projects: archived });
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
      const authorTypesParam = url.searchParams.get('author_types');
      const authorTypes = authorTypesParam ? authorTypesParam.split(',') : undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      json(200, (fd.messages?.listMessages({ threadId, taskId, limit, authorTypes }) ?? []).reverse());
    } else if (subPath === '/messages' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.content || typeof body.content !== 'string') { json(400, { error: 'Missing required field: content' }); return; }
        const isAsync = url.searchParams.get('async') === 'true' || url.searchParams.get('async') === '1';
        let userMsg = null;
        if (fd.messages) {
          userMsg = fd.messages.createMessage({ threadId: null, parentId: null, taskId: null, authorType: 'user', authorId: body.senderId || 'http-api', content: body.content, metadata: null, source: body.source ?? null, senderId: body.senderId ?? null, senderName: body.senderName ?? null, replyToId: body.replyToId ?? null, attachments: body.attachments ?? null, channelId: body.channelId ?? null });
          if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: userMsg });
        }
        if (isAsync) {
          // Fire-and-forget: steer Lead in background, return immediately
          if (leadManager) {
            leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content as string } as ChatMessage }).then(raw => {
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
              const raw = await leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content as string } as ChatMessage });
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
        // Permission check: only lead/planner can add tasks
        const callerAgentId = req.headers['x-agent-id'] as string;
        if (callerAgentId) {
          const callerAgent = fd.sqlite.getAgent(callerAgentId as import('@flightdeck-ai/shared').AgentId);
          if (!callerAgent) { json(403, { error: `Error: Agent '${callerAgentId}' not found. Check flightdeck_status() to see registered agents.` }); return; }
          if (callerAgent.role !== 'lead' && callerAgent.role !== 'planner') {
            json(403, { error: `Error: Agent '${callerAgentId}' (role: ${callerAgent.role}) cannot add tasks. Only lead/planner roles can add tasks. Use flightdeck_escalate() to request task creation.` }); return;
          }
        }
        const task = fd.addTask({ title: body.title, description: body.description, role: body.role || 'worker', needsReview: body.needsReview, notifyLead: body.notifyLead });
        if (wsServer) {
          wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        }
        json(201, task);
      } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/tasks' && method === 'GET') {
      json(200, fd.listTasks());
    } else if (subPath.match(/^\/tasks\/[^/]+$/) && method === 'GET') {
      const taskId = subPath.split('/').pop()!;
      const task = fd.listTasks().find(t => t.id === taskId);
      if (task) json(200, task); else json(404, { error: 'Task not found' });
    } else if (subPath.match(/^\/tasks\/[^/]+\/claim$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) { json(400, { error: 'Missing X-Agent-Id header' }); return; }
      // Permission check: only workers can claim tasks
      const callerAgent = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      if (callerAgent && callerAgent.role !== 'worker') {
        json(403, { error: `Error: Agent '${agentId}' (role: ${callerAgent.role}) cannot claim tasks. Only worker role can claim tasks.` }); return;
      }
      try {
        const task = fd.claimTask(taskId as import('@flightdeck-ai/shared').TaskId, agentId as import('@flightdeck-ai/shared').AgentId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Task not found')) {
          json(404, { error: `Error: Task '${taskId}' not found. Use flightdeck_task_list() to see available tasks.` });
        } else {
          json(400, { error: msg });
        }
      }
    } else if (subPath.match(/^\/tasks\/[^/]+\/submit$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        const task = fd.submitTask(taskId as import('@flightdeck-ai/shared').TaskId, body.claim);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not running')) {
          // Extract state from message like "Task xxx is not running (state: ready)"
          const stateMatch = msg.match(/state:\s*(\w+)/);
          const currentState = stateMatch ? stateMatch[1] : 'unknown';
          json(400, { error: `Error: Cannot submit task '${taskId}' — current state is '${currentState}', must be 'running'. Did you forget to call flightdeck_task_claim() first?` });
        } else if (msg.includes('Task not found')) {
          json(404, { error: `Error: Task '${taskId}' not found. Use flightdeck_task_list() to see available tasks.` });
        } else {
          json(400, { error: msg });
        }
      }
    } else if (subPath.match(/^\/tasks\/[^/]+\/complete$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.completeTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/fail$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.failTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/state$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (!body.state) { json(400, { error: 'Missing required field: state' }); return; }
        fd.sqlite.updateTaskState(taskId as import('@flightdeck-ai/shared').TaskId, body.state);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/description$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (!body.description) { json(400, { error: 'Missing required field: description' }); return; }
        fd.sqlite.updateTaskDescription(taskId as import('@flightdeck-ai/shared').TaskId, body.description);
        json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/role$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (!body.role) { json(400, { error: 'Missing required field: role' }); return; }
        fd.sqlite.updateTaskRole(taskId as import('@flightdeck-ai/shared').TaskId, body.role);
        json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/cancel$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.cancelTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/pause$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      // Permission check: workers cannot pause tasks
      const pauseAgentId = req.headers['x-agent-id'] as string;
      if (pauseAgentId) {
        const pauseAgent = fd.sqlite.getAgent(pauseAgentId as import('@flightdeck-ai/shared').AgentId);
        if (pauseAgent && pauseAgent.role === 'worker') {
          json(403, { error: `Error: Agent '${pauseAgentId}' (role: worker) cannot pause tasks. Only lead/planner roles can pause tasks.` }); return;
        }
      }
      try {
        const task = fd.pauseTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/resume$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.resumeTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/retry$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.retryTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/skip$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.skipTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/reopen$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const task = fd.reopenTask(taskId as import('@flightdeck-ai/shared').TaskId);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/review$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string;
        if (!body.verdict || !body.comment) { json(400, { error: 'Missing verdict or comment' }); return; }
        fd.sqlite.addTaskComment(taskId as import('@flightdeck-ai/shared').TaskId, body.comment, (agentId || 'http-api') as import('@flightdeck-ai/shared').AgentId, 'review', body.verdict);
        if (body.verdict === 'approve') {
          fd.dag.completeTask(taskId as import('@flightdeck-ai/shared').TaskId);
          json(200, { taskId, verdict: 'approve', newState: 'done' });
        } else {
          fd.sqlite.updateTaskState(taskId as import('@flightdeck-ai/shared').TaskId, 'running' as import('@flightdeck-ai/shared').TaskState);
          json(200, { taskId, verdict: 'request_changes', newState: 'running', feedback: body.comment });
        }
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/compact$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        const task = fd.compactTask(taskId as import('@flightdeck-ai/shared').TaskId, body.summary);
        json(200, task);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/clear-stale$/) && method === 'POST') {
      const taskId = subPath.split('/')[2];
      fd.sqlite.clearTaskStale(taskId as import('@flightdeck-ai/shared').TaskId);
      json(200, { status: 'ok', taskId });
    } else if (subPath === '/tasks/declare' && method === 'POST') {
      try {
        const body = await readBody();
        if (!Array.isArray(body.tasks)) { json(400, { error: 'Expected { tasks: [...] }' }); return; }
        // Permission check: only lead/planner can declare tasks
        const declareCallerId = req.headers['x-agent-id'] as string;
        if (declareCallerId) {
          const declareCaller = fd.sqlite.getAgent(declareCallerId as import('@flightdeck-ai/shared').AgentId);
          if (!declareCaller) { json(403, { error: `Error: Agent '${declareCallerId}' not found. Check flightdeck_status() to see registered agents.` }); return; }
          if (declareCaller.role !== 'lead' && declareCaller.role !== 'planner') {
            json(403, { error: `Error: Agent '${declareCallerId}' (role: ${declareCaller.role}) cannot declare tasks. Only lead/planner roles can declare tasks. Use flightdeck_escalate() to request task creation.` }); return;
          }
        }
        const tasks = fd.declareTasks(body.tasks as Parameters<typeof fd.declareTasks>[0]);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(201, tasks);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/subtasks$/) && method === 'POST') {
      const parentTaskId = subPath.split('/')[2];
      try {
        const body = await readBody();
        if (!Array.isArray(body.tasks)) { json(400, { error: 'Expected { tasks: [...] }' }); return; }
        const tasks = fd.declareSubTasks(parentTaskId as import('@flightdeck-ai/shared').TaskId, body.tasks as Parameters<typeof fd.declareTasks>[0]);
        if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        json(201, tasks);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/tasks\/[^/]+\/events$/) && method === 'GET') {
      const taskId = subPath.split('/')[2];
      const events = fd.sqlite.getTaskEvents(taskId as import('@flightdeck-ai/shared').TaskId);
      json(200, events);
    } else if (subPath.match(/^\/tasks\/[^/]+\/comments$/) && method === 'GET') {
      const taskId = subPath.split('/')[2];
      const comments = fd.sqlite.getTaskComments(taskId as import('@flightdeck-ai/shared').TaskId);
      json(200, comments);
    } else if (subPath.match(/^\/tasks\/[^/]+\/comments$/) && method === 'POST') {
      // POST /api/projects/:name/tasks/:id/comments — add a task comment or broadcast
      try {
        const body = await readBody();
        const taskId = subPath.split('/')[2];
        if (body.comment) {
          // MCP-style: create comment via agent header
          const agentId = req.headers['x-agent-id'] as string || 'http-api';
          const id = fd.sqlite.addTaskComment(taskId as import('@flightdeck-ai/shared').TaskId, body.comment, agentId as import('@flightdeck-ai/shared').AgentId);
          if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: body.comment });
          json(200, { id, taskId, message: 'Comment added' });
        } else if (body.message) {
          // Legacy: broadcast a pre-created task comment
          if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: body.message });
          json(200, { status: 'broadcast' });
        } else {
          json(400, { error: 'Missing required field: comment or message' });
        }
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
      const includeRetired = url.searchParams.get('include_retired') === 'true';
      json(200, fd.listAgents(includeRetired));
    } else if (subPath === '/agents/spawn' && method === 'POST') {
      const am = agentManagers?.get(projectName) ?? fd.agentManager;
      if (!am) { json(500, { error: 'No AgentManager available for this project' }); return; }
      try {
        const body = await readBody();
        if (!body.role) { json(400, { error: 'Missing required field: role' }); return; }
        // Permission check: only lead can spawn agents
        const spawnCallerId = req.headers['x-agent-id'] as string;
        if (spawnCallerId) {
          const spawnCaller = fd.sqlite.getAgent(spawnCallerId as import('@flightdeck-ai/shared').AgentId);
          if (spawnCaller && spawnCaller.role !== 'lead') {
            json(403, { error: `Error: Agent '${spawnCallerId}' (role: ${spawnCaller.role}) cannot spawn agents. Only lead role can spawn agents.` }); return;
          }
        }
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
          cwd: body.cwd ?? fd.status().config.cwd ?? fd.project.subpath('.'),
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
        const agent = fd.sqlite.getAgent(agentId as any);
        await am.terminateAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        // If Lead was terminated, reset LeadManager so next message spawns fresh
        if (agent?.role === 'lead') {
          const lm = leadManagers?.get(projectName);
          if (lm) { (lm as any).leadSessionId = null; (lm as any).leadAgentId = null; }
        }
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
        const agent = fd.sqlite.getAgent(agentId as any);
        await am.retireAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        // If Lead/Planner was retired, reset LeadManager so next message spawns fresh
        if (agent?.role === 'lead' || agent?.role === 'planner') {
          const lm = leadManagers?.get(projectName);
          if (lm) {
            (lm as any).leadSessionId = null;
            (lm as any).leadAgentId = null;
          }
        }
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
    } else if (subPath === '/threads' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.originId && !body.origin_id) { json(400, { error: 'Missing originId' }); return; }
        if (!fd.messages) { json(500, { error: 'MessageStore not available' }); return; }
        const thread = fd.messages.createThread({ originId: body.originId ?? body.origin_id, title: body.title });
        json(201, thread);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
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

      // Search memory files
      const source = url.searchParams.get('source');
      const memoryResults: Array<{ source: string; filename: string; line: number; snippet: string }> = [];
      if (!source || source === 'memory') {
        try {
          const { readdirSync, readFileSync, statSync } = await import('node:fs');
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
                } catch { /* skip unreadable files */ }
                if (memoryResults.length >= limit) break;
              }
            } catch { /* dir doesn't exist */ }
          };
          searchDir(memDir);
        } catch { /* memory search optional */ }
      }

      // Return unified results array (for MCP compatibility) + structured data
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
    } else if (subPath === '/models' && method === 'GET') {
      const mc = await getModelConfig(fd, projectName);
      json(200, { roles: mc.getRoleConfigs(), presets: presetNames });
    } else if (subPath === '/models/available' && method === 'GET') {
      const result: Record<string, unknown> = {};
      for (const rt of modRegistry!.getRuntimes()) result[rt] = modRegistry!.getModels(rt);
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
    } else if (subPath.match(/^\/roles\/[^/]+$/) && method === 'GET') {
      const roleId = subPath.split('/')[2];
      const { RoleRegistry } = await import('../roles/RoleRegistry.js');
      const registry = new RoleRegistry(projectName);
      const cwd = fd.project.getConfig().cwd;
      if (cwd) registry.discoverRepoRoles(cwd);
      const role = registry.get(roleId);
      if (!role) { json(404, { error: `Role '${roleId}' not found.` }); return; }
      const specialists = registry.getSpecialists ? registry.getSpecialists(roleId) : [];
      json(200, { id: role.id, name: role.name, description: role.description, icon: role.icon, color: role.color, permissions: role.permissions, instructions: role.instructions, specialists: specialists ?? [] });
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
        serverDisplayConfig = { ...(displayModule!.DISPLAY_PRESETS)[preset as import('@flightdeck-ai/shared').DisplayPreset] };
        json(200, serverDisplayConfig);
      } else json(400, { error: `Unknown preset: ${preset}. Available: ${displayModule!.DISPLAY_PRESET_NAMES.join(', ')}` });
    } else if (subPath.match(/^\/models\/[^/]+$/) && method === 'PUT') {
      const role = subPath.split('/').pop()!;
      try {
        const body = await readBody();
        const mc = await getModelConfig(fd, projectName);
        if (body.runtime) mc.setRole(role, `${body.runtime}:${body.model ?? ''}`);
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
    } else if (subPath === '/orchestrator/tick' && method === 'POST') {
      try { const result = await fd.orchestrator.tick(); json(200, { ok: true, ...result }); } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : String(e) }); }
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
        const { ProjectConfigSchema } = await import('@flightdeck-ai/shared/config-schema');
        const parsed = ProjectConfigSchema.partial().safeParse(body);
        if (!parsed.success) { json(400, { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
        const validBody = parsed.data;
        const cfg = fd.project.getConfig();
        if (validBody.governance !== undefined) {
          cfg.governance = validBody.governance;
          fd.governance.setProfile(validBody.governance);
        }
        if (validBody.heartbeatEnabled !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config extension
          (cfg as any).heartbeatEnabled = validBody.heartbeatEnabled;
        }
        if (validBody.scoutEnabled !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config extension
          (cfg as any).scoutEnabled = validBody.scoutEnabled;
        }
        if (validBody.heartbeatIdleTimeoutDays !== undefined) {
          cfg.heartbeatIdleTimeoutDays = validBody.heartbeatIdleTimeoutDays;
        }
        if (validBody.isolation !== undefined) {
          cfg.isolation = validBody.isolation;
        }
        if (validBody.onCompletion !== undefined) {
          cfg.onCompletion = validBody.onCompletion;
        }
        if (validBody.maxConcurrentWorkers !== undefined) {
          cfg.maxConcurrentWorkers = validBody.maxConcurrentWorkers;
        }
        if (validBody.planApprovalThreshold !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config extension
          (cfg as any).planApprovalThreshold = validBody.planApprovalThreshold;
        }
        if (validBody.costThresholdPerDay !== undefined) {
          cfg.costThresholdPerDay = validBody.costThresholdPerDay;
        }
        if (validBody.cwd !== undefined) {
          cfg.cwd = validBody.cwd;
        }
        if (validBody.notifications !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config extension
          (cfg as any).notifications = validBody.notifications;
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
    } else if (subPath === '/escalate' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        if (!body.taskId || !body.reason) { json(400, { error: 'Missing taskId or reason' }); return; }
        const { messageId } = await import('@flightdeck-ai/shared');
        const msg = {
          id: messageId(agentId, 'escalation', Date.now().toString()),
          from: agentId as import('@flightdeck-ai/shared').AgentId,
          to: null,
          channel: 'escalations',
          content: `ESCALATION for task ${body.taskId}: ${body.reason}`,
          timestamp: new Date().toISOString(),
        };
        fd.sendMessage(msg, 'escalations');
        json(200, { status: 'escalated', taskId: body.taskId });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/discuss' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        if (!body.topic) { json(400, { error: 'Missing topic' }); return; }
        // Permission check: only lead/planner can create discussions
        if (agentId !== 'http-api') {
          const discussCaller = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
          if (discussCaller && discussCaller.role !== 'lead' && discussCaller.role !== 'planner') {
            json(403, { error: `Error: Agent '${agentId}' (role: ${discussCaller.role}) cannot create discussions. Only lead/planner roles can create discussions. Use flightdeck_escalate() to request one.` }); return;
          }
        }
        const topicHash = Array.from(body.topic as string).reduce((h: number, c: string) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        const channel = `discuss-${Math.abs(topicHash).toString(36)}-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        const { messageId } = await import('@flightdeck-ai/shared');
        const initMsg = {
          id: messageId('system', channel, now),
          from: agentId as import('@flightdeck-ai/shared').AgentId,
          to: null,
          channel,
          content: `Discussion created: "${body.topic}"\nInvitees: ${(body.invitees ?? []).join(', ') || 'open'}\nCreated: ${now}`,
          timestamp: now,
        };
        fd.sendMessage(initMsg, channel);
        json(200, { channel, topic: body.topic, invitees: body.invitees ?? [], createdAt: now });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/learnings' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        if (!body.content) { json(400, { error: 'Missing content' }); return; }
        const learning = fd.learnings.append({
          agentId,
          content: body.content,
          tags: body.tags ?? [],
          category: body.category,
        });
        json(201, learning);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/learnings/search' && method === 'GET') {
      const query = url.searchParams.get('query');
      if (!query) { json(400, { error: 'Missing query parameter' }); return; }
      json(200, fd.learnings.search(query));
    } else if (subPath === '/messages/send' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        if (!body.content) { json(400, { error: 'Missing content' }); return; }
        const { messageId: mkMsgId } = await import('@flightdeck-ai/shared');
        if (body.taskId) {
          // Task comment path
          if (fd.messages) {
            const senderAgent = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
            const msg = fd.messages.createMessage({
              threadId: null, parentId: body.parentId ?? null, taskId: body.taskId,
              authorType: (senderAgent?.role === 'lead' ? 'lead' : 'agent') as 'lead' | 'agent',
              authorId: agentId, content: body.content, metadata: null,
            });
            if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: body.taskId, message: msg });
            json(200, { status: 'sent', taskId: body.taskId, messageId: msg.id });
          } else {
            json(500, { error: 'MessageStore not available' });
          }
        } else if (body.to) {
          // DM path
          const msg = {
            id: mkMsgId(agentId, body.to, Date.now().toString()),
            from: agentId as import('@flightdeck-ai/shared').AgentId,
            to: body.to as import('@flightdeck-ai/shared').AgentId,
            channel: null, content: body.content,
            timestamp: new Date().toISOString(),
            parentId: body.parentId ?? null,
          };
          fd.sendMessage(msg);
          json(200, { status: 'sent', to: body.to });
        } else if (body.channel) {
          // Channel path
          const msg = {
            id: mkMsgId(agentId, body.channel, Date.now().toString()),
            from: agentId as import('@flightdeck-ai/shared').AgentId,
            to: null, channel: body.channel, content: body.content,
            timestamp: new Date().toISOString(),
            parentId: body.parentId ?? null,
          };
          fd.sendMessage(msg, body.channel);
          json(200, { status: 'sent', channel: body.channel });
        } else {
          json(400, { error: 'Must provide to, channel, or taskId' });
        }
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/messages/read' && method === 'GET') {
      const channel = url.searchParams.get('channel') ?? undefined;
      const since = url.searchParams.get('since') ?? undefined;
      const agentId = req.headers['x-agent-id'] as string;
      if (channel) {
        json(200, fd.readMessages(channel, since));
      } else {
        if (!agentId) { json(400, { error: 'Missing X-Agent-Id header for DM inbox' }); return; }
        const unread = fd.getUnreadDMs(agentId as import('@flightdeck-ai/shared').AgentId);
        fd.markDMsRead(agentId as import('@flightdeck-ai/shared').AgentId);
        json(200, unread.length === 0
          ? { status: 'empty', messages: [] }
          : { status: 'unread', count: unread.length, messages: unread.map(m => ({ from: m.from, content: m.content, timestamp: m.timestamp })) });
      }
    } else if (subPath === '/memory' && method === 'GET') {
      const files = fd.memory.list();
      const result = files.map(f => {
        const content = fd.memory.read(f);
        const size = content ? Buffer.byteLength(content, 'utf-8') : 0;
        return { filename: f, size, preview: content ? content.slice(0, 200) : '' };
      });
      json(200, { files: result });
    } else if (subPath.match(/^\/memory\/[^/]+$/) && method === 'GET') {
      const filename = decodeURIComponent(subPath.split('/')[2]);
      const content = fd.memory.read(filename);
      if (content === null) { json(404, { error: `Memory file not found: ${filename}` }); return; }
      json(200, { content });
    } else if (subPath.match(/^\/memory\/[^/]+$/) && method === 'PUT') {
      const filename = decodeURIComponent(subPath.split('/')[2]);
      try {
        const body = await readBody();
        fd.writeMemory(filename, body.content);
        json(200, { status: 'written', path: `memory/${filename}` });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/memory/daily-log' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.entry) { json(400, { error: 'Missing entry' }); return; }
        fd.memory.appendDailyLog(body.entry);
        json(200, { status: 'logged', filename: fd.memory.getDailyLogFilename() });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/cost' && method === 'GET') {
      // Permission check: only lead/planner can view cost reports
      const costCallerId = req.headers['x-agent-id'] as string;
      if (costCallerId) {
        const costCaller = fd.sqlite.getAgent(costCallerId as import('@flightdeck-ai/shared').AgentId);
        if (costCaller && costCaller.role !== 'lead' && costCaller.role !== 'planner') {
          json(403, { error: `Error: Agent '${costCallerId}' (role: ${costCaller.role}) cannot view cost reports. Only lead/planner roles can view cost reports.` }); return;
        }
      }
      json(200, { totalCost: fd.sqlite.getTotalCost(), byAgent: fd.sqlite.getCostByAgent(), byTask: fd.sqlite.getCostByTask() });
    } else if (subPath === '/token-usage' && method === 'GET') {
      json(200, {
        total: fd.sqlite.getTokenUsageTotal(),
        byAgent: fd.sqlite.getTokenUsageByAgent(),
      });
    } else if (subPath === '/timers' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        const timer = fd.timers.setTimer(agentId, body.label, body.delayMs, body.message, body.repeat);
        json(200, timer);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/timers' && method === 'GET') {
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      json(200, fd.timers.listTimers(agentId));
    } else if (subPath.match(/^\/timers\/[^/]+$/) && method === 'DELETE') {
      const label = decodeURIComponent(subPath.split('/')[2]);
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      json(200, { cancelled: fd.timers.cancelTimer(agentId, label) });
    } else if (subPath === '/specs' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.title || !body.content) { json(400, { error: 'Missing title or content' }); return; }
        const spec = fd.createSpec(body.title, body.content);
        json(201, spec);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath.match(/^\/specs\/[^/]+\/cancel$/) && method === 'POST') {
      const specId = decodeURIComponent(subPath.split('/')[2]);
      const cancelled = fd.sqlite.cancelTasksBySpec(specId as any);
      json(200, { specId, cancelledTasks: cancelled });
    } else if (subPath === '/spec-changes' && method === 'GET') {
      json(200, fd.orchestrator.getRecentSpecChanges());
    } else if (subPath === '/escalations' && method === 'GET') {
      const status = url.searchParams.get('status') as 'pending' | 'resolved' | undefined;
      json(200, fd.sqlite.listEscalations(status || undefined));
    } else if (subPath === '/escalations' && method === 'POST') {
      try {
        const body = await readBody();
        const agentId = req.headers['x-agent-id'] as string || 'lead';
        if (!body.title || !body.description) { json(400, { error: 'Missing title or description' }); return; }
        const esc = fd.sqlite.createEscalation(agentId, body.title, body.description, body.priority);
        if (wsServer) wsServer.broadcast({ type: 'escalation:created', project: projectName, escalation: esc });
        json(201, esc);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath.match(/^\/escalations\/\d+\/resolve$/) && method === 'POST') {
      try {
        const id = parseInt(subPath.split('/')[2], 10);
        const body = await readBody();
        if (!body.resolution) { json(400, { error: 'Missing resolution' }); return; }
        const esc = fd.sqlite.resolveEscalation(id, body.resolution);
        if (!esc) { json(404, { error: 'Escalation not found' }); return; }
        if (wsServer) wsServer.broadcast({ type: 'escalation:resolved', project: projectName, escalation: esc });
        json(200, { success: true, escalation: esc });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/suggestions' && method === 'GET') {
      const specId = url.searchParams.get('spec_id') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      json(200, fd.suggestions.list({ specId, status: status as 'pending' | 'approved' | 'rejected' | 'implemented' | undefined }));
    } else if (subPath.match(/^\/suggestions\/[^/]+\/approve$/) && method === 'POST') {
      const id = subPath.split('/')[2];
      const s = fd.suggestions.updateStatus(id, 'approved');
      if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    } else if (subPath.match(/^\/suggestions\/[^/]+\/reject$/) && method === 'POST') {
      const id = subPath.split('/')[2];
      const s = fd.suggestions.updateStatus(id, 'rejected');
      if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    } else if (subPath === '/file-locks' && method === 'GET') {
      json(200, fd.sqlite.listFileLocks());
    } else if (subPath === '/file-locks' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.filePath) { json(400, { error: 'Missing filePath' }); return; }
        const agentId = body.agentId ?? req.headers['x-agent-id'] ?? 'unknown';
        const role = body.role ?? req.headers['x-agent-role'] ?? 'worker';
        const success = fd.sqlite.acquireFileLock(body.filePath, agentId, role, body.reason);
        json(success ? 200 : 409, { locked: success, filePath: body.filePath });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath.match(/^\/file-locks\//) && method === 'DELETE') {
      try {
        const filePath = decodeURIComponent(subPath.slice('/file-locks/'.length));
        const body = await readBody().catch(() => ({} as Record<string, unknown>));
        const agentId = body?.agentId ?? req.headers['x-agent-id'] ?? '';
        const released = fd.sqlite.releaseFileLock(filePath, agentId);
        json(200, { released, filePath });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath === '/isolation/status' && method === 'GET') {
      try {
        const project = fd.project.getConfig();
        const isolationMode = project.isolation ?? 'file_lock';
        const { IsolationManager } = await import('../isolation/IsolationManager.js');
        const im = new IsolationManager(fd.project.cwd ?? process.cwd(), { mode: isolationMode as 'file_lock' | 'git_worktree' });
        json(200, im.status());
      } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : String(e) }); }
    } else if (subPath === '/webhook/test' && method === 'POST') {
      const wn = fd.orchestrator.getWebhookNotifier();
      if (wn.count === 0) { json(400, { error: 'No webhooks configured' }); return; }
      const result = await wn.sendTest();
      json(200, result);
    } else if (subPath === '/skills' && method === 'GET') {
      const { SkillManager } = await import('../skills/SkillManager.js');
      const sm = new SkillManager(fd.project.cwd ?? process.cwd());
      sm.loadProjectConfig();
      const installed = sm.listInstalledSkills();
      const repoSkills = sm.discoverRepoSkills(process.cwd());
      sm.loadProjectConfig();
      const roleAssignments: Record<string, string[]> = {};
      for (const role of ['lead', 'planner', 'worker', 'reviewer'] as const) {
        roleAssignments[role] = sm.getSkillsForRole(role);
      }
      json(200, { installed, repoSkills, roleAssignments });
    } else if (subPath === '/skills/install' && method === 'POST') {
      try {
        const body = await readBody();
        if (!body.source) { json(400, { error: 'Missing source' }); return; }
        const { SkillManager } = await import('../skills/SkillManager.js');
        const sm = new SkillManager(fd.project.cwd ?? process.cwd());
        const result = sm.installSkill(body.source);
        if (!result) { json(400, { error: 'Failed to install skill' }); return; }
        json(200, result);
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    } else if (subPath === '/files' && method === 'GET') {
      // List directory contents
      const { readdirSync, statSync } = await import('node:fs');
      const { join: pjoin, resolve: resolvePath } = await import('node:path');
      const cfg = fd.project.getConfig();
      const projectCwd = cfg.cwd ?? fd.project.subpath('.');
      const relPath = url.searchParams.get('path') || '';
      try {
        const absPath = resolvePath(projectCwd, relPath);
        // Prevent path traversal
        if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return; }
        const dirEntries = readdirSync(absPath, { withFileTypes: true })
          .filter(e => e.name !== '.git')
          .map(e => {
            const full = pjoin(absPath, e.name);
            let size = 0;
            try { size = statSync(full).size; } catch {}
            const ext = e.isFile() ? (e.name.includes('.') ? e.name.split('.').pop()! : '') : '';
            return { name: e.name, type: (e.isDirectory() ? 'directory' : 'file') as 'file' | 'directory', size, extension: ext };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        const parent = relPath ? relPath.split('/').slice(0, -1).join('/') || null : null;
        json(200, { path: relPath, parent, entries: dirEntries });
      } catch {
        json(200, { path: relPath, parent: null, entries: [] });
      }
    } else if (subPath === '/files/read' && method === 'GET') {
      // Read file content
      const { readFileSync, statSync: fStatSync } = await import('node:fs');
      const { resolve: resolvePath } = await import('node:path');
      const cfg = fd.project.getConfig();
      const projectCwd = cfg.cwd ?? fd.project.subpath('.');
      const filePath = url.searchParams.get('path');
      if (!filePath) { json(400, { error: 'Missing path parameter' }); return; }
      const absPath = resolvePath(projectCwd, filePath);
      if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return; }
      try {
        const st = fStatSync(absPath);
        const ext = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : '';
        const textExts = new Set(['md','txt','json','yaml','yml','ts','tsx','js','jsx','dart','py','rs','toml','cfg','sh','html','css','sql','lock','env','gitignore','xml','csv','log','ini','conf','rb','go','java','c','cpp','h','hpp','bat','makefile','dockerfile','ps1','properties']);
        const imageExts: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        const audioExts: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/opus' };
        if (imageExts[ext]) {
          const buf = readFileSync(absPath);
          res.writeHead(200, { 'Content-Type': imageExts[ext], 'Content-Length': buf.length.toString(), 'Cache-Control': 'no-cache' });
          res.end(buf);
        } else if (audioExts[ext]) {
          const buf = readFileSync(absPath);
          res.writeHead(200, { 'Content-Type': audioExts[ext], 'Content-Length': buf.length.toString() });
          res.end(buf);
        } else if (textExts.has(ext) || st.size < 512 * 1024) {
          // Treat as text if known ext or small enough
          try {
            const content = readFileSync(absPath, 'utf-8');
            json(200, { content, size: st.size, mimeType: 'text/plain' });
          } catch {
            json(200, { size: st.size, mimeType: 'application/octet-stream', binary: true });
          }
        } else {
          json(200, { size: st.size, mimeType: 'application/octet-stream', binary: true });
        }
      } catch (e: unknown) {
        json(404, { error: `File not found: ${filePath}` });
      }
    } else if (subPath === '/files/write' && method === 'PUT') {
      // Write file content
      const { writeFileSync, mkdirSync: mkdirSyncFs } = await import('node:fs');
      const { resolve: resolvePath, dirname } = await import('node:path');
      const cfg = fd.project.getConfig();
      const projectCwd = cfg.cwd ?? fd.project.subpath('.');
      try {
        const body = await readBody();
        if (!body.path || typeof body.content !== 'string') { json(400, { error: 'Missing path or content' }); return; }
        const absPath = resolvePath(projectCwd, body.path);
        if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return; }
        const ext = body.path.includes('.') ? body.path.split('.').pop()!.toLowerCase() : '';
        const textExts = new Set(['md','txt','json','yaml','yml','ts','tsx','js','jsx','dart','py','rs','toml','cfg','sh','html','css','sql','lock','env','gitignore','xml','csv','log','ini','conf','rb','go','java','c','cpp','h','hpp','bat','makefile','dockerfile','ps1','properties']);
        if (!textExts.has(ext)) { json(400, { error: 'Only text files can be written' }); return; }
        mkdirSyncFs(dirname(absPath), { recursive: true });
        writeFileSync(absPath, body.content, 'utf-8');
        json(200, { success: true, path: body.path });
      } catch (e: unknown) {
        json(400, { error: e instanceof Error ? e.message : 'Write failed' });
      }
    } else if (subPath === '/upload' && method === 'POST') {
      // File upload: multipart/form-data or base64 JSON
      const { mkdirSync: mkdirSyncFs, writeFileSync: writeFileSyncFs } = await import('node:fs');
      const { join: pjoinFs, resolve: resolvePathFs } = await import('node:path');
      const uploadDir = pjoinFs(fd.project.subpath('.'), 'uploads');
      mkdirSyncFs(uploadDir, { recursive: true });

      const ct = req.headers['content-type'] ?? '';
      const MAX_UPLOAD = 10 * 1024 * 1024;

      if (ct.includes('multipart/form-data')) {
        // Parse multipart manually (simple single-file)
        const raw = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_UPLOAD) { req.destroy(); reject(new Error('Too large')); } chunks.push(chunk); });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
        const boundaryMatch = ct.match(/boundary=([^;]+)/);
        if (!boundaryMatch) { json(400, { error: 'Missing boundary' }); return; }
        const boundary = boundaryMatch[1].trim();
        const sep = Buffer.from('--' + boundary);
        const parts = [];
        let start = 0;
        while (true) {
          const idx = raw.indexOf(sep, start);
          if (idx === -1) break;
          if (start > 0) parts.push(raw.subarray(start, idx));
          start = idx + sep.length;
          // skip CRLF
          if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
        }
        if (parts.length === 0) { json(400, { error: 'No file in upload' }); return; }
        // Parse first part
        const part = parts[0];
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { json(400, { error: 'Malformed multipart' }); return; }
        const headerStr = part.subarray(0, headerEnd).toString();
        const fileData = part.subarray(headerEnd + 4, part.length - 2); // strip trailing CRLF
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        const origName = fnMatch ? fnMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_') : 'file';
        const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
        const mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
        const uniqueName = `${Date.now()}-${origName}`;
        const filePath = pjoinFs(uploadDir, uniqueName);
        writeFileSyncFs(filePath, fileData);
        json(200, { url: `/api/projects/${encodeURIComponent(projectName)}/uploads/${uniqueName}`, filename: origName, size: fileData.length, mimeType });
      } else {
        // JSON base64 body
        try {
          const body = await readBody();
          if (!body.data || !body.filename) { json(400, { error: 'Missing data or filename' }); return; }
          const base64 = body.data.replace(/^data:[^;]+;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          if (buf.length > MAX_UPLOAD) { json(400, { error: 'Too large' }); return; }
          const origName = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const uniqueName = `${Date.now()}-${origName}`;
          const filePath = pjoinFs(uploadDir, uniqueName);
          writeFileSyncFs(filePath, buf);
          json(200, { url: `/api/projects/${encodeURIComponent(projectName)}/uploads/${uniqueName}`, filename: origName, size: buf.length, mimeType: body.mimeType ?? 'application/octet-stream' });
        } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Upload failed' }); }
      }
    } else if (subPath?.startsWith('/uploads/') && method === 'GET') {
      // Serve uploaded files
      const { readFileSync: readFileSyncFs, existsSync: existsSyncFs } = await import('node:fs');
      const { join: pjoinFs, resolve: resolvePathFs, basename: basenameFs } = await import('node:path');
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.pdf': 'application/pdf' };
      const uploadDir = pjoinFs(fd.project.subpath('.'), 'uploads');
      const reqFile = decodeURIComponent(subPath.replace('/uploads/', ''));
      // Path traversal protection
      const safeName = basenameFs(reqFile);
      const filePath = resolvePathFs(uploadDir, safeName);
      if (!filePath.startsWith(resolvePathFs(uploadDir)) || !existsSyncFs(filePath)) {
        json(404, { error: 'File not found' }); return;
      }
      const data = readFileSyncFs(filePath);
      const ext = safeName.includes('.') ? '.' + safeName.split('.').pop()!.toLowerCase() : '';
      const contentType = mimeMap[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length.toString(), 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });

  return httpServer;
}

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Flightdeck } from '../facade.js';
import type { LeadManager } from '../lead/LeadManager.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { WebhookNotifier } from '../integrations/WebhookNotifier.js';
import type { AgentManager } from '../agents/AgentManager.js';
import type { CronStore } from '../cron/CronStore.js';

import { handleGlobalRoutes } from './routes/global.js';
import { handleProjectRoutes } from './routes/projects.js';
import { handleMessageRoutes } from './routes/messages.js';
import { handleTaskRoutes } from './routes/tasks.js';
import { handleAgentRoutes } from './routes/agents.js';
import { handleConfigRoutes } from './routes/config.js';
import { handleMiscRoutes } from './routes/misc.js';

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
  let modRegistry: typeof import('../agents/ModelRegistry.js').modelRegistry | null = null;
  let displayModule: typeof import('@flightdeck-ai/shared') | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serverDisplayConfig: any = null;

  const ensureModules = async () => {
    if (presetNames.length === 0) {
      const { PRESET_NAMES } = await import('../agents/ModelConfig.js');
      presetNames = PRESET_NAMES;
    }
    if (!modRegistry) {
      modRegistry = (await import('../agents/ModelRegistry.js')).modelRegistry;
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

    // ── Global routes (non-project-scoped) ──
    if (await handleGlobalRoutes(url, method, { projectManager, port, json, readBody })) return;

    // ── Project CRUD routes ──
    if (await handleProjectRoutes(url, method, {
      projectManager, leadManagers, agentManagers, wsServers, webhookNotifiers, cronStores,
      onProjectSetup, modelCfgCache, json, readBody, ensureModules, getModelConfig,
      modRegistry, presetNames, displayModule, serverDisplayConfig,
      setServerDisplayConfig: (cfg: any) => { serverDisplayConfig = cfg; },
    })) return;

    // ── Project-scoped routes ──
    const m = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); res.end('Not found'); return; }

    const projectName = decodeURIComponent(m[1]);
    const subPath = m[2] || '/';

    const fd = projectManager.get(projectName);
    if (!fd) { json(404, { error: `Project "${projectName}" not found` }); return; }

    const scopedDeps = {
      fd, projectName, req, res, url, json, readBody,
      wsServer: wsServers.get(projectName),
      leadManager: leadManagers.get(projectName),
      notifier: webhookNotifiers?.get(projectName),
      agentManagers, leadManagers, cronStores, modelCfgCache,
      getModelConfig, modRegistry, presetNames, displayModule, serverDisplayConfig,
      setServerDisplayConfig: (cfg: any) => { serverDisplayConfig = cfg; },
    };

    if (await handleMessageRoutes(subPath, method, scopedDeps)) return;
    if (await handleTaskRoutes(subPath, method, scopedDeps)) return;
    if (await handleAgentRoutes(subPath, method, scopedDeps)) return;
    if (await handleConfigRoutes(subPath, method, scopedDeps)) return;
    if (await handleMiscRoutes(subPath, method, scopedDeps)) return;

    res.writeHead(404); res.end('Not found');
  });

  return httpServer;
}

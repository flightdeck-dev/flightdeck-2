import { ProjectManager } from '../projects/ProjectManager.js';
import type { Flightdeck } from '../facade.js';
import { saveGatewayState, loadGatewayState, clearGatewayState, loadReloadConfig, markReloadFailed, clearReloadFailed, type SavedSession } from './gatewayState.js';

export interface GatewayDeps {
  port: number;
  corsOrigin: string;
  noRecover: boolean;
  /** If set, only serve this project. Otherwise serve all. */
  projectFilter?: string;
  /** Bind address: '127.0.0.1' (default), '0.0.0.0', or specific IP. */
  bindAddress?: string;
  /** Auth mode: 'none' or 'token'. */
  authMode?: 'none' | 'token';
  /** Auth token (when authMode='token'). */
  authToken?: string | null;
}

/**
 * Start the Flightdeck gateway: manages multiple projects,
 * spawns Lead/Planner per project, starts HTTP+WS server.
 */
export async function startGateway(deps: GatewayDeps): Promise<void> {
  const { port, corsOrigin, noRecover, projectFilter, bindAddress = '127.0.0.1', authMode = 'none', authToken = null } = deps;

  const { AcpAdapter: AcpAdapterClass } = await import('../agents/AcpAdapter.js');
  const { LeadManager } = await import('../lead/LeadManager.js');
  const { WebSocketServer: WsServer } = await import('../api/WebSocketServer.js');

  const acpAdapter = new AcpAdapterClass(undefined, process.env.FLIGHTDECK_RUNTIME || 'copilot');
  const projectManager = new ProjectManager(acpAdapter);

  // Handle agent process crashes: update SQLite status so we know
  acpAdapter.onSessionEnd = (sessionId, session) => {
    // Find the agent in any project's SQLite and mark it offline
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      const agents = fd.sqlite.listAgents();
      const agent = agents.find(a => a.acpSessionId === sessionId);
      if (agent) {
        const exitInfo = session.exitCode !== null ? ` (exit ${session.exitCode})` : '';
        console.error(`  [${name}] Agent ${agent.id} (${agent.role}) session ended${exitInfo}`);
        fd.sqlite.updateAgentStatus(agent.id, 'offline');
        break;
      }
    }
  };

  // Determine which projects to serve
  let projectNames = projectManager.list();
  if (projectFilter) {
    if (!projectNames.includes(projectFilter)) {
      console.error(`Project "${projectFilter}" not found. Available: ${projectNames.join(', ') || '(none)'}`);
      process.exit(1);
    }
    projectNames = [projectFilter];
  }

  if (projectNames.length === 0) {
    console.error('No projects found in ~/.flightdeck/projects/. Create one with `flightdeck init <name>`.');
    process.exit(1);
  }

  console.error(`Starting Flightdeck gateway for ${projectNames.length} project(s): ${projectNames.join(', ')}`);

  // --- Session reload: three-layer protection ---
  // Layer 1: reload-config.json — master switch + role filter
  // Layer 2: lastReloadFailed flag — if previous reload crashed, don't retry
  // Layer 3: --no-recover CLI flag (existing)
  const reloadConfig = loadReloadConfig();
  let savedState: ReturnType<typeof loadGatewayState> = null;

  if (noRecover) {
    console.error('Session reload disabled (--no-recover flag).');
  } else if (!reloadConfig.enabled) {
    console.error('Session reload disabled by reload-config.json.');
  } else {
    const rawState = loadGatewayState();
    if (rawState?.lastReloadFailed) {
      console.error('Session reload skipped: previous reload failed. Clear ~/.flightdeck/gateway-state.json to retry.');
    } else if (rawState && rawState.sessions.length > 0) {
      // Filter sessions by allowed roles
      const allowedRoles = new Set(reloadConfig.roles ?? ['lead']);
      const filtered = rawState.sessions.filter(s => allowedRoles.has(s.role));
      const skipped = rawState.sessions.length - filtered.length;
      if (skipped > 0) {
        console.error(`Reload: skipping ${skipped} session(s) with non-reloadable roles (allowed: ${[...allowedRoles].join(', ')}).`);
      }
      if (filtered.length > 0) {
        savedState = { ...rawState, sessions: filtered };
        console.error(`Found saved state from ${rawState.savedAt} with ${filtered.length} reloadable session(s).`);
      } else {
        console.error('No reloadable sessions found in saved state.');
      }
    }
  }
  // Clear state file regardless — we'll save fresh on next shutdown
  clearGatewayState();

  const leadManagers = new Map<string, InstanceType<typeof LeadManager>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsServers = new Map<string, any>();
  const orchestrators: Array<{ stop: () => void; start: () => void }> = [];
  const { WebhookNotifier } = await import('../integrations/WebhookNotifier.js');
  const webhookNotifiers = new Map<string, InstanceType<typeof WebhookNotifier>>();

  for (const name of projectNames) {
    const fd = projectManager.get(name)!;
    const profile = fd.status().config.governance;
    console.error(`\n── Project: ${name} (profile: ${profile}) ──`);

    // Clean up stale agents
    const activeAgents = fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle');
    if (noRecover && activeAgents.length > 0) {
      console.error(`  Marking ${activeAgents.length} existing agents offline (--no-recover).`);
      for (const agent of activeAgents) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fd.sqlite.updateAgentStatus(agent.id as any, 'offline');
      }
    } else if (activeAgents.length > 0) {
      console.error(`  Marking ${activeAgents.length} stale agent(s) offline (will attempt session recovery).`);
      for (const agent of activeAgents) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fd.sqlite.updateAgentStatus(agent.id as any, 'offline');
      }
    }

    // Create LeadManager
    const leadManager = new LeadManager({
      sqlite: fd.sqlite,
      project: fd.project,
      messageStore: fd.chatMessages ?? undefined,
      acpAdapter,
      projectName: name,
    });
    leadManagers.set(name, leadManager);

    // Create WebSocketServer
    const wsServer = fd.chatMessages ? new WsServer(fd.chatMessages) : null;
    if (wsServer) wsServers.set(name, wsServer);

    // Wire orchestrator
    fd.orchestrator.stop();
    const { Orchestrator: OrchestratorClass } = await import('../orchestrator/Orchestrator.js');
    const projectConfig = fd.project.getConfig();
    const orchestrator = new OrchestratorClass(
      fd.dag, fd.sqlite, fd.governance, acpAdapter, { ...projectConfig, cwd: fd.project.subpath('.') },
      undefined,
      {
        agentManager: fd.agentManager,
        leadManager,
        messageStore: fd.chatMessages ?? undefined,
        wsServer: wsServer ?? undefined,
        governanceConfig: { costThresholdPerDay: projectConfig.costThresholdPerDay },
        notifications: projectConfig.notifications,
      },
    );
    orchestrator.start();
    orchestrators.push(orchestrator);
    const whNotifier = orchestrator.getWebhookNotifier();
    webhookNotifiers.set(name, whNotifier);
    console.error(`  Orchestrator running.`);

    // Write .mcp.json to project cwd (once per project, not per-agent).
    // Role env is injected per-process in AcpAdapter.spawn() via process env,
    // which MCP subprocess inherits.
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { resolve: resolvePath, dirname: dirnamePath } = await import('node:path');
      const { fileURLToPath: futp } = await import('node:url');
      const mcpBinPath = resolvePath(dirnamePath(futp(import.meta.url)), '../../bin/flightdeck-mcp.mjs');
      const mcpJson = JSON.stringify({
        mcpServers: {
          flightdeck: {
            command: 'node',
            args: [mcpBinPath, '--project', name],
          },
        },
      }, null, 2);
      writeFileSync(resolvePath(process.cwd(), '.mcp.json'), mcpJson);
      console.error(`  Wrote .mcp.json (MCP server: ${mcpBinPath})`);
    } catch (err) {
      console.error(`  Warning: failed to write .mcp.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Spawn Lead + Planner (with session recovery if available)
    const projectSessions = savedState?.sessions.filter(s => s.project === name) ?? [];
    await spawnAgents(fd, leadManager, name, projectSessions);

    // Wire WS user messages to Lead
    if (wsServer) {
      wireWsToLead(wsServer, leadManager, fd, name, webhookNotifiers.get(name));
    }
  }

  // Start HTTP server
  const { createHttpServer } = await import('../api/HttpServer.js');

  // Set up auth if enabled
  let authCheckFn: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean) | undefined;
  if (authMode === 'token' && authToken) {
    const { createAuthCheck } = await import('./gateway/auth.js');
    authCheckFn = createAuthCheck('token', authToken);
  }

  const httpServer = createHttpServer({
    projectManager,
    leadManagers,
    port,
    corsOrigin,
    wsServers,
    authCheck: authCheckFn,
    webhookNotifiers,
  });

  // Wire WebSocket upgrade for all projects
  const wsModule = await import('ws');
  const wss = new wsModule.WebSocketServer({ server: httpServer });
  let clientCounter = 0;
  const { DEFAULT_DISPLAY } = await import('@flightdeck-ai/shared');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wss.on('connection', (socket: any, req: any) => {
    // Auth check for WebSocket connections
    if (authMode === 'token' && authToken) {
      const wsAuthUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      const queryToken = wsAuthUrl.searchParams.get('token');
      const authHeader = req.headers.authorization;
      const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const providedToken = queryToken || headerToken;
      if (!providedToken || providedToken !== authToken) {
        socket.close(4401, 'Unauthorized');
        return;
      }
    }

    // Determine project from URL path: /ws/:projectName
    const wsUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
    const wsMatch = wsUrl.pathname.match(/^\/ws\/([^/]+)$/);
    const wsProjectName = wsMatch ? decodeURIComponent(wsMatch[1]) : projectNames[0];
    const wsServer = wsServers.get(wsProjectName);
    if (!wsServer) { socket.close(4004, 'Project not found'); return; }

    const clientId = `ws-${wsProjectName}-${++clientCounter}`;
    const client = { id: clientId, send: (data: string) => { try { socket.send(data); } catch {} } };
    wsServer.addClient(client);
    wsServer.setDisplayConfig(clientId, { ...DEFAULT_DISPLAY });
    wsServer.sendTo(clientId, { type: 'display:config', config: { ...DEFAULT_DISPLAY } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on('message', (raw: any) => {
      try { wsServer.handleEvent(clientId, JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => wsServer.removeClient(clientId));
  });

  httpServer.listen(port, bindAddress, () => {
    // Set FLIGHTDECK_URL so MCP subprocesses can relay agent operations back to gateway
    process.env.FLIGHTDECK_URL = `http://${bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress}:${port}`;
    console.error(`\nHTTP server listening on ${bindAddress}:${port}.`);
    console.error(`Projects: ${projectNames.join(', ')}`);
    console.error(`WebSocket: connect to /ws/:projectName`);
    if (authMode === 'token') console.error(`Auth: token required`);
  });

  // Helper: collect active sessions for state persistence
  const collectSessions = (): SavedSession[] => {
    const sessions: SavedSession[] = [];
    for (const [projectName, lm] of leadManagers.entries()) {
      const leadSid = lm.getLeadSessionId();
      const plannerSid = lm.getPlannerSessionId();

      if (leadSid) {
        const acpSid = acpAdapter.getAcpSessionId(leadSid);
        const s = acpAdapter.getSession(leadSid);
        if (acpSid && s && s.status !== 'ended') {
          sessions.push({
            project: projectName,
            agentId: s.agentId,
            role: 'lead',
            acpSessionId: acpSid,
            localSessionId: leadSid,
            cwd: s.cwd,
            model: s.model,
          });
        }
      }

      if (plannerSid) {
        const acpSid = acpAdapter.getAcpSessionId(plannerSid);
        const s = acpAdapter.getSession(plannerSid);
        if (acpSid && s && s.status !== 'ended') {
          sessions.push({
            project: projectName,
            agentId: s.agentId,
            role: 'planner',
            acpSessionId: acpSid,
            localSessionId: plannerSid,
            cwd: s.cwd,
            model: s.model,
          });
        }
      }
    }
    return sessions;
  };

  // Graceful shutdown
  const shutdown = () => {
    console.error('\nStopping Flightdeck gateway...');

    // Save session state before cleanup
    const sessions = collectSessions();
    if (sessions.length > 0) {
      saveGatewayState({ savedAt: new Date().toISOString(), sessions });
    }

    for (const o of orchestrators) o.stop();
    for (const lm of leadManagers.values()) lm.stop();
    acpAdapter.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wss as any).close();
    httpServer.close();
    projectManager.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // SIGUSR1: hot reload — re-scan projects, restart orchestrators, keep agent processes alive
  process.on('SIGUSR1', () => {
    console.error('\nSIGUSR1 received: hot-reloading configuration...');
    try {
      // Re-scan projects
      const newNames = projectManager.list();
      const added = newNames.filter(n => !projectNames.includes(n));
      if (added.length > 0) {
        console.error(`  New projects detected: ${added.join(', ')}`);
      }
      for (const o of orchestrators) {
        try { o.stop(); } catch {}
      }
      for (const o of orchestrators) {
        try { o.start(); console.error(`  Orchestrator restarted.`); } catch {}
      }
      console.error('Hot reload complete.');
    } catch (err) {
      console.error('Hot reload failed:', err);
    }
  });
  process.on('uncaughtException', (err) => {
    console.error('\nFatal uncaught exception:', err);
    // Best-effort state save on crash
    try {
      const sessions = collectSessions();
      if (sessions.length > 0) {
        saveGatewayState({ savedAt: new Date().toISOString(), sessions });
      }
    } catch {}
    try { acpAdapter.clear(); } catch {}
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('\nUnhandled rejection (non-fatal):', reason);
    // Don't crash — many rejections are transient (network errors, agent timeouts).
    // Node 15+ will eventually crash on truly unhandled rejections.
  });
}

async function spawnAgents(
  fd: Flightdeck,
  leadManager: {
    spawnLead(): Promise<string>;
    spawnPlanner(): Promise<string>;
    resumeLead(prevAcpSessionId: string, cwd: string, model?: string): Promise<string>;
    resumePlanner(prevAcpSessionId: string, cwd: string, model?: string): Promise<string>;
    setSuspendedPlanner(info: { acpSessionId: string; cwd: string; model?: string }): void;
  },
  projectName: string,
  savedSessions: SavedSession[] = [],
): Promise<void> {
  const agents = fd.listAgents();
  const hasLead = agents.some(a => a.role === 'lead' && (a.status === 'busy' || a.status === 'idle'));
  const hasPlanner = agents.some(a => a.role === 'planner' && (a.status === 'busy' || a.status === 'idle'));

  const savedLead = savedSessions.find(s => s.role === 'lead');
  const savedPlanner = savedSessions.find(s => s.role === 'planner');

  // Check if this project has active work (pending/ready/running/in_review tasks).
  // If the project is idle, don't waste memory reloading the Lead.
  const tasks = fd.listTasks();
  const activeTasks = tasks.filter(t =>
    t.state === 'pending' || t.state === 'ready' || t.state === 'running' || t.state === 'in_review'
  );
  const projectIsActive = activeTasks.length > 0;

  if (!hasLead) {
    if (!projectIsActive) {
      // Don't waste memory spawning/reloading a Lead for an idle project.
      // Lead will be spawned on-demand when new tasks arrive.
      console.error(`  [${projectName}] Skipping Lead — no active tasks (project idle).`);
    } else if (savedLead) {
      try {
        console.error(`  [${projectName}] Resuming Lead from session ${savedLead.acpSessionId}...`);
        const sid = await leadManager.resumeLead(savedLead.acpSessionId, savedLead.cwd, savedLead.model);
        console.error(`  [${projectName}] Lead resumed (session: ${sid})`);
        clearReloadFailed();
      } catch (err: unknown) {
        console.error(`  [${projectName}] Failed to resume Lead: ${err instanceof Error ? err.message : String(err)}`);
        markReloadFailed();
        console.error(`  [${projectName}] Marked reload as failed. Next startup will skip session reload.`);
        // Fall through to spawn fresh
        try {
          const sid = await leadManager.spawnLead();
          console.error(`  [${projectName}] Lead spawned fresh after failed resume (session: ${sid})`);
        } catch (err2: unknown) {
          console.error(`  [${projectName}] Failed to spawn Lead: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      }
    } else {
      try {
        const sid = await leadManager.spawnLead();
        console.error(`  [${projectName}] Lead spawned (session: ${sid})`);
      } catch (err: unknown) {
        console.error(`  [${projectName}] Failed to spawn Lead: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    console.error(`  [${projectName}] Lead already active.`);
  }

  if (!hasPlanner) {
    if (!projectIsActive) {
      console.error(`  [${projectName}] Skipping Planner — no active tasks (project idle).`);
    } else if (savedPlanner) {
      // Lazy resume: mark Planner as suspended, resume on-demand when Lead needs it
      console.error(`  [${projectName}] Suspending Planner (will resume on-demand from session ${savedPlanner.acpSessionId})`);
      leadManager.setSuspendedPlanner({
        acpSessionId: savedPlanner.acpSessionId,
        cwd: savedPlanner.cwd,
        model: savedPlanner.model,
      });
      // Register a suspended agent record in SQLite so it shows in status
      const { agentId: makeAgentId } = await import('@flightdeck-ai/shared');
      const suspendedId = makeAgentId('planner', Date.now().toString());
      fd.sqlite.insertAgent({
        id: suspendedId,
        role: 'planner',
        runtime: 'acp',
        acpSessionId: null,
        status: 'suspended',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });
    } else {
      // No saved session — spawn fresh (first run)
      try {
        const sid = await leadManager.spawnPlanner();
        console.error(`  [${projectName}] Planner spawned (session: ${sid})`);
      } catch (err: unknown) {
        console.error(`  [${projectName}] Failed to spawn Planner: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    console.error(`  [${projectName}] Planner already active.`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireWsToLead(wsServer: any, leadManager: { steerLead(event: any): Promise<string | null> }, fd: Flightdeck, projectName: string, notifier?: InstanceType<typeof import('../integrations/WebhookNotifier.js').WebhookNotifier> | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServer.on('user:message', (msg: any) => {
    (async () => {
      try {
        const response = await leadManager.steerLead({ type: 'user_message', message: msg });
        if (response?.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
          if (fd.chatMessages) {
            const leadMsg = fd.chatMessages.createMessage({
              threadId: msg.thread_id ?? null, parentId: msg.id ?? null, taskId: null,
              authorType: 'lead', authorId: 'lead', content: response.trim(), metadata: null,
            });
            wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
          }
          // Fire webhook for Lead response
          if (notifier) {
            const { leadResponseEvent } = await import('../integrations/WebhookNotifier.js');
            notifier.notify(leadResponseEvent(projectName, response.trim(), msg.content ?? ''));
          }
        }
      } catch (err) { console.error(`[${projectName}] Failed to steer Lead:`, err); }
    })();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServer.on('task:comment', ({ taskId, message: msg }: { taskId: string; message: any }) => {
    (async () => {
      try {
        const response = await leadManager.steerLead({ type: 'task_comment', taskId, message: msg });
        if (response?.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
          if (fd.chatMessages) {
            const leadMsg = fd.chatMessages.createMessage({
              threadId: null, parentId: null, taskId,
              authorType: 'lead', authorId: 'lead', content: response.trim(), metadata: null,
            });
            wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: leadMsg });
          }
          // Fire webhook for Lead response (task comment)
          if (notifier) {
            const { leadResponseEvent } = await import('../integrations/WebhookNotifier.js');
            notifier.notify(leadResponseEvent(projectName, response.trim(), msg.content ?? ''));
          }
        }
      } catch (err) { console.error(`[${projectName}] Failed to steer Lead (task comment):`, err); }
    })();
  });
}

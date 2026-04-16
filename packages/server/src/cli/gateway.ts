import { ProjectManager } from '../projects/ProjectManager.js';
import type { Flightdeck } from '../facade.js';
import { messageId as makeMessageId } from '@flightdeck-ai/shared';
import { saveGatewayState, loadGatewayState, clearGatewayState, loadReloadConfig, saveAgentPids, clearAgentPids, cleanupOrphanedAgents, type SavedSession } from './gatewayState.js';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FD_HOME } from './constants.js';
import { CronStore } from '../cron/CronStore.js';
import { CronScheduler } from '../cron/CronScheduler.js';

export interface GatewayDeps {
  port: number;
  corsOrigin: string;
  noRecover: boolean;
  /** If true, aggressively resume all workers on restart. */
  continueWorkers?: boolean;
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
  const { port, corsOrigin, noRecover, continueWorkers = false, projectFilter, bindAddress = '127.0.0.1', authMode = 'none', authToken = null } = deps;

  const { AcpAdapter: AcpAdapterClass } = await import('../agents/AcpAdapter.js');
  const { PtyAdapter: PtyAdapterClass } = await import('../agents/PtyAdapter.js');
  const { MultiAdapter: MultiAdapterClass } = await import('../agents/MultiAdapter.js');
  const { LeadManager } = await import('../lead/LeadManager.js');
  const { WebSocketServer: WsServer } = await import('../api/WebSocketServer.js');

  // One-time migration: move v2 data from ~/.flightdeck/ to ~/.flightdeck/v2/
  const oldProjectsDir = join(homedir(), '.flightdeck', 'projects');
  const newProjectsDir = join(FD_HOME, 'projects');
  if (existsSync(oldProjectsDir) && !existsSync(newProjectsDir)) {
    console.error('Migrating v2 data to ~/.flightdeck/v2/...');
    mkdirSync(FD_HOME, { recursive: true });
    renameSync(oldProjectsDir, newProjectsDir);
    for (const f of ['gateway-state.json', 'agent-pids.json', 'reload-config.json']) {
      const old = join(homedir(), '.flightdeck', f);
      if (existsSync(old)) renameSync(old, join(FD_HOME, f));
    }
    console.error('Migration complete.');
  }

  // Clean up orphaned agent processes from a previous unclean shutdown
  await cleanupOrphanedAgents();

  const acpAdapter = new AcpAdapterClass(undefined, process.env.FLIGHTDECK_RUNTIME || 'codex');
  const ptyAdapter = new PtyAdapterClass(undefined, 'claude');
  const multiAdapter = new MultiAdapterClass(acpAdapter, ptyAdapter);
  const projectManager = new ProjectManager(multiAdapter);

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
        // Broadcast state change so UI updates immediately
        const ws = wsServers.get(name);
        if (ws) {
          ws.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        }
        break;
      }
    }
  };

  // Broadcast all agent streaming output to WebSocket clients
  acpAdapter.onAnySessionOutput = (agentId, update) => {
    // Broadcast to all project WS servers
    for (const wsServer of wsServers.values()) {
      let delta = '';
      let contentType: 'text' | 'thinking' | 'tool_call' | 'tool_result' = 'text';
      let toolName: string | undefined;

      switch ((update as any).sessionUpdate) {
        case 'agent_message_chunk':
          if ((update as any).content?.type === 'text') {
            delta = (update as any).content.text;
            contentType = 'text';
          }
          break;
        case 'agent_thought_chunk':
          if ((update as any).content?.type === 'text') {
            delta = (update as any).content.text;
            contentType = 'thinking';
          }
          break;
        case 'tool_call':
          toolName = (update as any).title ?? '';
          if (!toolName) break; // Skip empty — wait for tool_call_update
          delta = JSON.stringify({ toolCallId: (update as any).toolCallId, name: toolName, input: (update as any).rawInput ? JSON.stringify((update as any).rawInput) : ((update as any).input ? JSON.stringify((update as any).input) : ''), status: (update as any).status ?? 'pending' });
          contentType = 'tool_call';
          break;
        case 'tool_call_update': {
          toolName = (update as any).title ?? '';
          let resultText = '';
          if ((update as any).content && Array.isArray((update as any).content)) {
            resultText = (update as any).content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          }
          delta = JSON.stringify({ toolCallId: (update as any).toolCallId, name: toolName, result: resultText, status: (update as any).status ?? 'completed' });
          contentType = 'tool_result';
          break;
        }
        default:
          return;
      }

      if (delta) {
        wsServer.broadcast({ type: 'agent:stream', agentId, delta, contentType, toolName } as any);
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
    } else if (rawState && Array.isArray(rawState.sessions) && rawState.sessions.length > 0) {
      // Filter sessions by allowed roles (workers are always kept for recovery/pause logic)
      const allowedRoles = new Set(reloadConfig.roles ?? ['lead']);
      const filtered = rawState.sessions.filter(s => allowedRoles.has(s.role) || !['lead', 'planner'].includes(s.role));
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
  const cronSchedulers: Array<{ stop: () => void }> = [];
  const { WebhookNotifier } = await import('../integrations/WebhookNotifier.js');
  const webhookNotifiers = new Map<string, InstanceType<typeof WebhookNotifier>>();
  const cronStores = new Map<string, InstanceType<typeof CronStore>>();

  // Set FLIGHTDECK_URL early so MCP subprocesses (spawned during agent init) inherit it.
  // This must happen BEFORE spawnAgents() so Lead/Planner MCP can relay back to gateway.
  process.env.FLIGHTDECK_URL = `http://${bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress}:${port}`;

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

    // Read per-role runtime config from .flightdeck/config.yaml
    const { ModelConfig } = await import('../agents/ModelConfig.js');
    const modelConfig = new ModelConfig(fd.project.subpath('.'));
    const leadRoleConfig = modelConfig.getRoleConfig('lead');
    const plannerRoleConfig = modelConfig.getRoleConfig('planner');

    // Create LeadManager
    const projectConfig = fd.project.getConfig();
    const projectCwd = fd.status().config.cwd ?? process.cwd();
    const leadManager = new LeadManager({
      sqlite: fd.sqlite,
      project: fd.project,
      messageStore: fd.messages ?? undefined,
      acpAdapter,
      projectName: name,
      cwd: projectCwd,
      leadRuntime: leadRoleConfig.runtime,
      plannerRuntime: plannerRoleConfig.runtime,
      heartbeat: {
        enabled: projectConfig.heartbeatEnabled !== false,
        interval: 30 * 60 * 1000,
        conditions: [],
        idleTimeoutDays: projectConfig.heartbeatIdleTimeoutDays ?? 3,
      },
    });
    leadManagers.set(name, leadManager);

    // Create and start cron scheduler
    const cronStore = new CronStore(fd.project.subpath('.'));
    cronStores.set(name, cronStore);
    const cronScheduler = new CronScheduler(cronStore, async (job) => {
      const response = await leadManager.steerLead({
        type: 'cron',
        job: { id: job.id, name: job.name, prompt: job.prompt, skill: job.skill },
      });
      return response;
    });
    cronScheduler.start();
    cronSchedulers.push(cronScheduler);

    // Create WebSocketServer
    const wsServer = fd.messages ? new WsServer(fd.messages) : null;
    if (wsServer) wsServers.set(name, wsServer);

    // Wire orchestrator
    fd.orchestrator.stop();
    const { Orchestrator: OrchestratorClass } = await import('../orchestrator/Orchestrator.js');
    const orchestrator = new OrchestratorClass(
      fd.dag, fd.sqlite, fd.governance, acpAdapter, { ...projectConfig, cwd: fd.project.subpath('.') },
      undefined,
      {
        agentManager: fd.agentManager,
        leadManager,
        messageStore: fd.messages ?? undefined,
        wsServer: wsServer ?? undefined,
        governanceConfig: { costThresholdPerDay: projectConfig.costThresholdPerDay },
        notifications: projectConfig.notifications as import('../integrations/WebhookNotifier.js').NotificationsConfig | undefined,
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

    // Worker recovery
    const workerSessions = projectSessions.filter(s => !['lead', 'planner'].includes(s.role));
    if (workerSessions.length > 0 && !noRecover) {
      await recoverWorkers(fd, leadManager, acpAdapter, name, workerSessions, continueWorkers);
    }

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
    cronStores,
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
    console.error(`\nHTTP server listening on ${bindAddress}:${port}.`);
    console.error(`Projects: ${projectNames.join(', ')}`);
    console.error(`WebSocket: connect to /ws/:projectName`);
    if (authMode === 'token') console.error(`Auth: token required`);

    // Auto-discover models for installed runtimes (background, best-effort)
    import('../agents/AcpAdapter.js').then(({ discoverRuntimeModels }) => {
      import('../agents/runtimes.js').then(({ RUNTIME_REGISTRY }) => {
        import('node:child_process').then(({ execFileSync }) => {
          const runtimeIds = Object.entries(RUNTIME_REGISTRY)
            .filter(([, r]) => r.supportsAcp)
            .map(([id]) => id);
          const installed = runtimeIds.filter(id => {
            try { execFileSync('which', [RUNTIME_REGISTRY[id].command], { stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; }
          });
          if (installed.length === 0) return;
          console.error(`Discovering models for: ${installed.join(', ')}...`);
          (async () => {
            for (const id of installed) {
              try {
                const models = await discoverRuntimeModels(id);
                console.error(`  ${id}: ${models.length} models discovered`);
              } catch (e) {
                console.error(`  ${id}: discovery failed — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
              }
            }
          })();
        });
      });
    });
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

      // Save worker sessions
      const fd = projectManager.get(projectName);
      if (fd) {
        const workerAgents = fd.listAgents().filter(a =>
          a.status === 'busy' && a.acpSessionId && !['lead', 'planner'].includes(a.role)
        );
        for (const agent of workerAgents) {
          // Workers spawned via HTTP relay have their acpSessionId in the DB.
          // Use it directly instead of looking up via AcpAdapter (which may not track relay-spawned workers).
          sessions.push({
            project: projectName,
            agentId: agent.id as string,
            role: agent.role,
            acpSessionId: agent.acpSessionId!,
            localSessionId: agent.acpSessionId!,
            cwd: process.cwd(),
            status: 'active',
          });
        }
      }
    }
    return sessions;
  };

  // Graceful shutdown
  const shutdown = () => {
    console.error('\nStopping Flightdeck gateway...');
    clearInterval(stateSaveTimer);

    // Save session state before cleanup
    const sessions = collectSessions();
    if (sessions.length > 0) {
      saveGatewayState({ savedAt: new Date().toISOString(), sessions });
    }

    for (const o of orchestrators) o.stop();
    for (const cs of cronSchedulers) cs.stop();
    for (const lm of leadManagers.values()) lm.stop();
    acpAdapter.clear();
    // Clean up PID tracking — graceful shutdown means no orphans
    clearAgentPids();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wss as any).close();
    httpServer.close();
    projectManager.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Periodic state persistence — saves sessions every 30s as a safety net.
  // Handles cases where SIGTERM doesn't reach the process (e.g. npx/tsx wrappers,
  // SIGKILL, OOM kills). On restart, the latest state file is used for recovery.
  const STATE_SAVE_INTERVAL = 30_000;
  const stateSaveTimer = setInterval(() => {
    try {
      const sessions = collectSessions();
      if (sessions.length > 0) {
        saveGatewayState({ savedAt: new Date().toISOString(), sessions });
      }
      // Also persist child PIDs for orphan detection on unclean restart
      const childPids = acpAdapter.getChildPids();
      if (childPids.length > 0) {
        saveAgentPids(process.pid, childPids);
      } else {
        clearAgentPids();
      }
    } catch { /* best effort — don't crash the gateway */ }
  }, STATE_SAVE_INTERVAL);
  stateSaveTimer.unref(); // Don't prevent process exit

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
    setSuspendedLead(info: { acpSessionId: string; cwd: string; model?: string }): void;
  },
  projectName: string,
  savedSessions: SavedSession[] = [],
): Promise<void> {
  const agents = fd.listAgents();
  const hasLead = agents.some(a => a.role === 'lead' && (a.status === 'busy' || a.status === 'idle'));
  const hasPlanner = agents.some(a => a.role === 'planner' && (a.status === 'busy' || a.status === 'idle'));

  const savedLead = savedSessions.find(s => s.role === 'lead');
  const savedPlanner = savedSessions.find(s => s.role === 'planner');

  // On restart, all agents hibernate by default. They wake on-demand when
  // there's actual work (user message, task event, etc.). This avoids
  // spawning many processes simultaneously on gateway start.

  if (!hasLead) {
    if (savedLead) {
      // Hibernate Lead — will auto-wake on first steerLead() call
      console.error(`  [${projectName}] Lead → hibernated (will wake on-demand from session ${savedLead.acpSessionId})`);
      leadManager.setSuspendedLead({
        acpSessionId: savedLead.acpSessionId,
        cwd: savedLead.cwd,
        model: savedLead.model,
      });
      // Register a hibernated agent record in SQLite so it shows in status
      const { agentId: makeAgentId } = await import('@flightdeck-ai/shared');
      const suspendedId = makeAgentId('lead', Date.now().toString());
      fd.sqlite.insertAgent({
        id: suspendedId,
        role: 'lead',
        runtime: 'acp',
        acpSessionId: null,
        status: 'hibernated',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });
    } else {
      // No saved session — Lead will be spawned fresh on first steerLead() call
      console.error(`  [${projectName}] Lead — no saved session (will spawn on-demand).`);
    }
  } else {
    console.error(`  [${projectName}] Lead already active.`);
  }

  if (!hasPlanner) {
    if (savedPlanner) {
      // Lazy resume: mark Planner as suspended, resume on-demand when Lead needs it
      console.error(`  [${projectName}] Planner → hibernated (will resume on-demand from session ${savedPlanner.acpSessionId})`);
      leadManager.setSuspendedPlanner({
        acpSessionId: savedPlanner.acpSessionId,
        cwd: savedPlanner.cwd,
        model: savedPlanner.model,
      });
      // Register a hibernated agent record in SQLite so it shows in status
      const { agentId: makeAgentId } = await import('@flightdeck-ai/shared');
      const suspendedId = makeAgentId('planner', Date.now().toString());
      fd.sqlite.insertAgent({
        id: suspendedId,
        role: 'planner',
        runtime: 'acp',
        acpSessionId: null,
        status: 'hibernated',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });
    } else {
      // No saved session — Planner will be spawned fresh on-demand
      console.error(`  [${projectName}] Planner — no saved session (will spawn on-demand).`);
    }
  } else {
    console.error(`  [${projectName}] Planner already active.`);
  }
}

/**
 * Recover worker sessions from a previous gateway run.
 * - Default mode: pause worker tasks, mark agents hibernated, notify Lead
 * - --continue mode: aggressively resume all worker sessions
 */
async function recoverWorkers(
  fd: Flightdeck,
  leadManager: { steerLead(event: { type: 'worker_recovery'; message: string }): Promise<string> },
  acpAdapter: { resumeSession(opts: { previousSessionId: string; cwd: string; role: string; model?: string; projectName?: string }): Promise<{ agentId: string; sessionId: string }> },
  projectName: string,
  workerSessions: SavedSession[],
  continueWorkers: boolean,
): Promise<void> {
  const { agentId: makeAgentId } = await import('@flightdeck-ai/shared');
  const pausedTasks: Array<{ id: string; title: string }> = [];
  const resumedCount = { success: 0, failed: 0 };

  for (const ws of workerSessions) {
    // Find the task assigned to this worker
    const tasks = fd.listTasks();
    const assignedTask = tasks.find(t => t.assignedAgent === ws.agentId && t.state === 'running');

    if (continueWorkers) {
      // --continue: try to resume the worker session
      try {
        console.error(`  [${projectName}] Resuming worker ${ws.agentId} (${ws.role}) from session ${ws.acpSessionId}...`);
        const result = await acpAdapter.resumeSession({
          previousSessionId: ws.acpSessionId,
          cwd: ws.cwd,
          role: ws.role,
          model: ws.model,
          projectName,
        });

        // Re-register agent as busy
        fd.sqlite.insertAgent({
          id: result.agentId as any,
          role: ws.role as any,
          runtime: 'acp',
          acpSessionId: ws.acpSessionId,
          status: 'busy',
          currentSpecId: null,
          costAccumulated: 0,
          lastHeartbeat: null,
        });

        // Update task's assignedAgent to the new agent ID if it changed
        if (assignedTask && result.agentId !== ws.agentId) {
          fd.sqlite.updateTaskState(assignedTask.id as any, 'running', result.agentId as any);
        }

        resumedCount.success++;
        console.error(`  [${projectName}] Worker resumed: ${result.agentId} (session: ${result.sessionId})`);
      } catch (err: unknown) {
        console.error(`  [${projectName}] Failed to resume worker ${ws.agentId}: ${err instanceof Error ? err.message : String(err)}`);
        resumedCount.failed++;
        // Graceful degradation: pause the task
        if (assignedTask) {
          try {
            fd.sqlite.updateTaskState(assignedTask.id as any, 'paused' as any);
            pausedTasks.push({ id: assignedTask.id, title: assignedTask.title });
            console.error(`  [${projectName}] Paused task ${assignedTask.id} (${assignedTask.title})`);
          } catch (e) {
            console.error(`  [${projectName}] Failed to pause task ${assignedTask.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Register hibernated agent (preserving session for potential manual wake)
        const hibernatedId = makeAgentId(ws.role, Date.now().toString());
        fd.sqlite.insertAgent({
          id: hibernatedId,
          role: ws.role as any,
          runtime: 'acp',
          acpSessionId: ws.acpSessionId,
          status: 'hibernated',
          currentSpecId: null,
          costAccumulated: 0,
          lastHeartbeat: null,
        });
      }
    } else {
      // Default mode: pause task, mark agent hibernated (preserve session for potential wake)
      if (assignedTask) {
        try {
          fd.sqlite.updateTaskState(assignedTask.id as any, 'paused' as any);
          pausedTasks.push({ id: assignedTask.id, title: assignedTask.title });
          console.error(`  [${projectName}] Paused worker task ${assignedTask.id} (${assignedTask.title})`);
        } catch (e) {
          console.error(`  [${projectName}] Failed to pause task ${assignedTask.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Register hibernated agent with saved session ID
      const hibernatedId = makeAgentId(ws.role, Date.now().toString());
      fd.sqlite.insertAgent({
        id: hibernatedId,
        role: ws.role as any,
        runtime: 'acp',
        acpSessionId: ws.acpSessionId,
        status: 'hibernated',
        currentSpecId: null,
        costAccumulated: 0,
        lastHeartbeat: null,
      });
      console.error(`  [${projectName}] Worker ${ws.agentId} → hibernated (session: ${ws.acpSessionId}).`);
    }
  }

  // Notify Lead about worker recovery status (non-blocking — don't hold up gateway startup)
  if (pausedTasks.length > 0) {
    const summary = pausedTasks.map(t => `- ${t.title} (${t.id})`).join('\n');
    leadManager.steerLead({
      type: 'worker_recovery',
      message: `Session reloaded. ${pausedTasks.length} worker task(s) paused from previous session:\n${summary}\n\nUse flightdeck_agent_wake to resume hibernated workers, flightdeck_agent_retire to dismiss ones you don't need, or spawn new workers.`,
    }).then(() => {
      console.error(`  [${projectName}] Notified Lead about ${pausedTasks.length} paused worker task(s).`);
    }).catch((err: unknown) => {
      console.error(`  [${projectName}] Failed to notify Lead about paused workers: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  if (continueWorkers) {
    console.error(`  [${projectName}] Worker recovery: ${resumedCount.success} resumed, ${resumedCount.failed} failed.`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireWsToLead(wsServer: any, leadManager: { steerLead(event: any): Promise<string | null>; getLastMergedSourceIds?(): string[]; setStreamHandler?(handler: (update: any) => void): void; cancelLead?(): Promise<void> }, fd: Flightdeck, projectName: string, notifier?: InstanceType<typeof import('../integrations/WebhookNotifier.js').WebhookNotifier> | null): void {
  // Pre-generate message ID for stream↔final message consistency
  const msgIdRef = { current: makeMessageId('lead', Date.now().toString()) };

  // Wire streaming updates (tool calls, thoughts) from Lead to WebSocket
  if (leadManager.setStreamHandler && wsServer.streamChunk) {
    leadManager.setStreamHandler((update: any) => {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text') {
            wsServer.streamChunk(msgIdRef.current, update.content.text, false);
          }
          break;
        case 'agent_thought_chunk':
          if (update.content?.type === 'text') {
            wsServer.streamChunk(msgIdRef.current, update.content.text, false, 'thinking');
          }
          break;
        case 'tool_call': {
          const toolName = update.title ?? '';
          if (!toolName) break; // Skip empty tool calls — wait for tool_call_update with name
          const contentType = toolName.startsWith('flightdeck_') ? 'flightdeck_tool_call' : 'tool_call';
          const input = update.rawInput ? JSON.stringify(update.rawInput) : (update.input ? JSON.stringify(update.input) : '');
          const delta = JSON.stringify({ toolCallId: update.toolCallId, name: toolName, input, status: update.status ?? 'pending' });
          wsServer.streamChunk(msgIdRef.current, delta, false, contentType, toolName);
          break;
        }
        case 'tool_call_update': {
          const tcName = update.title ?? '';
          const ct = tcName.startsWith('flightdeck_') ? 'flightdeck_tool_result' : 'tool_result';
          // Extract text content from content array if present
          let resultText = '';
          if (update.content && Array.isArray(update.content)) {
            resultText = update.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
          }
          const delta = JSON.stringify({ toolCallId: update.toolCallId, name: tcName, result: resultText, status: update.status ?? 'completed' });
          wsServer.streamChunk(msgIdRef.current, delta, false, ct, tcName);
          break;
        }
      }
    });
    // Reset stream ID when a new user message comes in
    wsServer.on('user:message', () => {
      msgIdRef.current = makeMessageId('lead', Date.now().toString());
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServer.on('user:message', (msg: any) => {
    // Generate fresh ID for this response
    msgIdRef.current = makeMessageId('lead', Date.now().toString());
    (async () => {
      try {
        const response = await leadManager.steerLead({ type: 'user_message', message: msg });
        if (response?.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
          if (fd.messages) {
            // Check for merged source IDs (multi-parent reply)
            const mergedIds = leadManager.getLastMergedSourceIds?.() ?? [];
            const parentIds = mergedIds.length > 1 ? mergedIds : null;
            const leadMsg = fd.messages.createMessage({
              id: msgIdRef.current,
              threadId: msg.thread_id ?? null, parentId: msg.id ?? null, parentIds, taskId: null,
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
        // Broadcast state update so UI refreshes agent status (busy → idle)
        wsServer.broadcast({ type: 'state:update' as any, stats: fd.getTaskStats() } as any);
      } catch (err) { console.error(`[${projectName}] Failed to steer Lead:`, err); }
    })();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServer.on('chat:interrupt', () => {
    if (leadManager.cancelLead) {
      leadManager.cancelLead().catch((err) => console.error(`[${projectName}] Failed to cancel Lead:`, err));
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsServer.on('task:comment', ({ taskId, message: msg }: { taskId: string; message: any }) => {
    (async () => {
      try {
        const response = await leadManager.steerLead({ type: 'task_comment', taskId, message: msg });
        if (response?.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
          if (fd.messages) {
            const leadMsg = fd.messages.createMessage({
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

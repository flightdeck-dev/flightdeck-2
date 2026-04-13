import { ProjectManager } from '../projects/ProjectManager.js';
import type { Flightdeck } from '../facade.js';

export interface DaemonDeps {
  port: number;
  corsOrigin: string;
  noRecover: boolean;
  /** If set, only serve this project. Otherwise serve all. */
  projectFilter?: string;
}

/**
 * Start the Flightdeck daemon: manages multiple projects,
 * spawns Lead/Planner per project, starts HTTP+WS server.
 */
export async function startDaemon(deps: DaemonDeps): Promise<void> {
  const { port, corsOrigin, noRecover, projectFilter } = deps;

  const { AcpAdapter: AcpAdapterClass } = await import('../agents/AcpAdapter.js');
  const { LeadManager } = await import('../lead/LeadManager.js');
  const { WebSocketServer: WsServer } = await import('../api/WebSocketServer.js');

  const acpAdapter = new AcpAdapterClass(undefined, 'copilot');
  const projectManager = new ProjectManager(acpAdapter);

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

  console.error(`Starting Flightdeck daemon for ${projectNames.length} project(s): ${projectNames.join(', ')}`);

  const leadManagers = new Map<string, InstanceType<typeof LeadManager>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsServers = new Map<string, any>();
  const orchestrators: Array<{ stop: () => void }> = [];

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
      console.error(`  Marking ${activeAgents.length} stale agent(s) offline (session resume not yet implemented).`);
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
    });
    leadManagers.set(name, leadManager);

    // Create WebSocketServer
    const wsServer = fd.chatMessages ? new WsServer(fd.chatMessages) : null;
    if (wsServer) wsServers.set(name, wsServer);

    // Wire orchestrator
    fd.orchestrator.stop();
    const { Orchestrator: OrchestratorClass } = await import('../orchestrator/Orchestrator.js');
    const orchestrator = new OrchestratorClass(
      fd.dag, fd.sqlite, fd.governance, acpAdapter, fd.project.getConfig(),
      undefined,
      {
        agentManager: fd.agentManager,
        leadManager,
        messageStore: fd.chatMessages ?? undefined,
        wsServer: wsServer ?? undefined,
        governanceConfig: { costThresholdPerDay: fd.project.getConfig().costThresholdPerDay },
      },
    );
    orchestrator.start();
    orchestrators.push(orchestrator);
    console.error(`  Orchestrator running.`);

    // Spawn Lead + Planner
    await spawnAgents(fd, leadManager, name);

    // Wire WS user messages to Lead
    if (wsServer) {
      wireWsToLead(wsServer, leadManager, fd, name);
    }
  }

  // Start HTTP server
  const { createHttpServer } = await import('../api/HttpServer.js');
  const httpServer = createHttpServer({
    projectManager,
    leadManagers,
    port,
    corsOrigin,
    wsServers,
  });

  // Wire WebSocket upgrade for all projects
  const wsModule = await import('ws');
  const wss = new wsModule.WebSocketServer({ server: httpServer });
  let clientCounter = 0;
  const { DEFAULT_DISPLAY } = await import('@flightdeck-ai/shared');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wss.on('connection', (socket: any, req: any) => {
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

  httpServer.listen(port, () => {
    console.error(`\nHTTP server listening on port ${port}.`);
    console.error(`Projects: ${projectNames.join(', ')}`);
    console.error(`WebSocket: connect to /ws/:projectName`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error('\nStopping Flightdeck...');
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
  process.on('uncaughtException', (err) => {
    console.error('\nFatal uncaught exception:', err);
    try { acpAdapter.clear(); } catch {}
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('\nFatal unhandled rejection:', reason);
    try { acpAdapter.clear(); } catch {}
    process.exit(1);
  });
}

async function spawnAgents(fd: Flightdeck, leadManager: { spawnLead(): Promise<string>; spawnPlanner(): Promise<string> }, projectName: string): Promise<void> {
  const agents = fd.listAgents();
  const hasLead = agents.some(a => a.role === 'lead' && (a.status === 'busy' || a.status === 'idle'));
  const hasPlanner = agents.some(a => a.role === 'planner' && (a.status === 'busy' || a.status === 'idle'));

  if (!hasLead) {
    try {
      const sid = await leadManager.spawnLead();
      console.error(`  [${projectName}] Lead spawned (session: ${sid})`);
    } catch (err: unknown) {
      console.error(`  [${projectName}] Failed to spawn Lead: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.error(`  [${projectName}] Lead already active.`);
  }

  if (!hasPlanner) {
    try {
      const sid = await leadManager.spawnPlanner();
      console.error(`  [${projectName}] Planner spawned (session: ${sid})`);
    } catch (err: unknown) {
      console.error(`  [${projectName}] Failed to spawn Planner: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.error(`  [${projectName}] Planner already active.`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireWsToLead(wsServer: any, leadManager: { steerLead(event: any): Promise<string | null> }, fd: Flightdeck, projectName: string): void {
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
        }
      } catch (err) { console.error(`[${projectName}] Failed to steer Lead (task comment):`, err); }
    })();
  });
}

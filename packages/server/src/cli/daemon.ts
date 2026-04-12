import type { Flightdeck } from '../facade.js';

export interface DaemonDeps {
  fd: Flightdeck;
  projectName: string;
  port: number;
  corsOrigin: string;
  noRecover: boolean;
}

/**
 * Start the Flightdeck daemon: clean up stale agents, wire orchestrator,
 * spawn Lead/Planner, start HTTP+WS server, and register shutdown handlers.
 */
export async function startDaemon(deps: DaemonDeps): Promise<void> {
  const { fd, projectName, port, corsOrigin, noRecover } = deps;
  const profile = fd.status().config.governance;
  console.error(`Starting Flightdeck daemon (profile: ${profile})...`);

  // Clean up stale agents before spawning new ones
  const activeAgents = fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle');

  const markAgentsOffline = (agents: typeof activeAgents, reason: string) => {
    for (const agent of agents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
      fd.sqlite.updateAgentStatus(agent.id as any, 'offline');
      console.error(`  - ${agent.id} (${agent.role}) marked offline (${reason})`);
    }
  };

  if (noRecover) {
    if (activeAgents.length > 0) {
      console.error(`Session recovery disabled (--no-recover). Marking ${activeAgents.length} existing agents as offline.`);
      markAgentsOffline(activeAgents, '--no-recover');
    } else {
      console.error('Session recovery disabled (--no-recover). No existing agents to clean up.');
    }
  } else if (activeAgents.length > 0) {
    // TODO: implement ACP session/load to truly reconnect to live sessions
    console.error(`Found ${activeAgents.length} active agent(s). True session resume not yet implemented — marking offline and spawning fresh.`);
    markAgentsOffline(activeAgents, 'session resume not yet implemented');
  }

  // Create LeadManager with all dependencies
  const { AcpAdapter: AcpAdapterClass } = await import('../agents/AcpAdapter.js');
  const { LeadManager } = await import('../lead/LeadManager.js');
  const { WebSocketServer: WsServer } = await import('../api/WebSocketServer.js');

  const acpAdapter = new AcpAdapterClass(undefined, 'copilot');
  const leadManager = new LeadManager({
    sqlite: fd.sqlite,
    project: fd.project,
    messageStore: fd.chatMessages ?? undefined,
    acpAdapter,
  });

  // Create WebSocketServer
  const wsServer = fd.chatMessages ? new WsServer(fd.chatMessages) : null;

  // Wire orchestrator with all dependencies
  fd.orchestrator.stop(); // stop the default one
  const { Orchestrator: OrchestratorClass } = await import('../orchestrator/Orchestrator.js');
  const orchestrator = new OrchestratorClass(
    fd.dag, fd.sqlite, fd.governance, acpAdapter, fd.project.getConfig(),
    undefined,
    {
      agentManager: fd.agentManager,
      leadManager,
      messageStore: fd.chatMessages ?? undefined,
      wsServer: wsServer ?? undefined,
      governanceConfig: {
        costThresholdPerDay: fd.project.getConfig().costThresholdPerDay,
      },
    },
  );

  // Spawn Lead agent if none active
  const postCleanupAgents = fd.listAgents();
  const hasActiveLead = postCleanupAgents.some(a => a.role === 'lead' && (a.status === 'busy' || a.status === 'idle'));
  const hasActivePlanner = postCleanupAgents.some(a => a.role === 'planner' && (a.status === 'busy' || a.status === 'idle'));

  if (hasActiveLead) {
    console.error('Lead agent already active — skipping spawn.');
  } else {
    console.error('Spawning Lead agent (persistent session)...');
    try {
      const leadSessionId = await leadManager.spawnLead();
      console.error(`  Lead agent spawned (session: ${leadSessionId})`);
    } catch (err: unknown) {
      console.error(`  Failed to spawn Lead agent: ${err instanceof Error ? err.message : String(err)}`);
      console.error('  Daemon will continue without Lead — spawn manually via API.');
    }
  }

  // Spawn Planner agent if none active
  if (hasActivePlanner) {
    console.error('Planner agent already active — skipping spawn.');
  } else {
    console.error('Spawning Planner agent (persistent session)...');
    try {
      const plannerSessionId = await leadManager.spawnPlanner();
      console.error(`  Planner agent spawned (session: ${plannerSessionId})`);
    } catch (err: unknown) {
      console.error(`  Failed to spawn Planner agent: ${err instanceof Error ? err.message : String(err)}`);
      console.error('  Daemon will continue without Planner — spawn manually via API.');
    }
  }

  // Start orchestrator tick loop
  orchestrator.start();
  console.error('Orchestrator running (5 min tick interval).');

  // Wire user messages from WebSocket to Lead agent
  if (wsServer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback parameter type from untyped API
    wsServer.on('user:message', (msg: any) => {
      (async () => {
        try {
          const response = await leadManager.steerLead({ type: 'user_message', message: msg });
          if (response && response.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
            // Store Lead's response as a chat message
            if (fd.chatMessages) {
              const leadMsg = fd.chatMessages.createMessage({
                threadId: msg.thread_id ?? null,
                parentId: msg.id ?? null,
                taskId: null,
                authorType: 'lead',
                authorId: 'lead',
                content: response.trim(),
                metadata: null,
              });
              // Broadcast to all UI clients
              wsServer.broadcast({ type: 'chat:message', message: leadMsg });
            }
          }
        } catch (err) {
          console.error('Failed to steer Lead with user message:', err);
        }
      })();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback parameter type from untyped API
    wsServer.on('task:comment', ({ taskId, message: msg }: { taskId: string; message: any }) => {
      (async () => {
        try {
          const response = await leadManager.steerLead({ type: 'task_comment', taskId, message: msg });
          if (response && response.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY') {
            if (fd.chatMessages) {
              const leadMsg = fd.chatMessages.createMessage({
                threadId: null,
                parentId: null,
                taskId,
                authorType: 'lead',
                authorId: 'lead',
                content: response.trim(),
                metadata: null,
              });
              wsServer.broadcast({ type: 'task:comment', task_id: taskId, message: leadMsg });
            }
          }
        } catch (err) {
          console.error('Failed to steer Lead with task comment:', err);
        }
      })();
    });
  }

  // Start HTTP + WebSocket server
  const { createHttpServer } = await import('../api/HttpServer.js');
  const httpServer = createHttpServer({
    fd,
    projectName,
    port,
    corsOrigin,
    leadManager,
    wsServer: wsServer as any,
  });

  // Wire WebSocket to HTTP server upgrade
  if (wsServer) {
    const { WebSocketServer: WsLib } = await import('ws');
    const wss = new WsLib({ server: httpServer });
    let clientCounter = 0;
    const { DEFAULT_DISPLAY } = await import('@flightdeck-ai/shared');
    let serverDisplayConfig = { ...DEFAULT_DISPLAY };

    // Expose serverDisplayConfig setter for HTTP routes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attaching config to server for shared state
    (httpServer as any).__displayConfig = serverDisplayConfig;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attaching config to server for shared state
    (httpServer as any).__setDisplayConfig = (cfg: any) => {
      serverDisplayConfig = cfg;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attaching config to server for shared state
      (httpServer as any).__displayConfig = cfg;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback parameter type from untyped API
    wss.on('connection', (socket: any) => {
      const clientId = `ws-client-${++clientCounter}`;
      const client = { id: clientId, send: (data: string) => { try { socket.send(data); } catch {} } };
      wsServer.addClient(client);
      // Inherit server display config
      wsServer.setDisplayConfig(clientId, { ...serverDisplayConfig });
      wsServer.sendTo(clientId, { type: 'display:config', config: serverDisplayConfig });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback parameter type from untyped API
      socket.on('message', (raw: any) => {
        try {
          const event = JSON.parse(raw.toString());
          wsServer.handleEvent(clientId, event);
        } catch {}
      });
      socket.on('close', () => wsServer.removeClient(clientId));
    });

    // Store wss for shutdown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
    (httpServer as any).__wss = wss;
  }

  httpServer.listen(port, () => {
    console.error(`HTTP server listening on port ${port}.`);
  });

  console.error(`\nFlightdeck daemon running on port ${port}. Lead: active. Planner: active.`);

  // Handle graceful shutdown
  const shutdown = () => {
    console.error('\nStopping Flightdeck...');
    orchestrator.stop();
    leadManager.stop();
    // Kill all active ACP agent sessions
    acpAdapter.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
    if ((httpServer as any).__wss) (httpServer as any).__wss.close();
    httpServer.close();
    fd.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Catch crashes to clean up orphan child processes
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

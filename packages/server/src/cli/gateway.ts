import { ProjectManager } from '../projects/ProjectManager.js';
import type { Flightdeck } from '../facade.js';
import { messageId as makeMessageId, type AgentId, type TaskId, type AgentRole, type TaskState } from '@flightdeck-ai/shared';
import { saveAgentPids, clearAgentPids, cleanupOrphanedAgents } from './gatewayState.js';
import { existsSync, mkdirSync, renameSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FD_HOME } from './constants.js';
import { CronStore } from '../cron/CronStore.js';
import { CronScheduler } from '../cron/CronScheduler.js';
import { modelRegistry } from '../agents/ModelTiers.js';
import type { BridgeConfig } from '../bridges/types.js';
import { log } from '../utils/logger.js';

/** Load bridge config from global config */
async function loadBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    const { loadGlobalConfig } = await import('../config/GlobalConfig.js');
    const config = loadGlobalConfig() as any;
    if (!config.bridges) return null;
    return config.bridges as BridgeConfig;
  } catch {
    return null;
  }
}


/** Loosely-typed ACP session update for streaming output. */
interface SessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string } | Array<{ type: string; text?: string }>;
  title?: string;
  toolCallId?: string;
  rawInput?: unknown;
  input?: unknown;
  status?: string;
}

export interface GatewayDeps {
  port: number;
  corsOrigin: string;
  /** If true, keep active agents as-is instead of hibernating them on restart. */
  continueAgents?: boolean;
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
  const { port, corsOrigin, continueAgents = false, projectFilter, bindAddress = '127.0.0.1', authMode = 'none', authToken = null } = deps;

  // Tee stderr to log file
  try {
    const { createWriteStream } = await import('node:fs');
    const logPath = join(FD_HOME, 'gateway.log');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, ...args: any[]) => {
      logStream.write(chunk);
      return origWrite(chunk, ...args);
    };
    console.error(`[${new Date().toISOString()}] Gateway log: ${logPath}`);
  } catch { /* best effort */ }

  const { AcpAdapter: AcpAdapterClass } = await import('../agents/AcpAdapter.js');

  // Load cached model info from disk (so models are available before any project connects)
  modelRegistry.loadFromDisk();

  // Load custom runtimes from global config
  const { loadCustomRuntimes, populateRegistryIcons } = await import('../agents/runtimes.js');
  loadCustomRuntimes();

  // Populate icon URLs from ACP registry (non-blocking)
  populateRegistryIcons().catch(() => {});

  const { MultiAdapter: MultiAdapterClass } = await import('../agents/MultiAdapter.js');
  const { CopilotSdkAdapter } = await import('../agents/CopilotSdkAdapter.js');
  const { LeadManager } = await import('../lead/LeadManager.js');
  const { WebSocketServer: WsServer } = await import('../api/WebSocketServer.js');

  // One-time migration: move v2 data from ~/.flightdeck/ to ~/.flightdeck/v2/
  const oldProjectsDir = join(homedir(), '.flightdeck', 'projects');
  const newProjectsDir = join(FD_HOME, 'projects');
  if (existsSync(oldProjectsDir) && !existsSync(newProjectsDir)) {
    console.error('Migrating v2 data to ~/.flightdeck/v2/...');
    mkdirSync(FD_HOME, { recursive: true });
    renameSync(oldProjectsDir, newProjectsDir);
    for (const f of ['gateway-state.json', 'agent-pids.json']) {
      const old = join(homedir(), '.flightdeck', f);
      if (existsSync(old)) renameSync(old, join(FD_HOME, f));
    }
    console.error('Migration complete.');
  }

  // Clean up orphaned agent processes from a previous unclean shutdown
  await cleanupOrphanedAgents();

  // Clean up v1 agent files that interfere with Copilot CLI
  try {
    const agentsDir = join(homedir(), '.copilot', 'agents');
    if (existsSync(agentsDir)) {
      const { readdirSync, unlinkSync } = await import('node:fs');
      for (const f of readdirSync(agentsDir)) {
        if (f.startsWith('flightdeck-') && f.endsWith('.md')) {
          unlinkSync(join(agentsDir, f));
          console.error(`  Removed v1 agent file: ~/.copilot/agents/${f}`);
        }
      }
    }
  } catch { /* best effort */ }

  const acpAdapter = new AcpAdapterClass(undefined, process.env.FLIGHTDECK_RUNTIME || 'codex');
  const copilotSdkAdapter = new CopilotSdkAdapter({
    onUsage: (agentId, usage) => {
      for (const name of projectManager.list()) {
        const fd = projectManager.get(name);
        if (!fd) continue;
        const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
        if (agent) {
          fd.sqlite.insertCostEntry({
            agentId: agentId as AgentId,
            specId: null,
            model: usage.model,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costUsd: usage.cost,
            durationMs: usage.durationMs,
            timestamp: new Date().toISOString(),
          });
          fd.sqlite.recordCost(agentId as AgentId, usage.cost);
          break;
        }
      }
    },
    onContextWindow: (agentId, info) => {
      for (const name of projectManager.list()) {
        const fd = projectManager.get(name);
        if (!fd) continue;
        const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
        if (agent) {
          fd.sqlite.updateAgentContextWindow(agentId as AgentId, info.currentTokens, info.tokenLimit);
          if (info.tokenLimit > 0 && info.currentTokens / info.tokenLimit > 0.8 && agent.role === 'lead') {
            const pct = Math.round(info.currentTokens / info.tokenLimit * 100);
            console.error(`  [${name}] ⚠️ Lead context window at ${pct}% (${info.currentTokens}/${info.tokenLimit} tokens)`);
            const lm = leadManagers.get(name);
            if (lm) {
              void lm.steerLead({
                type: 'worker_recovery',
                message: `⚠️ Your context window is at ${pct}%. Write a diary/summary to memory now. Use flightdeck_memory_write.`,
              }).catch(() => {});
            }
          }
          break;
        }
      }
    },
  });
  const multiAdapter = new MultiAdapterClass(acpAdapter, copilotSdkAdapter);
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
        fd.sqlite.updateAgentStatus(agent.id, 'hibernated');
        // Broadcast state change so UI updates immediately
        const ws = wsServers.get(name);
        if (ws) {
          ws.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        }
        break;
      }
    }
  };

  // Track ACP agent token usage in per-project SQLite
  acpAdapter.onUsage = (agentId, usage) => {
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
      if (agent) {
        fd.sqlite.insertCostEntry({
          agentId: agentId as any,
          specId: null,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          costUsd: 0,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  };

  // When an agent's prompt turn starts, mark busy in SQLite
  const turnStartHandler = (_sessionId: string, agentId: string) => {
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
      if (agent && agent.status !== 'busy') {
        fd.sqlite.updateAgentStatus(agentId as any, 'busy');
        const ws = wsServers.get(name);
        if (ws) ws.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
        break;
      }
    }
  };
  acpAdapter.onSessionTurnStart = turnStartHandler;
  copilotSdkAdapter.onSessionTurnStart = turnStartHandler;

  // When an agent's prompt turn ends, mark idle in SQLite
  acpAdapter.onSessionTurnEnd = (sessionId, agentId) => {
    // Mark agent as idle in SQLite
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
      if (agent && agent.status === 'busy') {
        fd.sqlite.updateAgentStatus(agentId as any, 'idle');
        const ws = wsServers.get(name);
        if (ws) ws.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      }
      const tasks = fd.dag.listTasks().filter(
        t => t.state === 'running' && t.assignedAgent === agentId
      );
      if (tasks.length > 0) {
        // Agent finished its turn but has running tasks — nudge to submit
        const taskList = tasks.map(t => `"${t.title}" (${t.id})`).join(', ');
        acpAdapter.steer(sessionId, {
          content: `[SYSTEM] Your turn ended but you have unsubmitted tasks: ${taskList}. Please call flightdeck_task_submit for each completed task now.`,
        }).catch(() => { /* best effort */ });
        // Mark busy again since we're nudging
        if (agent) fd.sqlite.updateAgentStatus(agentId as any, 'busy');
        break;
      }
    }
  };

  // Wire the same turn-end handler for CopilotSdkAdapter
  copilotSdkAdapter.onSessionTurnEnd = acpAdapter.onSessionTurnEnd;

  // When Copilot SDK resolves the actual model name, update SQLite
  copilotSdkAdapter.onModelResolved = (agentId, model) => {
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      const agent = fd.sqlite.listAgents().find(a => a.id === agentId);
      if (agent) {
        fd.sqlite.updateAgentModel(agentId as AgentId, model);
        const ws = wsServers.get(name);
        if (ws) ws.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
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

      const u = update as SessionUpdate;

      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content && !Array.isArray(u.content) && u.content.type === 'text') {
            delta = u.content.text ?? '';
            contentType = 'text';
          }
          break;
        case 'agent_thought_chunk':
          if (u.content && !Array.isArray(u.content) && u.content.type === 'text') {
            delta = u.content.text ?? '';
            contentType = 'thinking';
          }
          break;
        case 'tool_call':
          toolName = u.title ?? '';
          if (!toolName) break; // Skip empty — wait for tool_call_update
          delta = JSON.stringify({ toolCallId: u.toolCallId, name: toolName, input: u.rawInput ? JSON.stringify(u.rawInput) : (u.input ? JSON.stringify(u.input) : ''), status: u.status ?? 'pending' });
          contentType = 'tool_call';
          break;
        case 'tool_call_update': {
          toolName = u.title ?? '';
          let resultText = '';
          if (u.content && Array.isArray(u.content)) {
            resultText = u.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          }
          delta = JSON.stringify({ toolCallId: u.toolCallId, name: toolName, result: resultText, status: u.status ?? 'completed' });
          contentType = 'tool_result';
          break;
        }
        default:
          return;
      }

      if (delta) {
        wsServer.broadcast({ type: 'agent:stream', agentId, delta, contentType, toolName });
      }
    }
  };

  // Wire Copilot SDK streaming output to WebSocket
  copilotSdkAdapter.onOutput = (agentId, event) => {
    const e = event as any;
    // Debug: log event types to help diagnose streaming
    if (e.type && !['session.idle', 'assistant.usage', 'session.usage_info'].includes(e.type)) {
      log('CopilotSdk', `Event: ${e.type} (agent: ${agentId})`);
    }
    for (const wsServer of wsServers.values()) {
      let delta = '';
      let contentType: 'text' | 'thinking' | 'tool_call' | 'tool_result' = 'text';
      let toolName: string | undefined;
      const e = event as any;

      switch (e.type) {
        case 'assistant.message_delta':
        case 'assistant.streaming_delta':
          delta = e.data?.content ?? e.data?.delta ?? '';
          contentType = 'text';
          break;
        case 'assistant.reasoning_delta':
          delta = e.data?.content ?? e.data?.delta ?? '';
          contentType = 'thinking';
          break;
        case 'tool.execution_start':
          toolName = e.data?.name ?? e.data?.tool ?? '';
          if (toolName) {
            const isFlightdeck = toolName.startsWith('flightdeck_');
            delta = JSON.stringify({ toolCallId: e.data?.id ?? '', name: toolName, input: e.data?.input ? JSON.stringify(e.data.input) : '', status: 'pending' });
            contentType = isFlightdeck ? 'tool_call' : 'tool_call';
          }
          break;
        case 'tool.execution_complete':
          toolName = e.data?.name ?? e.data?.tool ?? '';
          delta = JSON.stringify({ toolCallId: e.data?.id ?? '', name: toolName, result: e.data?.content ?? e.data?.result ?? '', status: 'completed' });
          contentType = 'tool_result';
          break;
        default:
          return;
      }

      if (delta) {
        wsServer.broadcast({ type: 'agent:stream', agentId, delta, contentType, toolName });
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
    console.error('No projects found. Gateway will start and wait for projects to be created via the web UI or CLI.');
  } else {
    console.error(`Starting Flightdeck gateway for ${projectNames.length} project(s): ${projectNames.join(', ')}`);
  }


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
    // Load per-project custom runtimes
    const profile = fd.status().config.governance;
    console.error(`\n── Project: ${name} (profile: ${profile}) ──`);

    // Clean up stale agents on restart
    const activeAgents = fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle');
    if (!continueAgents && activeAgents.length > 0) {
      console.error(`  Marking ${activeAgents.length} agent(s) hibernated.`);
      for (const agent of activeAgents) {
        fd.sqlite.updateAgentStatus(agent.id as AgentId, 'hibernated');
      }
    } else if (continueAgents && activeAgents.length > 0) {
      console.error(`  --continue: resuming ${activeAgents.length} agent(s)...`);
      for (const agent of activeAgents) {
        if (!agent.acpSessionId) {
          console.error(`    ${agent.id} (${agent.role}): no session ID, marking hibernated`);
          fd.sqlite.updateAgentStatus(agent.id as AgentId, 'hibernated');
          continue;
        }
        try {
          const meta = await multiAdapter.resumeSession({
            previousSessionId: agent.acpSessionId,
            cwd: fd.status().config.cwd ?? process.cwd(),
            role: agent.role,
            agentId: agent.id,
            projectName: name,
            runtime: agent.runtimeName ?? undefined,
          });
          fd.sqlite.updateAgentAcpSession(agent.id as AgentId, meta.sessionId);
          fd.sqlite.updateAgentStatus(agent.id as AgentId, 'idle');
          console.error(`    ${agent.id} (${agent.role}): resumed (session: ${meta.sessionId})`);
        } catch (err) {
          console.error(`    ${agent.id} (${agent.role}): resume failed, marking hibernated — ${err instanceof Error ? err.message : String(err)}`);
          fd.sqlite.updateAgentStatus(agent.id as AgentId, 'hibernated');
        }
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
      acpAdapter: multiAdapter,
      projectName: name,
      cwd: projectCwd,
      leadRuntime: leadRoleConfig.runtime as import('../core/types.js').AgentRuntime,
      plannerRuntime: plannerRoleConfig.runtime as import('../core/types.js').AgentRuntime,
      heartbeat: {
        enabled: projectConfig.heartbeatEnabled === true,
        interval: 30 * 60 * 1000,
        conditions: [],
        idleTimeoutDays: projectConfig.heartbeatIdleTimeoutDays ?? 3,
      },
    });
    leadManagers.set(name, leadManager);

    // Wire scout heartbeat callback
    leadManager.onScoutHeartbeat = async () => {
      try {
        const { runScout } = await import('../orchestrator/Scout.js');
        const suggestions = await runScout(fd, 'latest', { adapter: multiAdapter });
        if (suggestions.length > 0) {
          await leadManager.steerLead({ type: 'scout_report', suggestions });
        }
      } catch (e) { console.error('  Scout run failed:', e); }
    };

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

    // Wire DM message broadcast
    fd.agentManager.onDmMessage = (projName, msg) => {
      const ws = wsServers.get(projName);
      if (ws) ws.broadcast({ type: 'dm:message', project: projName, message: msg });
    };

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


    await spawnAgents(fd, leadManager, name);

    // Wire WS user messages to Lead
    if (wsServer) {
      wireWsToLead(wsServer, leadManager, fd, name, webhookNotifiers.get(name));
    }
  }

  // ── Chat Bridges ──
  let bridgeManager: InstanceType<typeof import('../bridges/BridgeManager.js').BridgeManager> | null = null;
  try {
    const { BridgeManager } = await import('../bridges/BridgeManager.js');
    const bridgeConfig = await loadBridgeConfig();
    if (bridgeConfig) {
      bridgeManager = new BridgeManager(bridgeConfig, (bridge, msg, projectName) => {
        const lm = leadManagers.get(projectName);
        if (lm) {
          lm.steerLead({
            type: 'user_message',
            message: {
              id: msg.messageId ?? '',
              content: msg.text,
              authorType: 'user',
              authorId: msg.userId,
              metadata: JSON.stringify({ bridge, channelId: msg.channelId, userName: msg.userName }),
              threadId: null, parentId: null, taskId: null, channel: bridge,
              createdAt: new Date().toISOString(),
            } as any,
          }).catch(() => {});
        }
      });
      await bridgeManager.startAll();
    }
  } catch (err: any) {
    console.error(`[bridges] Init failed: ${err.message}`);
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
    onProjectSetup: async (name: string) => {
      const fd = projectManager.get(name);
      if (!fd) return;
      const profile = fd.status().config.governance;
      console.error(`\n── Hot-register project: ${name} (profile: ${profile}) ──`);

      // ModelConfig
      const { ModelConfig } = await import('../agents/ModelConfig.js');
      const modelConfig = new ModelConfig(fd.project.subpath('.'));
      const leadRoleConfig = modelConfig.getRoleConfig('lead');
      const plannerRoleConfig = modelConfig.getRoleConfig('planner');

      // LeadManager
      const projectConfig = fd.project.getConfig();
      const projectCwd = fd.status().config.cwd ?? process.cwd();
      const leadManager = new LeadManager({
        sqlite: fd.sqlite,
        project: fd.project,
        messageStore: fd.messages ?? undefined,
        acpAdapter: multiAdapter,
        projectName: name,
        cwd: projectCwd,
        leadRuntime: leadRoleConfig.runtime as import('../core/types.js').AgentRuntime,
        plannerRuntime: plannerRoleConfig.runtime as import('../core/types.js').AgentRuntime,
        heartbeat: {
          enabled: projectConfig.heartbeatEnabled === true,
          interval: 30 * 60 * 1000,
          conditions: [],
          idleTimeoutDays: projectConfig.heartbeatIdleTimeoutDays ?? 3,
        },
      });
      leadManagers.set(name, leadManager);

      // Wire scout heartbeat callback
      leadManager.onScoutHeartbeat = async () => {
        try {
          const { runScout } = await import('../orchestrator/Scout.js');
          const suggestions = await runScout(fd, 'latest', { adapter: multiAdapter });
          if (suggestions.length > 0) {
            await leadManager.steerLead({ type: 'scout_report', suggestions });
          }
        } catch (e) { console.error('  Scout run failed:', e); }
      };

      // CronStore + CronScheduler
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

      // WebSocketServer
      const { WebSocketServer: WsServerClass } = await import('../api/WebSocketServer.js');
      const wsServer = fd.messages ? new WsServerClass(fd.messages) : null;
      if (wsServer) wsServers.set(name, wsServer as any);

      // Wire DM message broadcast
      fd.agentManager.onDmMessage = (projName, msg) => {
        const ws = wsServers.get(projName);
        if (ws) ws.broadcast({ type: 'dm:message', project: projName, message: msg });
      };

      // Orchestrator
      fd.orchestrator.stop();
      const { Orchestrator: OrchestratorClass } = await import('../orchestrator/Orchestrator.js');
      const orchestrator = new OrchestratorClass(
        fd.dag, fd.sqlite, fd.governance, acpAdapter, { ...projectConfig, cwd: fd.project.subpath('.') },
        undefined,
        {
          agentManager: fd.agentManager,
          leadManager,
          messageStore: fd.messages ?? undefined,
          wsServer: wsServer as any ?? undefined,
          governanceConfig: { costThresholdPerDay: projectConfig.costThresholdPerDay },
          notifications: projectConfig.notifications as import('../integrations/WebhookNotifier.js').NotificationsConfig | undefined,
        },
      );
      orchestrator.start();
      orchestrators.push(orchestrator);
      const { WebhookNotifier } = await import('../integrations/WebhookNotifier.js');
      const whNotifier = orchestrator.getWebhookNotifier();
      webhookNotifiers.set(name, whNotifier);

      // Wire WS to Lead
      if (wsServer) {
        wireWsToLead(wsServer as any, leadManager, fd, name, whNotifier);
      }

      // Lead will spawn on-demand (no saved sessions for new projects)
      console.error(`  [${name}] Lead — will spawn on-demand.`);
      console.error(`  [${name}] Hot-register complete.`);
    },
  });

  // Wire WebSocket upgrade for all projects
  const wsModule = await import('ws');
  const wss = new wsModule.WebSocketServer({ server: httpServer });
  let clientCounter = 0;
  const { DEFAULT_DISPLAY } = await import('@flightdeck-ai/shared');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wss.on('connection', async (socket: any, req: any) => {
    const wsUrl0 = new URL(req.url ?? '/', `http://localhost:${port}`);
    const wsMatch0 = wsUrl0.pathname.match(/^\/ws\/([^/]+)$/);
    const wsProject0 = wsMatch0 ? decodeURIComponent(wsMatch0[1]) : projectNames[0];
    log('WS', `Client connected to project "${wsProject0}"`);
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
    let wsServer = wsServers.get(wsProjectName);
    if (!wsServer) {
      // Hot-create WebSocket broadcaster for new projects
      const fd = projectManager.get(wsProjectName);
      if (!fd) { socket.close(4004, 'Project not found'); return; }
      const { WebSocketServer: WsServerClass } = await import('../api/WebSocketServer.js');
      wsServer = new WsServerClass(fd.messages) as any;
      wsServers.set(wsProjectName, wsServer as any);
      // Wire DM message broadcast for hot-created WS
      if (!fd.agentManager.onDmMessage) {
        fd.agentManager.onDmMessage = (projName, msg) => {
          const ws = wsServers.get(projName);
          if (ws) ws.broadcast({ type: 'dm:message', project: projName, message: msg });
        };
      }
    }

    const clientId = `ws-${wsProjectName}-${++clientCounter}`;
    const client = { id: clientId, send: (data: string) => { try { socket.send(data); } catch {} } };
    wsServer.addClient(client);
    wsServer.setDisplayConfig(clientId, { ...DEFAULT_DISPLAY });
    wsServer.sendTo(clientId, { type: 'display:config', config: { ...DEFAULT_DISPLAY } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on('message', (raw: any) => {
      try { wsServer.handleEvent(clientId, JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => { wsServer.removeClient(clientId); log('WS', `Client disconnected (${clientId})`); });
  });

  httpServer.listen(port, bindAddress, () => {
    console.error(`\nHTTP server listening on ${bindAddress}:${port}.`);
    console.error(`Projects: ${projectNames.join(', ')}`);
    console.error(`WebSocket: connect to /ws/:projectName`);
    if (authMode === 'token') console.error(`Auth: token required`);

    // Auto-discover models for installed runtimes (background, best-effort)
    import('../agents/AcpAdapter.js').then(({ discoverRuntimeModels }) => {
      import('../agents/runtimes.js').then(({ RUNTIME_REGISTRY }) => {
        import('../utils/platform.js').then(({ commandExists }) => {
          const runtimeIds = Object.entries(RUNTIME_REGISTRY)
            .filter(([, r]) => r.supportsAcp && r.supportsModelDiscovery !== false)
            .map(([id]) => id);
          const installed = runtimeIds.filter(id => commandExists(RUNTIME_REGISTRY[id].command));
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

    // Discover copilot-sdk models separately (not ACP-based)
    import('../agents/ModelTiers.js').then(({ modelRegistry }) => {
      copilotSdkAdapter.discoverModels().then(models => {
        if (models.length > 0) {
          modelRegistry.registerModels('copilot', models);
          console.error(`  copilot (SDK): ${models.length} models discovered`);
        }
      }).catch(e => {
        console.error(`  copilot (SDK): model discovery failed — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      });
    });
  });

  // Helper: save active sessions to per-project SQLite
  const saveAllSessionsToSqlite = (): void => {
    for (const [projectName, lm] of leadManagers.entries()) {
      const fd = projectManager.get(projectName);
      if (!fd) continue;

      const leadInfo = lm.getLeadSessionInfo();
      if (leadInfo) {
        fd.sqlite.saveSession({
          agentId: leadInfo.agentId,
          role: 'lead',
          sessionId: leadInfo.acpSessionId,
          localSessionId: leadInfo.sessionId,
          runtime: leadInfo.runtime,
          cwd: fd.status().config.cwd ?? process.cwd(),
        });
      }

      const plannerInfo = lm.getPlannerSessionInfo();
      if (plannerInfo) {
        fd.sqlite.saveSession({
          agentId: plannerInfo.agentId,
          role: 'planner',
          sessionId: plannerInfo.acpSessionId,
          localSessionId: plannerInfo.sessionId,
          runtime: plannerInfo.runtime,
          cwd: fd.status().config.cwd ?? process.cwd(),
        });
      }

      // Save worker sessions
      const workerAgents = fd.listAgents().filter(a =>
        a.status === 'busy' && a.acpSessionId && !['lead', 'planner'].includes(a.role)
      );
      for (const agent of workerAgents) {
        fd.sqlite.saveSession({
          agentId: agent.id as string,
          role: agent.role,
          sessionId: agent.acpSessionId!,
          localSessionId: agent.acpSessionId!,
          cwd: process.cwd(),
          status: 'active',
        });
      }
    }
  };

  // Graceful shutdown
  const shutdown = () => {
    console.error('\nStopping Flightdeck gateway...');
    clearInterval(stateSaveTimer);

    // Save session state before cleanup
    try { saveAllSessionsToSqlite(); } catch {}

    for (const o of orchestrators) o.stop();
    for (const cs of cronSchedulers) cs.stop();
    for (const lm of leadManagers.values()) lm.stop();
    if (bridgeManager) bridgeManager.stopAll().catch(() => {});
    acpAdapter.clear();
    // Clean up PID tracking — graceful shutdown means no orphans
    clearAgentPids();
    (wss as any).close();
    httpServer.close();
    projectManager.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Periodic state persistence — saves sessions every 30s as a safety net.
  const STATE_SAVE_INTERVAL = 30_000;
  const stateSaveTimer = setInterval(() => {
    try {
      saveAllSessionsToSqlite();
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

  // Periodic upload cleanup — delete files older than 7 days
  const UPLOAD_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  const uploadCleanupTimer = setInterval(() => {
    try {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const pName of projectNames) {
        const fd = projectManager.get(pName);
        if (!fd) continue;
        const uploadsDir = join(fd.project.subpath('.'), 'uploads');
        if (!existsSync(uploadsDir)) continue;
        let cleaned = 0;
        for (const file of readdirSync(uploadsDir)) {
          const filePath = join(uploadsDir, file);
          try {
            const st = statSync(filePath);
            if (st.isFile() && now - st.mtimeMs > SEVEN_DAYS_MS) {
              unlinkSync(filePath);
              cleaned++;
            }
          } catch { /* skip */ }
        }
        if (cleaned > 0) console.error(`[upload-cleanup] Cleaned ${cleaned} old file(s) from ${pName}/uploads`);
      }
    } catch { /* best effort */ }
  }, UPLOAD_CLEANUP_INTERVAL);
  uploadCleanupTimer.unref();

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
    try { saveAllSessionsToSqlite(); } catch {}
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
): Promise<void> {
  const agents = fd.listAgents();
  const hasLead = agents.some(a => a.role === 'lead' && (a.status === 'busy' || a.status === 'idle'));
  const hasPlanner = agents.some(a => a.role === 'planner' && (a.status === 'busy' || a.status === 'idle'));

  // On restart, Lead and Planner will be spawned fresh on-demand via
  // spawnLead()/spawnPlanner() which internally check for hibernated agents to wake.

  if (!hasLead) {
    console.error(`  [${projectName}] Lead — will spawn on-demand.`);
  } else {
    console.error(`  [${projectName}] Lead already active.`);
  }

  if (!hasPlanner) {
    console.error(`  [${projectName}] Planner — will spawn on-demand.`);
  } else {
    console.error(`  [${projectName}] Planner already active.`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireWsToLead(wsServer: any, leadManager: { steerLead(event: any): Promise<string | null>; getLastMergedSourceIds?(): string[]; setStreamHandler?(handler: (update: any) => void): void; cancelLead?(): Promise<void> }, fd: Flightdeck, projectName: string, notifier?: InstanceType<typeof import('../integrations/WebhookNotifier.js').WebhookNotifier> | null): void {
  // Pre-generate message ID for stream↔final message consistency
  const msgIdRef = { current: makeMessageId('lead', Date.now().toString()) };

  // Wire streaming updates (tool calls, thoughts) from Lead to WebSocket
  if (leadManager.setStreamHandler && wsServer.streamChunk) {
    leadManager.setStreamHandler((update: SessionUpdate) => {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          { const c = Array.isArray(update.content) ? update.content[0] : update.content;
            if (c?.type === 'text') wsServer.streamChunk(msgIdRef.current, c.text, false);
          }
          break;
        case 'agent_thought_chunk':
          { const c = Array.isArray(update.content) ? update.content[0] : update.content;
            if (c?.type === 'text') wsServer.streamChunk(msgIdRef.current, c.text, false, 'thinking');
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
              .filter((c: { type: string; text?: string }) => c.type === 'text')
              .map((c: { type: string; text?: string }) => c.text ?? '')
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
    log('WS', `user:message in "${projectName}": "${(msg.content ?? '').slice(0, 80)}"`);
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
        wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      } catch (err) { console.error(`[${projectName}] Failed to steer Lead:`, err); }
    })();
  });

   
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

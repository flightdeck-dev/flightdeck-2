#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';
import { SkillManager } from '../skills/SkillManager.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    project: { type: 'string', short: 'p' },
    profile: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    role: { type: 'string' },
    spec: { type: 'string' },
    status: { type: 'string' },
    json: { type: 'boolean' },
    reason: { type: 'string' },
    'cors-origin': { type: 'string' },
    'no-recover': { type: 'boolean', default: false },
    'fresh': { type: 'boolean', default: false },
  },
});

function usage(): void {
  console.log(`
Flightdeck CLI — Multi-agent orchestration

Usage: flightdeck <command> [options]

Commands:
  init <project-name>     Create a new project
  agent-config <role>     Generate role-specific AGENTS.md
  spec create <title>     Create a spec
  spec list               List specs
  status                  Project status
  task list               List tasks
  agent list              List agents
  chat <message>          Send a message to the Lead agent
  models                  Show current model config per role
  models list             List available models grouped by tier
  models set <role> <m>   Set model for a role (tier or model ID)
  log                     View decision log
  report                  View latest report
  display                 Show current display config
  display preset <name>   Apply display preset (minimal|summary|detail|debug)
  display set <key> <val> Set display option (thinking on/off, tools summary, etc.)
  start [--profile X]     Start orchestrator (stub)
                          --no-recover / --fresh  Skip session recovery; mark stale agents as terminated
  pause                   Pause orchestrator (stop claiming new tasks)
  resume                  Resume orchestrator (start claiming tasks)
  tui                     Launch terminal UI

Options:
  -p, --project <name>    Project name (default: from .flightdeck.json)
  -h, --help              Show help
`);
}

function resolveProject(): string {
  if (values.project) return values.project as string;
  const name = ProjectStore.resolve(process.cwd());
  if (!name) {
    console.error('No Flightdeck project found. Run `flightdeck init <name>` first.');
    process.exit(1);
  }
  return name;
}

const command = positionals[0];
const subcommand = positionals[1];

if (values.help || !command) {
  usage();
  process.exit(0);
}

(async () => {
switch (command) {
  case 'init': {
    const name = positionals[1];
    if (!name) { console.error('Usage: flightdeck init <project-name>'); process.exit(1); }
    const store = new ProjectStore(name);
    store.init(name);
    ProjectStore.writeFlightdeckJson(process.cwd(), name);
    // Generate default AGENTS.md (worker role) and .mcp.json
    ProjectStore.writeAgentFiles(process.cwd(), 'worker');
    // Copy built-in skills and generate default config
    SkillManager.copyDefaults(process.cwd());
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const configPath = join(process.cwd(), '.flightdeck', 'config.yaml');
    writeFileSync(configPath, SkillManager.generateDefaultConfig());
    console.log(`Project "${name}" initialized.`);
    console.log(`Created .flightdeck.json in ${process.cwd()}`);
    console.log(`Created AGENTS.md (worker role)`);
    console.log(`Created .mcp.json (Claude Code MCP config)`);
    console.log(`Project data at ~/.flightdeck/projects/${name}/`);
    console.log();
    console.log('Setup for other runtimes:');
    console.log('  Codex:   Add to .codex/config.toml — [mcp_servers.flightdeck] command = "npx" args = ["flightdeck-mcp"]');
    console.log('  Gemini:  Add mcpServers.flightdeck to ~/.gemini/settings.json');
    console.log('  Copilot: Run copilot /mcp add flightdeck -- npx flightdeck-mcp');
    console.log();
    console.log('Generate configs for other roles: flightdeck agent-config <lead|worker|reviewer|planner>');
    break;
  }

  case 'agent-config': {
    const role = positionals[1] as 'lead' | 'worker' | 'reviewer' | 'planner';
    const validRoles = ['lead', 'worker', 'reviewer', 'planner'];
    if (!role || !validRoles.includes(role)) {
      console.error('Usage: flightdeck agent-config <lead|worker|reviewer|planner>');
      process.exit(1);
    }
    const configs = ProjectStore.writeAgentFiles(process.cwd(), role);
    console.log(configs.agentsMd);
    console.log('---');
    console.log('Written: AGENTS.md, .mcp.json');
    console.log();
    console.log('Codex config snippet:');
    console.log(configs.codexConfig);
    console.log('Gemini setup:');
    console.log(configs.geminiInstructions);
    console.log('Copilot setup:');
    console.log(configs.copilotInstructions);
    break;
  }

  case 'spec': {
    const fd = new Flightdeck(resolveProject());
    if (subcommand === 'create') {
      const title = positionals.slice(2).join(' ');
      if (!title) { console.error('Usage: flightdeck spec create <title>'); process.exit(1); }
      const spec = fd.createSpec(title, '');
      console.log(`Spec created: ${spec.filename} (${spec.id})`);
    } else if (subcommand === 'list') {
      const specs = fd.listSpecs();
      if (specs.length === 0) { console.log('No specs found.'); }
      for (const s of specs) { console.log(`  ${s.id}  ${s.title}  (${s.filename})`); }
    } else {
      console.error('Usage: flightdeck spec <create|list>');
    }
    fd.close();
    break;
  }

  case 'status': {
    const fd = new Flightdeck(resolveProject());
    const s = fd.status();
    console.log(`Project: ${s.config.name}`);
    console.log(`Governance: ${s.config.governance}`);
    console.log(`Agents: ${s.agentCount}`);
    console.log(`Total cost: $${s.totalCost.toFixed(2)}`);
    console.log('Tasks:', JSON.stringify(s.taskStats));
    fd.close();
    break;
  }

  case 'task': {
    const fd = new Flightdeck(resolveProject());
    if (subcommand === 'list') {
      const tasks = fd.listTasks();
      if (tasks.length === 0) { console.log('No tasks.'); }
      for (const t of tasks) {
        console.log(`  [${t.state.padEnd(10)}] ${t.id}  ${t.title}`);
      }
    } else if (subcommand === 'add') {
      const title = positionals.slice(2).join(' ');
      if (!title) { console.error('Usage: flightdeck task add <title> --role <role> [--spec <specId>]'); break; }
      const role = (values as any).role || 'worker';
      const specId = (values as any).spec || undefined;
      const task = fd.addTask({ title, role, specId });
      console.log(`Task created: ${task.id} [${task.state}] ${task.title}`);
    } else {
      console.error('Usage: flightdeck task <list|add>');
    }
    fd.close();
    break;
  }

  case 'agent': {
    const fd = new Flightdeck(resolveProject());
    if (subcommand === 'list') {
      const agents = fd.listAgents();
      if (agents.length === 0) { console.log('No agents.'); }
      for (const a of agents) {
        console.log(`  [${a.status.padEnd(8)}] ${a.id}  ${a.role}  (${a.runtime})`);
      }
    } else {
      console.error('Usage: flightdeck agent list');
    }
    fd.close();
    break;
  }

  case 'log': {
    const fd = new Flightdeck(resolveProject());
    const decisions = fd.decisions.readAll();
    if (decisions.length === 0) { console.log('No decisions logged.'); }
    for (const d of decisions) {
      console.log(`  [${d.status}] ${d.id}: ${d.title}`);
    }
    fd.close();
    break;
  }

  case 'report': {
    const { DailyReport } = await import('../reporting/DailyReport.js');
    const fd = new Flightdeck(resolveProject());
    const report = new DailyReport(fd.sqlite, fd.decisions);
    const since = (values as any).since || undefined;
    console.log(report.generate({ since }));
    fd.close();
    break;
  }

  case 'start': {
    const projectName = resolveProject();
    const fd = new Flightdeck(projectName);
    const profile = values.profile ?? fd.status().config.governance;
    const port = parseInt((values as any).port ?? '3000', 10);
    console.error(`Starting Flightdeck daemon (profile: ${profile})...`);

    // Recover existing ACP sessions from database
    const noRecover = !!(values['no-recover'] || values['fresh'] as unknown);
    const activeAgents = fd.listAgents().filter(a => a.status === 'busy' && a.acpSessionId);
    if (noRecover) {
      // Mark all existing agents as terminated
      const allAgents = fd.listAgents().filter(a => a.status !== 'offline');
      if (allAgents.length > 0) {
        console.error(`Session recovery disabled (--no-recover). Marking ${allAgents.length} existing agents as terminated.`);
        for (const agent of allAgents) {
          fd.sqlite.updateAgentStatus(agent.id as any, 'offline');
        }
      } else {
        console.error('Session recovery disabled (--no-recover). No existing agents to clean up.');
      }
    } else if (activeAgents.length > 0) {
      console.error(`Recovering ${activeAgents.length} active agent session(s)...`);
      for (const agent of activeAgents) {
        // TODO: ACP session/load to reconnect to live sessions
        console.error(`  - ${agent.id} (${agent.role}) session ${agent.acpSessionId} — recovery pending`);
      }
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

    // Spawn Lead agent (persistent ACP session)
    console.error('Spawning Lead agent (persistent session)...');
    try {
      const leadSessionId = await leadManager.spawnLead();
      console.error(`  Lead agent spawned (session: ${leadSessionId})`);
    } catch (err: any) {
      console.error(`  Failed to spawn Lead agent: ${err.message}`);
      console.error('  Daemon will continue without Lead — spawn manually via API.');
    }

    // Spawn Planner agent (persistent ACP session)
    console.error('Spawning Planner agent (persistent session)...');
    try {
      const plannerSessionId = await leadManager.spawnPlanner();
      console.error(`  Planner agent spawned (session: ${plannerSessionId})`);
    } catch (err: any) {
      console.error(`  Failed to spawn Planner agent: ${err.message}`);
      console.error('  Daemon will continue without Planner — spawn manually via API.');
    }

    // Start orchestrator tick loop
    orchestrator.start();
    console.error('Orchestrator running (5 min tick interval).');

    // Wire user messages from WebSocket to Lead agent
    if (wsServer) {
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
    const { createServer } = await import('node:http');
    const { ModelConfig: ModelCfg, PRESET_NAMES: presetNames } = await import('../agents/ModelConfig.js');
    const { modelRegistry: modRegistry } = await import('../agents/ModelTiers.js');
    const modelCfg = new ModelCfg(process.cwd());
    const { DEFAULT_DISPLAY: defaultDisplay, DISPLAY_PRESETS: displayPresets, DISPLAY_PRESET_NAMES: displayPresetNames, mergeDisplayConfig: mergeDisplay, isValidDisplayConfig: isValidDisplay } = await import('@flightdeck-ai/shared');
    let serverDisplayConfig = { ...defaultDisplay };

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const method = req.method ?? 'GET';

      // Helper to read JSON body (1MB limit)
      const MAX_BODY = 1024 * 1024; // 1MB
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
      const corsOrigin = (values as any)['cors-origin'] ?? '*';
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
          } catch (err: any) {
            console.error('Failed to steer Lead:', err.message);
          }
          json(200, { message: userMsg, response: leadMsg ?? leadResponse });
        } catch (e: any) { json(e?.message === 'Body too large' ? 413 : 400, { error: e?.message ?? 'Invalid JSON' }); }
      } else if (url.pathname === '/api/tasks' && method === 'POST') {
        try {
          const body = await readBody();
          if (!body.title || typeof body.title !== 'string') { json(400, { error: 'Missing required field: title' }); return; }
          const role = body.role || 'worker';
          const task = fd.addTask({ title: body.title, description: body.description, role });
          if (wsServer) wsServer.broadcast({ type: 'chat:message', message: task as any });
          json(201, task);
        } catch (e: any) { json(e?.message === 'Body too large' ? 413 : 400, { error: e?.message ?? 'Invalid JSON' }); }
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
        json(200, { roles: modelCfg.getRoleConfigs(), presets: presetNames });
      } else if (url.pathname === '/api/models/available' && method === 'GET') {
        const result: Record<string, unknown> = {};
        for (const rt of modRegistry.getRuntimes()) {
          result[rt] = modRegistry.getModelsGrouped(rt);
        }
        json(200, result);
      } else if (url.pathname.startsWith('/api/models/preset/') && method === 'POST') {
        const preset = url.pathname.split('/').pop()!;
        if (modelCfg.applyPreset(preset)) {
          json(200, { success: true, roles: modelCfg.getRoleConfigs() });
        } else {
          json(400, { error: `Unknown preset: ${preset}. Available: ${presetNames.join(', ')}` });
        }
      } else if (url.pathname === '/api/display' && method === 'GET') {
        json(200, serverDisplayConfig);
      } else if (url.pathname === '/api/display' && method === 'PUT') {
        try {
          const body = await readBody();
          if (!isValidDisplay(body)) { json(400, { error: 'Invalid display config' }); return; }
          serverDisplayConfig = mergeDisplay(serverDisplayConfig, body);
          // Broadcast updated server config to all WS clients
          if (wsServer) {
            wsServer.broadcast({ type: 'display:config', config: serverDisplayConfig });
          }
          json(200, serverDisplayConfig);
        } catch (e: any) { json(e?.message === 'Body too large' ? 413 : 400, { error: e?.message ?? 'Invalid JSON' }); }
      } else if (url.pathname.match(/^\/api\/display\/preset\/[^/]+$/) && method === 'POST') {
        const preset = url.pathname.split('/').pop()!;
        if (preset in displayPresets) {
          serverDisplayConfig = { ...displayPresets[preset as keyof typeof displayPresets] };
          json(200, serverDisplayConfig);
        } else {
          json(400, { error: `Unknown preset: ${preset}. Available: ${displayPresetNames.join(', ')}` });
        }
      } else if (url.pathname.match(/^\/api\/models\/[^/]+$/) && method === 'PUT') {
        const role = url.pathname.split('/').pop()!;
        try {
          const body = await readBody();
          if (body.runtime) modelCfg.setRole(role, `${body.runtime}:${body.model ?? 'medium'}`);
          else if (body.model) modelCfg.setRole(role, body.model);
          else { json(400, { error: 'Provide runtime and/or model' }); return; }
          json(200, { success: true, config: modelCfg.getRoleConfig(role) });
        } catch (e: any) {
          json(e?.message === 'Body too large' ? 413 : 400, { error: e?.message ?? 'Invalid request body' });
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
    // Wire WebSocket to HTTP server upgrade
    if (wsServer) {
      const { WebSocketServer: WsLib } = await import('ws');
      const wss = new WsLib({ server: httpServer });
      let clientCounter = 0;
      wss.on('connection', (socket: any) => {
        const clientId = `ws-client-${++clientCounter}`;
        const client = { id: clientId, send: (data: string) => { try { socket.send(data); } catch {} } };
        wsServer.addClient(client);
        // Inherit server display config
        wsServer.setDisplayConfig(clientId, { ...serverDisplayConfig });
        wsServer.sendTo(clientId, { type: 'display:config', config: serverDisplayConfig });
        socket.on('message', (raw: any) => {
          try {
            const event = JSON.parse(raw.toString());
            wsServer.handleEvent(clientId, event);
          } catch {}
        });
        socket.on('close', () => wsServer.removeClient(clientId));
      });

      // Store wss for shutdown
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
      if ((httpServer as any).__wss) (httpServer as any).__wss.close();
      httpServer.close();
      fd.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }

  case 'chat': {
    const chatPort = (values as any).port || '3000';
    const chatMessage = positionals.slice(1).join(' ');
    if (!chatMessage) { console.error('Usage: flightdeck chat <message>'); process.exit(1); }
    try {
      const res = await fetch(`http://localhost:${chatPort}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chatMessage }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        console.error(`Error: ${(err as any).error ?? res.statusText}`);
        process.exit(1);
      }
      const data = await res.json() as { message: any; response: any };
      if (data.response) {
        const content = typeof data.response === 'string' ? data.response : data.response.content;
        console.log(content);
      } else {
        console.log('(No response from Lead)');
      }
    } catch {
      console.error('Failed to send message — is the daemon running?');
      process.exit(1);
    }
    break;
  }

  case 'pause': {
    const pausePort = (values as any).port || '3000';
    try {
      const res = await fetch(`http://localhost:${pausePort}/api/orchestrator/pause`, { method: 'POST' });
      if (res.ok) {
        console.log('Orchestrator paused. In-progress tasks will continue but no new tasks will be claimed.');
      } else {
        console.error(`Failed to pause: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
    } catch {
      console.error('Failed to pause — is the daemon running?');
      process.exit(1);
    }
    break;
  }

  case 'resume': {
    const resumePort = (values as any).port || '3000';
    try {
      const res = await fetch(`http://localhost:${resumePort}/api/orchestrator/resume`, { method: 'POST' });
      if (res.ok) {
        console.log('Orchestrator resumed. New tasks will be claimed.');
      } else {
        console.error(`Failed to resume: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
    } catch {
      console.error('Failed to resume — is the daemon running?');
      process.exit(1);
    }
    break;
  }

  case 'models': {
    const { ModelConfig: MC, PRESET_NAMES } = await import('../agents/ModelConfig.js');
    const { modelRegistry: registry } = await import('../agents/ModelTiers.js');
    const projectDir = process.cwd();
    const mc = new MC(projectDir);

    if (!subcommand || subcommand === 'show' || subcommand === 'status') {
      const configs = mc.getRoleConfigs();
      console.log('\nFlightdeck Model Configuration\n');
      console.log('Role              Runtime      Model              Tier');
      console.log('────────────────  ──────────   ────────────────   ──────');
      for (const rc of configs) {
        const tier = ['high', 'medium', 'fast'].includes(rc.model) ? rc.model : '';
        console.log(
          `${rc.role.padEnd(18)}${rc.runtime.padEnd(13)}${rc.model.padEnd(19)}${tier}`
        );
      }
      console.log(`\nPresets: ${PRESET_NAMES.join(' | ')}`);
      console.log('Run `flightdeck models list` to see available models.');
    } else if (subcommand === 'list') {
      const filterRuntime = positionals[2];
      const runtimes = filterRuntime ? [filterRuntime] : registry.getRuntimes();
      if (runtimes.length === 0) {
        console.log('No models registered yet. Models are discovered when agents connect via ACP.');
        console.log('Start flightdeck and connect an agent to populate the model list.');
        break;
      }
      for (const rt of runtimes) {
        const grouped = registry.getModelsGrouped(rt);
        console.log(`\nAvailable Models (${rt})\n`);
        console.log('Tier     Model ID              Display Name');
        console.log('──────   ───────────────────   ─────────────────────');
        for (const tier of ['high', 'medium', 'fast'] as const) {
          for (const m of grouped[tier]) {
            console.log(`${tier.padEnd(9)}${m.modelId.padEnd(22)}${m.displayName}`);
          }
        }
      }
    } else if (subcommand === 'set') {
      const role = positionals[2];
      const spec = positionals[3];
      if (!role || !spec) {
        console.error('Usage: flightdeck models set <role> <runtime:model>');
        console.error('Examples:');
        console.error('  flightdeck models set lead copilot:medium');
        console.error('  flightdeck models set worker claude-code:high');
        console.error('  flightdeck models set reviewer copilot:claude-opus-4-6');
        process.exit(1);
      }
      mc.setRole(role, spec);
      const updated = mc.getRoleConfig(role);
      console.log(`Updated ${role}: runtime=${updated.runtime} model=${updated.model}`);
    } else if (subcommand === 'set-default') {
      const spec = positionals[2];
      if (!spec) {
        console.error('Usage: flightdeck models set-default <runtime:model>');
        process.exit(1);
      }
      mc.setDefault(spec);
      console.log(`Default set to: ${spec}`);
    } else if (subcommand === 'preset') {
      const preset = positionals[2];
      if (!preset || !PRESET_NAMES.includes(preset)) {
        console.error(`Usage: flightdeck models preset <${PRESET_NAMES.join('|')}>`);
        process.exit(1);
      }
      mc.applyPreset(preset);
      console.log(`Applied preset: ${preset}`);
      const configs = mc.getRoleConfigs();
      for (const rc of configs) {
        console.log(`  ${rc.role.padEnd(18)}${rc.model}`);
      }
    } else {
      console.error('Usage: flightdeck models [list|set|set-default|preset]');
    }
    break;
  }

  case 'display': {
    const { DEFAULT_DISPLAY, DISPLAY_PRESETS, DISPLAY_PRESET_NAMES, mergeDisplayConfig } = await import('@flightdeck-ai/shared');
    const displayPort = (values as any).port || '3000';
    const displayBase = `http://localhost:${displayPort}`;

    if (!subcommand) {
      // Show current display config
      try {
        const res = await fetch(`${displayBase}/api/display`);
        const config = await res.json();
        console.log('\nDisplay Configuration\n');
        console.log(`  thinking:        ${config.thinking ? 'on' : 'off'}`);
        console.log(`  toolCalls:       ${config.toolCalls}`);
        console.log(`  flightdeckTools: ${config.flightdeckTools}`);
        if (config.toolOverrides && Object.keys(config.toolOverrides).length > 0) {
          console.log('  toolOverrides:');
          for (const [k, v] of Object.entries(config.toolOverrides)) {
            console.log(`    ${k}: ${v}`);
          }
        }
      } catch {
        console.log('\nDisplay Configuration (defaults — daemon not running)\n');
        console.log(`  thinking:        ${DEFAULT_DISPLAY.thinking ? 'on' : 'off'}`);
        console.log(`  toolCalls:       ${DEFAULT_DISPLAY.toolCalls}`);
        console.log(`  flightdeckTools: ${DEFAULT_DISPLAY.flightdeckTools}`);
      }
    } else if (subcommand === 'preset') {
      const preset = positionals[2];
      if (!preset || !DISPLAY_PRESET_NAMES.includes(preset as any)) {
        console.error(`Usage: flightdeck display preset <${DISPLAY_PRESET_NAMES.join('|')}>`);
        process.exit(1);
      }
      try {
        const res = await fetch(`${displayBase}/api/display/preset/${preset}`, { method: 'POST' });
        const config = await res.json();
        console.log(`Applied display preset: ${preset}`);
        console.log(`  thinking: ${config.thinking ? 'on' : 'off'}, toolCalls: ${config.toolCalls}, flightdeckTools: ${config.flightdeckTools}`);
      } catch {
        console.error('Failed to apply preset — is the daemon running?');
        process.exit(1);
      }
    } else if (subcommand === 'set') {
      const key = positionals[2];
      const val = positionals[3];
      if (!key || !val) {
        console.error('Usage: flightdeck display set <thinking|tools|flightdeck-tools> <on|off|summary|detail>');
        process.exit(1);
      }
      const body: Record<string, unknown> = {};
      if (key === 'thinking') {
        if (val !== 'on' && val !== 'off' && val !== 'true' && val !== 'false') {
          console.error('Invalid value for thinking. Use: on, off');
          process.exit(1);
        }
        body.thinking = val === 'on' || val === 'true';
      } else if (key === 'tools') {
        if (val !== 'off' && val !== 'summary' && val !== 'detail') {
          console.error('Invalid value for tools. Use: off, summary, detail');
          process.exit(1);
        }
        body.toolCalls = val;
      } else if (key === 'flightdeck-tools') {
        if (val !== 'off' && val !== 'summary' && val !== 'detail') {
          console.error('Invalid value for flightdeck-tools. Use: off, summary, detail');
          process.exit(1);
        }
        body.flightdeckTools = val;
      } else {
        console.error(`Unknown display key: ${key}. Use: thinking, tools, flightdeck-tools`);
        process.exit(1);
      }
      try {
        const res = await fetch(`${displayBase}/api/display`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const config = await res.json();
        console.log(`Updated: thinking=${config.thinking ? 'on' : 'off'}, toolCalls=${config.toolCalls}, flightdeckTools=${config.flightdeckTools}`);
      } catch {
        console.error('Failed to update display — is the daemon running?');
        process.exit(1);
      }
    } else {
      console.error('Usage: flightdeck display [preset <name> | set <key> <value>]');
    }
    break;
  }

  case 'tui': {
    const { execFileSync } = await import('node:child_process');
    const tuiArgs: string[] = [];
    if (values.port) tuiArgs.push('--port', String(values.port));
    const urlArg = (values as any).url;
    if (urlArg) tuiArgs.push('--url', urlArg);
    try {
      execFileSync('node', [new URL('../../tui/dist/index.js', import.meta.url).pathname, ...tuiArgs], { stdio: 'inherit' });
    } catch {
      // TUI package not found — try npx
      execFileSync('npx', ['flightdeck-tui', ...tuiArgs], { stdio: 'inherit' });
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
})().catch(err => { console.error(err); process.exit(1); });

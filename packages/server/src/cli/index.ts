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
    port: { type: 'string' },
    'cors-origin': { type: 'string' },
    'no-recover': { type: 'boolean', default: false },
    'fresh': { type: 'boolean', default: false },
    'continue': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    bind: { type: 'string' },
    auth: { type: 'string' },
    token: { type: 'string' },
    days: { type: 'string' },
    tz: { type: 'string' },
    skill: { type: 'string' },
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
  cron list|add|enable|disable|remove   Manage cron jobs
  report                  View latest report
  display                 Show current display config
  display preset <name>   Apply display preset (minimal|summary|detail|debug)
  display set <key> <val> Set display option (thinking on/off, tools summary, etc.)
  doctor                  Run diagnostic checks on Flightdeck setup
  gateway start            Start gateway as background service
  gateway stop             Stop gateway gracefully
  gateway restart          Restart gateway (saves/restores agent state)
  gateway status           Show gateway status
  gateway run              Run gateway in foreground (dev/debug)
  gateway health           Check gateway health endpoint
  gateway probe            Diagnostic checks (PID, port, /health)
  gateway usage-cost       Show cost summary across projects
  gateway install          Install as OS service (launchd/systemd)
  gateway uninstall        Remove OS service
  acp                      Run as ACP Agent server (stdin/stdout)
  start [--project X]     Alias for 'gateway run' (backward compat)
  pause                   Pause orchestrator (stop claiming new tasks)
  resume                  Resume orchestrator (start claiming tasks)
  tui                     Launch terminal UI
  providers              List available agent providers and detect installed binaries

Options:
  -p, --project <name>    Project name (default: from .flightdeck.json)
  --port <port>           Gateway port (default: 18800)
  --bind <mode>           Bind address: loopback (default), lan (0.0.0.0), or IP
  --auth <mode>           Auth mode: none (default) or token
  --token <token>         Explicit auth token (with --auth token)
  --force                 Kill existing process on port before starting
  --json                  JSON output for query commands
  --no-recover / --fresh  Skip session recovery on start
  --continue              Resume all workers aggressively on restart
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
    // Store the project working directory in config for status file generation
    const cfg = store.getConfig();
    cfg.cwd = process.cwd();
    store.setConfig(cfg);
    ProjectStore.writeFlightdeckJson(process.cwd(), name);
    // Generate default AGENTS.md (worker role)
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
    console.log('Written: AGENTS.md');
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
      const role = (values as any).role || 'worker';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const since = (values as any).since || undefined;
    console.log(report.generate({ since }));
    fd.close();
    break;
  }

  case 'gateway': {
    const { gatewayStart, gatewayStop, gatewayRestart, gatewayStatus, gatewayRun, gatewayHealth, gatewayProbe, gatewayUsageCost } = await import('./gateway-lifecycle.js');
    const gatewayOpts = {
      port: values.port ? parseInt(String(values.port), 10) : undefined,
      corsOrigin: values['cors-origin'] as string | undefined,
      noRecover: !!(values['no-recover'] || values['fresh'] as unknown),
      continueWorkers: !!(values['continue'] as unknown),
      projectFilter: values.project as string | undefined,
      force: !!(values.force as unknown),
      bind: values.bind as string | undefined,
      auth: values.auth as 'none' | 'token' | undefined,
      token: values.token as string | undefined,
      json: !!(values.json as unknown),
      days: values.days ? parseInt(String(values.days), 10) : undefined,
    };
    switch (subcommand) {
      case 'start': await gatewayStart(gatewayOpts); break;
      case 'stop': await gatewayStop(); break;
      case 'restart': await gatewayRestart(gatewayOpts); break;
      case 'status': await gatewayStatus(gatewayOpts); break;
      case 'run': await gatewayRun(gatewayOpts); break;
      case 'health': await gatewayHealth(gatewayOpts); break;
      case 'probe': await gatewayProbe(gatewayOpts); break;
      case 'usage-cost': await gatewayUsageCost(gatewayOpts); break;
      case 'install': {
        const { installService } = await import('./gateway/service.js');
        installService();
        break;
      }
      case 'uninstall': {
        const { uninstallService } = await import('./gateway/service.js');
        uninstallService();
        break;
      }
      default:
        console.error('Usage: flightdeck gateway <start|stop|restart|status|run|health|probe|usage-cost|install|uninstall>');
        process.exit(1);
    }
    break;
  }

  case 'cron': {
    const projName = resolveProject();
    const fd = new Flightdeck(projName);
    const cronStore = fd.cron;
    if (subcommand === 'list') {
      const jobs = cronStore.listJobs();
      if (jobs.length === 0) { console.log('No cron jobs.'); }
      for (const j of jobs) {
        const status = j.enabled ? 'enabled' : 'disabled';
        const next = j.state.nextRunAt ? new Date(j.state.nextRunAt).toLocaleString() : 'n/a';
        console.log(`  [${status.padEnd(8)}] ${j.id.slice(0, 8)}  ${j.schedule.expr.padEnd(15)} ${j.name}  (next: ${next})`);
      }
    } else if (subcommand === 'add') {
      const name = positionals[2];
      const schedule = positionals[3];
      const prompt = positionals.slice(4).join(' ');
      if (!name || !schedule || !prompt) {
        console.error('Usage: flightdeck cron add <name> <schedule> <prompt> [--tz <timezone>] [--skill <name>]');
        fd.close();
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
      const tz = (values as any).tz as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
      const skill = (values as any).skill as string | undefined;
      const job = cronStore.addJob({ name, schedule: { kind: 'cron', expr: schedule, tz }, prompt, skill });
      console.log(`Cron job created: ${job.id} [${job.schedule.expr}] ${job.name}`);
    } else if (subcommand === 'enable') {
      const idOrName = positionals[2];
      if (!idOrName) { console.error('Usage: flightdeck cron enable <id|name>'); fd.close(); break; }
      const job = cronStore.resolveJob(idOrName);
      if (!job) { console.log(`Job not found: ${idOrName}`); fd.close(); break; }
      cronStore.enableJob(job.id);
      console.log(`Enabled: ${job.name} (${job.id.slice(0, 8)})`);
    } else if (subcommand === 'disable') {
      const idOrName = positionals[2];
      if (!idOrName) { console.error('Usage: flightdeck cron disable <id|name>'); fd.close(); break; }
      const job = cronStore.resolveJob(idOrName);
      if (!job) { console.log(`Job not found: ${idOrName}`); fd.close(); break; }
      cronStore.disableJob(job.id);
      console.log(`Disabled: ${job.name} (${job.id.slice(0, 8)})`);
    } else if (subcommand === 'remove') {
      const idOrName = positionals[2];
      if (!idOrName) { console.error('Usage: flightdeck cron remove <id|name>'); fd.close(); break; }
      const job = cronStore.resolveJob(idOrName);
      if (!job) { console.log(`Job not found: ${idOrName}`); fd.close(); break; }
      cronStore.removeJob(job.id);
      console.log(`Removed: ${job.name} (${job.id.slice(0, 8)})`);
    } else {
      console.error('Usage: flightdeck cron <list|add|enable|disable|remove>');
    }
    fd.close();
    break;
  }

  case 'acp': {
    const { runAcpAgent } = await import('../acp/index.js');
    await runAcpAgent({ project: values.project as string | undefined });
    break;
  }

  // Backward compat: `flightdeck start` → `flightdeck gateway run`
  case 'start': {
    const { gatewayRun } = await import('./gateway-lifecycle.js');
    const port = values.port ? parseInt(String(values.port), 10) : undefined;
    const corsOrigin = (values['cors-origin'] as string | undefined);
    const noRecover = !!(values['no-recover'] || values['fresh'] as unknown);
    const continueWorkers = !!(values['continue'] as unknown);
    const projectFilter = values.project as string | undefined;
    await gatewayRun({ port, corsOrigin, noRecover, continueWorkers, projectFilter });
    break;
  }

  case 'chat': {
    const { autoDetectPort } = await import('./gateway-lifecycle.js');
    const chatPort = autoDetectPort(values.port as string | undefined);
    const chatMessage = positionals.slice(1).join(' ');
    if (!chatMessage) { console.error('Usage: flightdeck chat <message>'); process.exit(1); }
    try {
      const chatProject = resolveProject();
      const res = await fetch(`http://localhost:${chatPort}/api/projects/${encodeURIComponent(chatProject)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chatMessage }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
        console.error(`Error: ${(err as any).error ?? res.statusText}`);
        process.exit(1);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API response shape is loosely typed
      const data = await res.json() as { message: any; response: any };
      if (data.response) {
        const content = typeof data.response === 'string' ? data.response : data.response.content;
        console.log(content);
      } else {
        console.log('(No response from Lead)');
      }
    } catch {
      console.error('Failed to send message — is the gateway running?');
      process.exit(1);
    }
    break;
  }

  case 'pause': {
    const { autoDetectPort: autoDetectPortPause } = await import('./gateway-lifecycle.js');
    const pausePort = autoDetectPortPause(values.port as string | undefined);
    try {
      const pauseProject = resolveProject();
      const res = await fetch(`http://localhost:${pausePort}/api/projects/${encodeURIComponent(pauseProject)}/orchestrator/pause`, { method: 'POST' });
      if (res.ok) {
        console.log('Orchestrator paused. In-progress tasks will continue but no new tasks will be claimed.');
      } else {
        console.error(`Failed to pause: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
    } catch {
      console.error('Failed to pause — is the gateway running?');
      process.exit(1);
    }
    break;
  }

  case 'resume': {
    const { autoDetectPort: autoDetectPortResume } = await import('./gateway-lifecycle.js');
    const resumePort = autoDetectPortResume(values.port as string | undefined);
    try {
      const resumeProject = resolveProject();
      const res = await fetch(`http://localhost:${resumePort}/api/projects/${encodeURIComponent(resumeProject)}/orchestrator/resume`, { method: 'POST' });
      if (res.ok) {
        console.log('Orchestrator resumed. New tasks will be claimed.');
      } else {
        console.error(`Failed to resume: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
    } catch {
      console.error('Failed to resume — is the gateway running?');
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
    const { DEFAULT_DISPLAY, DISPLAY_PRESET_NAMES, } = await import('@flightdeck-ai/shared');
 
    const displayPort = values.port || '18800';
    const displayBase = `http://localhost:${displayPort}`;

    if (!subcommand) {
      // Show current display config
      try {
        const displayProject = resolveProject();
      const res = await fetch(`${displayBase}/api/projects/${encodeURIComponent(displayProject)}/display`);
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
        console.log('\nDisplay Configuration (defaults — gateway not running)\n');
        console.log(`  thinking:        ${DEFAULT_DISPLAY.thinking ? 'on' : 'off'}`);
        console.log(`  toolCalls:       ${DEFAULT_DISPLAY.toolCalls}`);
        console.log(`  flightdeckTools: ${DEFAULT_DISPLAY.flightdeckTools}`);
      }
    } else if (subcommand === 'preset') {
      const preset = positionals[2];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
      if (!preset || !DISPLAY_PRESET_NAMES.includes(preset as any)) {
        console.error(`Usage: flightdeck display preset <${DISPLAY_PRESET_NAMES.join('|')}>`);
        process.exit(1);
      }
      try {
        const displayProject2 = resolveProject();
        const res = await fetch(`${displayBase}/api/projects/${encodeURIComponent(displayProject2)}/display/preset/${preset}`, { method: 'POST' });
        const config = await res.json();
        console.log(`Applied display preset: ${preset}`);
        console.log(`  thinking: ${config.thinking ? 'on' : 'off'}, toolCalls: ${config.toolCalls}, flightdeckTools: ${config.flightdeckTools}`);
      } catch {
        console.error('Failed to apply preset — is the gateway running?');
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
        const displayProject3 = resolveProject();
        const res = await fetch(`${displayBase}/api/projects/${encodeURIComponent(displayProject3)}/display`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const config = await res.json();
        console.log(`Updated: thinking=${config.thinking ? 'on' : 'off'}, toolCalls=${config.toolCalls}, flightdeckTools=${config.flightdeckTools}`);
      } catch {
        console.error('Failed to update display — is the gateway running?');
        process.exit(1);
      }
    } else {
      console.error('Usage: flightdeck display [preset <name> | set <key> <value>]');
    }
    break;
  }

  case 'tui': {
    const { execFileSync } = await import('node:child_process');
    const { resolve: resolvePath, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const tuiArgs: string[] = [];
    if (values.port) tuiArgs.push('--port', String(values.port));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const urlArg = (values as any).url;
    if (urlArg) tuiArgs.push('--url', urlArg);
    // Resolve TUI entry point (source or dist)
    const serverDir = dirname(fileURLToPath(import.meta.url));
    const tuiSrc = resolvePath(serverDir, '..', '..', '..', 'tui', 'src', 'index.tsx');
    const tuiDist = resolvePath(serverDir, '..', '..', '..', 'tui', 'dist', 'index.js');
    const { existsSync } = await import('node:fs');
    try {
      if (existsSync(tuiDist)) {
        execFileSync('node', [tuiDist, ...tuiArgs], { stdio: 'inherit' });
      } else {
        // Dev mode: use tsx to run TypeScript source directly
        execFileSync('npx', ['tsx', tuiSrc, ...tuiArgs], { stdio: 'inherit' });
      }
    } catch { /* TUI exited */ }
    break;
  }

  case 'doctor': {
    const { runDoctor } = await import('./doctor.js');
    await runDoctor({ json: !!(values.json as unknown), cwd: process.cwd() });
    break;
  }

  case 'providers': {
    const { RUNTIME_REGISTRY } = await import('../agents/runtimes.js');
    const { execFileSync } = await import('node:child_process');

    const checkBinary = (cmd: string): boolean => {
      try {
        execFileSync('which', [cmd], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };

    if (values.json) {
      const entries = Object.entries(RUNTIME_REGISTRY).map(([key, r]) => ({
        id: key,
        name: r.name,
        command: r.command,
        args: r.args,
        supportsAcp: r.supportsAcp,
        adapter: r.adapter,
        installed: checkBinary(r.command),
        notes: r.notes,
      }));
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log('\nFlightdeck Agent Providers\n');
      console.log('ACP-compatible (ready to use):');
      for (const [key, r] of Object.entries(RUNTIME_REGISTRY)) {
        if (!r.supportsAcp) continue;
        const installed = checkBinary(r.command);
        const status = installed ? '\x1b[32m✓ installed\x1b[0m' : '\x1b[33m✗ not found\x1b[0m';
        console.log(`  ${key.padEnd(14)} ${r.name.padEnd(28)} ${status}`);
        console.log(`${''.padEnd(16)}command: ${r.command} ${r.args.join(' ')}`);
      }
      console.log('\nNon-ACP (needs custom adapter):');
      for (const [key, r] of Object.entries(RUNTIME_REGISTRY)) {
        if (r.supportsAcp) continue;
        const installed = checkBinary(r.command);
        const status = installed ? '\x1b[32m✓ installed\x1b[0m' : '\x1b[90m✗ not found\x1b[0m';
        console.log(`  ${key.padEnd(14)} ${r.name.padEnd(28)} ${status}`);
        console.log(`${''.padEnd(16)}${r.notes.slice(0, 80)}`);
      }
      console.log();
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
})().catch(err => { console.error(err); process.exit(1); });

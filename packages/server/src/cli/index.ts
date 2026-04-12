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

  case 'start': {
    const { startDaemon } = await import('./daemon.js');
    const projectName = resolveProject();
    const fd = new Flightdeck(projectName);
    const port = parseInt(String(values.port ?? '3000'), 10);
    const corsOrigin = (values['cors-origin'] as string | undefined) ?? '*';
    const noRecover = !!(values['no-recover'] || values['fresh'] as unknown);
    await startDaemon({ fd, projectName, port, corsOrigin, noRecover });
    break;
  }

  case 'chat': {
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const chatPort = values.port || '3000';
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
      console.error('Failed to send message — is the daemon running?');
      process.exit(1);
    }
    break;
  }

  case 'pause': {
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const pausePort = values.port || '3000';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const resumePort = values.port || '3000';
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
    const { DEFAULT_DISPLAY, DISPLAY_PRESET_NAMES, } = await import('@flightdeck-ai/shared');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
    const displayPort = values.port || '3000';
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast needed for untyped API
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parseArgs values not fully typed
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

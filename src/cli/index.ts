#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';

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
  log                     View decision log
  report                  View latest report
  start [--profile X]     Start orchestrator (stub)
  pause                   Pause orchestrator (stub)
  resume                  Resume orchestrator (stub)

Options:
  -p, --project <name>    Project name (default: from .flightdeck.json)
  -h, --help              Show help
`);
}

function resolveProject(): string {
  if (values.project) return values.project;
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

switch (command) {
  case 'init': {
    const name = positionals[1];
    if (!name) { console.error('Usage: flightdeck init <project-name>'); process.exit(1); }
    const store = new ProjectStore(name);
    store.init(name);
    ProjectStore.writeFlightdeckJson(process.cwd(), name);
    // Generate default AGENTS.md (worker role) and .mcp.json
    ProjectStore.writeAgentFiles(process.cwd(), 'worker');
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
    const fd = new Flightdeck(resolveProject());
    const report = fd.reports.latest();
    if (!report) { console.log('No reports generated yet.'); }
    else { console.log(report); }
    fd.close();
    break;
  }

  case 'start': {
    const fd = new Flightdeck(resolveProject());
    const profile = values.profile ?? fd.status().config.governance;
    console.log(`Starting orchestrator with profile: ${profile}...`);
    fd.orchestrator.start();
    console.log('Orchestrator running. Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      console.log('\nStopping orchestrator...');
      fd.close();
      process.exit(0);
    });
    break;
  }

  case 'pause': {
    console.log('Pausing orchestrator... (stub)');
    break;
  }

  case 'resume': {
    console.log('Resuming orchestrator... (stub)');
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}

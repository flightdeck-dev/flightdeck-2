#!/usr/bin/env node
// Flightdeck CLI — thin wrapper over the library facade
// Usage: npx tsx src/cli/index.ts <command> [args] [--json]

import { parseArgs } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Flightdeck } from '../facade.js';

const DB_DIR = '.flightdeck';
const DB_PATH = `${DB_DIR}/flightdeck.db`;

function getDb(): Flightdeck {
  if (!existsSync(DB_DIR)) {
    console.error(`No .flightdeck/ directory found. Run 'flightdeck init' first.`);
    process.exit(1);
  }
  return new Flightdeck({ dbPath: DB_PATH });
}

function out(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (Array.isArray(data)) {
    if (data.length === 0) { console.log('(none)'); return; }
    for (const item of data) {
      if (item.id && item.title) {
        const state = item.state ? ` [${item.state}]` : '';
        const role = item.role ? ` (${item.role})` : '';
        const status = item.status ? ` [${item.status}]` : '';
        console.log(`  ${item.id}  ${item.title || item.name}${state}${role}${status}`);
      } else if (item.id && item.content) {
        console.log(`  ${item.id}  from:${item.from} → ${item.content.slice(0, 80)}`);
      } else if (item.id && item.name) {
        console.log(`  ${item.id}  ${item.name} [${item.role}] ${item.status}`);
      } else {
        console.log(`  ${JSON.stringify(item)}`);
      }
    }
  } else if (typeof data === 'object' && data !== null) {
    const d = data as any;
    if (d.id && d.title) {
      console.log(`ID:      ${d.id}`);
      console.log(`Title:   ${d.title}`);
      if (d.state) console.log(`State:   ${d.state}`);
      if (d.role) console.log(`Role:    ${d.role}`);
      if (d.assignedAgent) console.log(`Agent:   ${d.assignedAgent}`);
      if (d.dependsOn?.length) console.log(`Depends: ${d.dependsOn.join(', ')}`);
      if (d.priority) console.log(`Priority: ${d.priority}`);
      if (d.requirements) console.log(`Requirements: ${d.requirements.length}`);
      console.log(`Created: ${d.createdAt}`);
    } else if (d.tasks && d.agents) {
      // status
      console.log('=== Flightdeck Status ===');
      console.log(`Tasks: ${d.tasks.total}`);
      for (const [s, n] of Object.entries(d.tasks.byState)) {
        if (n as number > 0) console.log(`  ${s}: ${n}`);
      }
      console.log(`Agents: ${d.agents.total} (${d.agents.idle} idle, ${d.agents.busy} busy)`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } else {
    console.log(data);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) { usage(); process.exit(0); }

  const jsonFlag = args.includes('--json');
  const cleanArgs = args.filter(a => a !== '--json');

  const [cmd, sub, ...rest] = cleanArgs;

  try {
    switch (cmd) {
      case 'init': return doInit();
      case 'status': return doStatus(jsonFlag);
      case 'task': return doTask(sub, rest, jsonFlag);
      case 'spec': return doSpec(sub, rest, jsonFlag);
      case 'agent': return doAgent(sub, rest, jsonFlag);
      case 'msg': return doMsg(sub, rest, jsonFlag);
      case 'verify': return doVerify(sub, rest, jsonFlag);
      case 'help': case '--help': case '-h': return usage();
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

function usage(): void {
  console.log(`
flightdeck — multi-agent orchestration CLI

Commands:
  init                                    Initialize .flightdeck/ directory
  status                                  Overall system status
  
  task add <title> --role <role>          Add a task
  task list [--status <state>]            List tasks
  task start <id> --agent <agent-id>      Start a task
  task complete <id>                      Complete a task
  task fail <id> [--reason <reason>]      Fail a task
  task gate <id> --await-type <t> --await-id <id>  Gate a task
  task status                             DAG summary
  task topo                               Topological order
  
  spec create <title>                     Create a spec
  spec list                               List specs
  spec show <id>                          Show spec details
  spec change propose <spec-id>           Propose a change
  spec change approve <change-id>         Approve a change
  
  agent register <id> --role <role>       Register an agent
  agent list                              List agents
  agent heartbeat <id>                    Send heartbeat
  
  msg send <to> <content> [--priority p]  Send a message
  msg inbox <agent-id>                    Get agent inbox
  msg list [--thread <id>]                List messages
  
  verify request <task-id> [--reviewer <agent-id>]  Request review
  verify decide <review-id> --verdict <v>            Submit verdict

Flags:
  --json    Output as JSON
  --help    Show this help
`);
}

function doInit(): void {
  if (existsSync(DB_DIR)) {
    console.log('.flightdeck/ already exists');
    return;
  }
  mkdirSync(DB_DIR, { recursive: true });
  const fd = new Flightdeck({ dbPath: DB_PATH });
  fd.close();
  console.log('Initialized .flightdeck/ directory');
}

function doStatus(json: boolean): void {
  const fd = getDb();
  out(fd.status(), json);
  fd.close();
}

function doTask(sub: string, rest: string[], json: boolean): void {
  const fd = getDb();
  try {
    switch (sub) {
      case 'add': {
        const title = extractPositional(rest);
        const opts = parseFlags(rest, ['role', 'depends-on', 'priority']);
        if (!opts.role) throw new Error('--role is required');
        const dependsOn = opts['depends-on'] ? opts['depends-on'].split(',') : undefined;
        const task = fd.addTask({ title, role: opts.role, dependsOn, priority: opts.priority ? parseInt(opts.priority) : undefined });
        out(task, json);
        break;
      }
      case 'list': {
        const opts = parseFlags(rest, ['status']);
        out(fd.listTasks(opts.status ? { status: opts.status as any } : undefined), json);
        break;
      }
      case 'start': {
        const id = rest[0]; if (!id) throw new Error('Task ID required');
        const opts = parseFlags(rest.slice(1), ['agent']);
        if (!opts.agent) throw new Error('--agent is required');
        out(fd.startTask(id, opts.agent), json);
        break;
      }
      case 'complete': {
        const id = rest[0]; if (!id) throw new Error('Task ID required');
        out(fd.completeTask(id), json);
        break;
      }
      case 'fail': {
        const id = rest[0]; if (!id) throw new Error('Task ID required');
        const opts = parseFlags(rest.slice(1), ['reason']);
        out(fd.failTask(id, opts.reason), json);
        break;
      }
      case 'gate': {
        const id = rest[0]; if (!id) throw new Error('Task ID required');
        const opts = parseFlags(rest.slice(1), ['await-type', 'await-id']);
        if (!opts['await-type'] || !opts['await-id']) throw new Error('--await-type and --await-id required');
        out(fd.gateTask(id, opts['await-type'], opts['await-id']), json);
        break;
      }
      case 'status': out(fd.dagStats(), json); break;
      case 'topo': out(fd.topoSort(), json); break;
      default: throw new Error(`Unknown task subcommand: ${sub}`);
    }
  } finally { fd.close(); }
}

function doSpec(sub: string, rest: string[], json: boolean): void {
  const fd = getDb();
  try {
    switch (sub) {
      case 'create': {
        const title = rest.join(' ');
        if (!title) throw new Error('Title required');
        out(fd.createSpec(title), json);
        break;
      }
      case 'list': out(fd.listSpecs(), json); break;
      case 'show': {
        const id = rest[0]; if (!id) throw new Error('Spec ID required');
        const spec = fd.getSpec(id);
        if (!spec) throw new Error(`Spec '${id}' not found`);
        out(spec, json);
        break;
      }
      case 'change': {
        const action = rest[0];
        const id = rest[1];
        if (!action || !id) throw new Error('Usage: spec change <propose|approve> <id>');
        if (action === 'propose') {
          out(fd.proposeChange(id), json);
        } else if (action === 'approve') {
          out(fd.approveChange(id), json);
        } else {
          throw new Error(`Unknown change action: ${action}`);
        }
        break;
      }
      default: throw new Error(`Unknown spec subcommand: ${sub}`);
    }
  } finally { fd.close(); }
}

function doAgent(sub: string, rest: string[], json: boolean): void {
  const fd = getDb();
  try {
    switch (sub) {
      case 'register': {
        const id = rest[0]; if (!id) throw new Error('Agent ID required');
        const opts = parseFlags(rest.slice(1), ['role']);
        if (!opts.role) throw new Error('--role is required');
        out(fd.registerAgent(id, opts.role), json);
        break;
      }
      case 'list': out(fd.listAgents(), json); break;
      case 'heartbeat': {
        const id = rest[0]; if (!id) throw new Error('Agent ID required');
        const ok = fd.agentHeartbeat(id);
        out(ok ? 'OK' : 'Agent not found', json);
        break;
      }
      default: throw new Error(`Unknown agent subcommand: ${sub}`);
    }
  } finally { fd.close(); }
}

function doMsg(sub: string, rest: string[], json: boolean): void {
  const fd = getDb();
  try {
    switch (sub) {
      case 'send': {
        const to = rest[0];
        const content = rest.slice(1).filter(a => !a.startsWith('--')).join(' ');
        if (!to || !content) throw new Error('Usage: msg send <to> <content>');
        const opts = parseFlags(rest.slice(1), ['priority']);
        out(fd.sendMessage(to, content, { priority: opts.priority as any }), json);
        break;
      }
      case 'inbox': {
        const agentId = rest[0]; if (!agentId) throw new Error('Agent ID required');
        out(fd.getInbox(agentId), json);
        break;
      }
      case 'list': {
        const opts = parseFlags(rest, ['thread']);
        out(fd.listMessages(opts.thread ? { threadId: opts.thread } : undefined), json);
        break;
      }
      default: throw new Error(`Unknown msg subcommand: ${sub}`);
    }
  } finally { fd.close(); }
}

function doVerify(sub: string, rest: string[], json: boolean): void {
  const fd = getDb();
  try {
    switch (sub) {
      case 'request': {
        const taskId = rest[0]; if (!taskId) throw new Error('Task ID required');
        const opts = parseFlags(rest.slice(1), ['reviewer']);
        out(fd.requestReview(taskId, opts.reviewer), json);
        break;
      }
      case 'decide': {
        const reviewId = rest[0]; if (!reviewId) throw new Error('Review ID required');
        const opts = parseFlags(rest.slice(1), ['verdict']);
        if (!opts.verdict) throw new Error('--verdict is required (approve|request_changes|reject)');
        out(fd.decideReview(reviewId, opts.verdict), json);
        break;
      }
      default: throw new Error(`Unknown verify subcommand: ${sub}`);
    }
  } finally { fd.close(); }
}

// Helpers

function extractPositional(args: string[]): string {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    positional.push(args[i]);
  }
  return positional.join(' ');
}

function parseFlags(args: string[], known: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (known.includes(key) && i + 1 < args.length) {
        result[key] = args[++i];
      }
    }
  }
  return result;
}

main();

/**
 * Gateway lifecycle management: start (background), stop, restart, status, run (foreground).
 * Follows the OpenClaw `openclaw gateway` pattern.
 *
 * State files in ~/.flightdeck/:
 *   gateway.pid          — PID of background gateway
 *   gateway.port         — port the gateway is listening on
 *   gateway-state.json   — saved agent state for restart recovery
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';

const FD_DIR = join(homedir(), '.flightdeck');
const PID_FILE = join(FD_DIR, 'gateway.pid');
const PORT_FILE = join(FD_DIR, 'gateway.port');
const STATE_FILE = join(FD_DIR, 'gateway-state.json');

function ensureDir(): void {
  if (!existsSync(FD_DIR)) mkdirSync(FD_DIR, { recursive: true });
}

/** Read PID from file, return null if missing or stale. */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0); // check if alive
    return pid;
  } catch {
    // Process gone — clean up stale files
    cleanPidFiles();
    return null;
  }
}

function readPort(): number | null {
  if (!existsSync(PORT_FILE)) return null;
  const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
  return isNaN(port) ? null : port;
}

function cleanPidFiles(): void {
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(PORT_FILE); } catch {}
}

export interface GatewaySubcommandOpts {
  port?: number;
  corsOrigin?: string;
  noRecover?: boolean;
  projectFilter?: string;
}

export async function gatewayStart(opts: GatewaySubcommandOpts): Promise<void> {
  const existing = readPid();
  if (existing) {
    const existingPort = readPort();
    console.log(`Gateway already running (PID ${existing}${existingPort ? `, port ${existingPort}` : ''}).`);
    process.exit(0);
  }

  ensureDir();
  const port = opts.port ?? 3000;

  // Find the gateway entry point (this file's sibling index.ts compiled to index.js)
  const entryPoint = new URL('./index.js', import.meta.url).pathname;

  // Build args for the foreground `gateway run` subcommand
  const args = [entryPoint, 'gateway', 'run', '--port', String(port)];
  if (opts.corsOrigin) args.push('--cors-origin', opts.corsOrigin);
  if (opts.noRecover) args.push('--no-recover');
  if (opts.projectFilter) args.push('--project', opts.projectFilter);

  // Fork gateway to background
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to start gateway.');
    process.exit(1);
  }

  writeFileSync(PID_FILE, String(pid));
  writeFileSync(PORT_FILE, String(port));

  // Wait briefly to check it didn't crash immediately
  await new Promise(r => setTimeout(r, 1000));
  try {
    process.kill(pid, 0);
  } catch {
    console.error('Gateway exited immediately. Check logs.');
    cleanPidFiles();
    process.exit(1);
  }

  console.log(`Flightdeck gateway started (PID ${pid}, port ${port}).`);
}

export async function gatewayStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log('Gateway is not running.');
    return;
  }

  console.log(`Stopping gateway (PID ${pid})...`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5s for clean shutdown
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      // Process gone
      cleanPidFiles();
      console.log('Gateway stopped.');
      return;
    }
  }

  // Force kill
  try { process.kill(pid, 'SIGKILL'); } catch {}
  cleanPidFiles();
  console.log('Gateway killed (forced).');
}

export interface AgentState {
  project: string;
  agentId: string;
  role: string;
  acpSessionId: string | null;
}

function saveAgentState(agents: AgentState[]): void {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(agents, null, 2));
}

export function loadAgentState(): AgentState[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/** Save current gateway agent state via the HTTP API before stopping. */
async function saveStateFromGateway(port: number): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${port}/api/gateway/state`);
    if (res.ok) {
      const agents: AgentState[] = await res.json() as AgentState[];
      saveAgentState(agents);
      console.log(`Saved state for ${agents.length} agent(s).`);
    }
  } catch {
    console.log('Could not save agent state (gateway may already be stopping).');
  }
}

export async function gatewayRestart(opts: GatewaySubcommandOpts): Promise<void> {
  const existingPort = readPort();
  const pid = readPid();

  if (pid && existingPort) {
    // Save state before stopping
    await saveStateFromGateway(existingPort);
    await gatewayStop();
  }

  // Start with recovery (don't pass --no-recover so it can pick up state)
  await gatewayStart({ ...opts, port: opts.port ?? existingPort ?? 3000 });
}

export async function gatewayStatus(): Promise<void> {
  const pid = readPid();
  const port = readPort();

  if (!pid) {
    console.log('Gateway: stopped');
    return;
  }

  console.log(`Gateway: running`);
  console.log(`  PID:  ${pid}`);
  console.log(`  Port: ${port ?? 'unknown'}`);

  if (port) {
    try {
      const res = await fetch(`http://localhost:${port}/api/projects`);
      if (res.ok) {
        const projects = await res.json() as Array<{ name: string; agents: number }>;
        console.log(`  Projects: ${projects.length}`);
        for (const p of projects) {
          console.log(`    - ${p.name} (${p.agents ?? '?'} agents)`);
        }
      }
    } catch {
      console.log('  (Could not reach gateway API)');
    }
  }
}

export async function gatewayRun(opts: GatewaySubcommandOpts): Promise<void> {
  // Write PID/port files even in foreground mode so other commands can find us
  ensureDir();
  const port = opts.port ?? 3000;
  writeFileSync(PID_FILE, String(process.pid));
  writeFileSync(PORT_FILE, String(port));

  // Clean up on exit
  const cleanup = () => { cleanPidFiles(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  const { startGateway } = await import('./gateway.js');
  await startGateway({
    port,
    corsOrigin: opts.corsOrigin ?? '*',
    noRecover: opts.noRecover ?? false,
    projectFilter: opts.projectFilter,
  });
}

/**
 * Auto-detect gateway port from ~/.flightdeck/gateway.port.
 * Falls back to the provided default (usually 3000).
 */
export function autoDetectPort(explicitPort: string | undefined): string {
  if (explicitPort) return explicitPort;
  const port = readPort();
  return port ? String(port) : '3000';
}

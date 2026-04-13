/**
 * Gateway lifecycle management: start, stop, restart, status, run, health, probe, usage-cost, install/uninstall.
 * Follows the OpenClaw `openclaw gateway` pattern.
 *
 * State files in ~/.flightdeck/:
 *   gateway.pid          — PID of background gateway
 *   gateway.port         — port the gateway is listening on
 *   gateway.token        — auth token (generated on first start with --auth token)
 *   gateway-state.json   — saved agent state for restart recovery
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { AuthMode } from './gateway/auth.js';

const FD_DIR = join(homedir(), '.flightdeck');
const PID_FILE = join(FD_DIR, 'gateway.pid');
const PORT_FILE = join(FD_DIR, 'gateway.port');
const STATE_FILE = join(FD_DIR, 'gateway-state.json');

function ensureDir(): void {
  if (!existsSync(FD_DIR)) mkdirSync(FD_DIR, { recursive: true });
}

// ── PID / Port helpers ──

/** Read PID from file, return null if missing or stale. */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
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

/** Check if a TCP port is in use. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { resolve(false); });
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

/** Kill process holding the port via PID file, or lsof as fallback. */
async function forceKillPort(port: number): Promise<void> {
  // Try PID file first
  const pid = readPid();
  if (pid) {
    console.log(`Killing existing gateway (PID ${pid})...`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    // Wait briefly
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { break; }
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    cleanPidFiles();
    return;
  }

  // Fallback: lsof
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8' }).trim();
    if (output) {
      for (const p of output.split('\n')) {
        const lpid = parseInt(p, 10);
        if (!isNaN(lpid)) {
          console.log(`Killing process ${lpid} on port ${port}...`);
          try { process.kill(lpid, 'SIGTERM'); } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch {}
}

// ── Resolve bind address ──

export type BindMode = 'loopback' | 'lan' | string;

function resolveBindAddress(bind?: BindMode): string {
  if (!bind || bind === 'loopback') return '127.0.0.1';
  if (bind === 'lan') return '0.0.0.0';
  return bind; // raw IP
}

// ── Options ──

export interface GatewaySubcommandOpts {
  port?: number;
  corsOrigin?: string;
  noRecover?: boolean;
  projectFilter?: string;
  force?: boolean;
  bind?: BindMode;
  auth?: AuthMode;
  token?: string;
  json?: boolean;
  days?: number;
}

// ── Agent state persistence ──

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

async function saveStateFromGateway(port: number, token?: string | null): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`http://localhost:${port}/api/gateway/state`, { headers });
    if (res.ok) {
      const agents: AgentState[] = await res.json() as AgentState[];
      saveAgentState(agents);
      console.log(`Saved state for ${agents.length} agent(s).`);
    }
  } catch {
    console.log('Could not save agent state (gateway may already be stopping).');
  }
}

// ── Subcommands ──

export async function gatewayStart(opts: GatewaySubcommandOpts): Promise<void> {
  const port = opts.port ?? 3000;

  // --force: kill existing process on port
  if (opts.force) {
    if (await isPortInUse(port)) {
      await forceKillPort(port);
      // Wait for port to free
      for (let i = 0; i < 20; i++) {
        if (!(await isPortInUse(port))) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  const existing = readPid();
  if (existing) {
    const existingPort = readPort();
    console.log(`Gateway already running (PID ${existing}${existingPort ? `, port ${existingPort}` : ''}).`);
    process.exit(0);
  }

  ensureDir();

  const entryPoint = new URL('./index.js', import.meta.url).pathname;

  const args = [entryPoint, 'gateway', 'run', '--port', String(port)];
  if (opts.corsOrigin) args.push('--cors-origin', opts.corsOrigin);
  if (opts.noRecover) args.push('--no-recover');
  if (opts.projectFilter) args.push('--project', opts.projectFilter);
  if (opts.bind) args.push('--bind', opts.bind);
  if (opts.auth) args.push('--auth', opts.auth);
  if (opts.token) args.push('--token', opts.token);

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

  await new Promise(r => setTimeout(r, 1000));
  try {
    process.kill(pid, 0);
  } catch {
    console.error('Gateway exited immediately. Check logs.');
    cleanPidFiles();
    process.exit(1);
  }

  console.log(`Flightdeck gateway started (PID ${pid}, port ${port}).`);

  // Print token if auth is enabled
  if (opts.auth === 'token') {
    const { readToken } = await import('./gateway/auth.js');
    const tk = readToken();
    if (tk) console.log(`Auth token: ${tk}`);
  }
}

export async function gatewayStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log('Gateway is not running.');
    return;
  }

  console.log(`Stopping gateway (PID ${pid})...`);
  process.kill(pid, 'SIGTERM');

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch {
      cleanPidFiles();
      console.log('Gateway stopped.');
      return;
    }
  }

  try { process.kill(pid, 'SIGKILL'); } catch {}
  cleanPidFiles();
  console.log('Gateway killed (forced).');
}

export async function gatewayRestart(opts: GatewaySubcommandOpts): Promise<void> {
  const existingPort = readPort();
  const pid = readPid();

  if (pid && existingPort) {
    const { readToken } = await import('./gateway/auth.js');
    await saveStateFromGateway(existingPort, readToken());
    await gatewayStop();
  }

  await gatewayStart({ ...opts, port: opts.port ?? existingPort ?? 3000 });
}

export async function gatewayStatus(opts: GatewaySubcommandOpts): Promise<void> {
  const pid = readPid();
  const port = readPort();

  if (opts.json) {
    const result: Record<string, unknown> = { running: !!pid, pid, port };
    if (pid && port) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) result.health = await res.json();
      } catch {}
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!pid) {
    console.log('Gateway: stopped');
    return;
  }

  console.log(`Gateway: running`);
  console.log(`  PID:  ${pid}`);
  console.log(`  Port: ${port ?? 'unknown'}`);

  if (port) {
    try {
      const { readToken } = await import('./gateway/auth.js');
      const token = readToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`http://localhost:${port}/api/projects`, { headers });
      if (res.ok) {
        const data = await res.json() as { projects: Array<{ name: string }> };
        const projects = data.projects ?? [];
        console.log(`  Projects: ${projects.length}`);
        for (const p of projects) {
          console.log(`    - ${p.name}`);
        }
      }
    } catch {
      console.log('  (Could not reach gateway API)');
    }
  }
}

export async function gatewayRun(opts: GatewaySubcommandOpts): Promise<void> {
  const port = opts.port ?? 3000;

  // --force: kill existing process on port
  if (opts.force) {
    if (await isPortInUse(port)) {
      await forceKillPort(port);
      for (let i = 0; i < 20; i++) {
        if (!(await isPortInUse(port))) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  ensureDir();
  writeFileSync(PID_FILE, String(process.pid));
  writeFileSync(PORT_FILE, String(port));

  const cleanup = () => { cleanPidFiles(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // Resolve auth
  let authMode: AuthMode = (opts.auth ?? 'none') as AuthMode;
  let token: string | null = null;
  if (authMode === 'token') {
    const { resolveToken } = await import('./gateway/auth.js');
    token = opts.token ?? resolveToken();
    console.error(`Auth: token (${token})`);
  }

  const bindAddress = resolveBindAddress(opts.bind);

  // Warn about non-loopback without auth
  if (bindAddress !== '127.0.0.1' && authMode === 'none') {
    console.error('⚠ WARNING: Binding to non-loopback address without auth. Use --auth token for security.');
  }

  const { startGateway } = await import('./gateway.js');
  await startGateway({
    port,
    corsOrigin: opts.corsOrigin ?? '*',
    noRecover: opts.noRecover ?? false,
    projectFilter: opts.projectFilter,
    bindAddress,
    authMode,
    authToken: token,
  });
}

export async function gatewayHealth(opts: GatewaySubcommandOpts): Promise<void> {
  const port = readPort();
  if (!port) {
    if (opts.json) { console.log(JSON.stringify({ status: 'stopped', error: 'No gateway port file found' })); }
    else { console.error('Gateway does not appear to be running (no port file).'); }
    process.exit(1);
  }

  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json();
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      console.log(`Status: ${d.status ?? 'unknown'}`);
      if (d.projects) console.log(`Projects: ${Array.isArray(d.projects) ? d.projects.join(', ') : d.projects}`);
      if (d.uptime) console.log(`Uptime: ${d.uptime}s`);
    }
  } catch {
    if (opts.json) { console.log(JSON.stringify({ status: 'unreachable', port })); }
    else { console.error(`Gateway is not responding on port ${port}.`); }
    process.exit(1);
  }
}

export async function gatewayProbe(opts: GatewaySubcommandOpts): Promise<void> {
  const pid = readPid();
  const port = readPort();
  const checks: Array<{ check: string; status: string; detail?: string }> = [];

  // 1. PID alive?
  if (pid) {
    checks.push({ check: 'PID alive', status: 'ok', detail: `PID ${pid}` });
  } else {
    checks.push({ check: 'PID alive', status: 'fail', detail: 'No running PID found' });
  }

  // 2. Port open?
  if (port) {
    const open = await isPortInUse(port);
    checks.push({ check: 'Port open', status: open ? 'ok' : 'fail', detail: `Port ${port}` });
  } else {
    checks.push({ check: 'Port open', status: 'fail', detail: 'No port file' });
  }

  // 3. /health responding?
  if (port) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        checks.push({ check: '/health', status: 'ok', detail: `HTTP ${res.status}` });
      } else {
        checks.push({ check: '/health', status: 'warn', detail: `HTTP ${res.status}` });
      }
    } catch (err) {
      checks.push({ check: '/health', status: 'fail', detail: err instanceof Error ? err.message : 'unreachable' });
    }
  } else {
    checks.push({ check: '/health', status: 'skip', detail: 'No port' });
  }

  if (opts.json) {
    console.log(JSON.stringify({ pid, port, checks }, null, 2));
  } else {
    console.log('Flightdeck Gateway Probe\n');
    for (const c of checks) {
      const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : c.status === 'skip' ? '–' : '✗';
      console.log(`  ${icon} ${c.check.padEnd(16)} ${c.detail ?? ''}`);
    }
    const allOk = checks.every(c => c.status === 'ok' || c.status === 'skip');
    console.log(`\n${allOk ? 'All checks passed.' : 'Some checks failed.'}`);
  }
}

export async function gatewayUsageCost(opts: GatewaySubcommandOpts): Promise<void> {
  // TODO: Implement cost tracking once we have reliable cost data per project/agent
  if (opts.json) {
    console.log(JSON.stringify({ error: 'Cost tracking not yet available' }));
  } else {
    console.log('Cost tracking not yet available.');
    console.log('This will show per-project and per-agent cost summaries once cost data collection is implemented.');
  }
}

/**
 * Auto-detect gateway port from ~/.flightdeck/gateway.port.
 */
export function autoDetectPort(explicitPort: string | undefined): string {
  if (explicitPort) return explicitPort;
  const port = readPort();
  return port ? String(port) : '3000';
}

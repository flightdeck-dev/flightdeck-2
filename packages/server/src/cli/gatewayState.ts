import * as fs from 'node:fs';
import * as path from 'node:path';
import { FD_HOME } from './constants.js';

export interface SavedSession {
  project: string;
  agentId: string;
  role: string;
  acpSessionId: string;
  localSessionId: string;
  cwd: string;
  model?: string;
  status?: 'suspended' | 'active';
}

export interface GatewayState {
  savedAt: string;
  sessions: SavedSession[];
  /** Set to true when a reload attempt failed (OOM, crash, etc.) */
  lastReloadFailed?: boolean;
  /** PIDs of child agent processes spawned by this gateway instance. */
  agentPids?: number[];
  /** PID of the gateway process that saved this state. */
  gatewayPid?: number;
}

const STATE_DIR = FD_HOME;
const STATE_FILE = path.join(STATE_DIR, 'gateway-state.json');
const RELOAD_CONFIG_FILE = path.join(STATE_DIR, 'reload-config.json');

/**
 * Save active gateway sessions to disk (synchronous for use in signal handlers).
 */
export function saveGatewayState(state: GatewayState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.error(`Saved ${state.sessions.length} session(s) to ${STATE_FILE}`);
  } catch (err) {
    console.error('Failed to save gateway state:', err);
  }
}

/**
 * Load saved gateway state from disk. Returns null if no state file exists.
 */
export function loadGatewayState(): GatewayState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as GatewayState;
  } catch {
    return null;
  }
}

/**
 * Delete the gateway state file after processing.
 */
export function clearGatewayState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // file doesn't exist, that's fine
  }
}

/**
 * Reload configuration. Controls whether gateway should reload sessions on restart.
 * File: ~/.flightdeck/reload-config.json
 */
export interface ReloadConfig {
  /** Master switch: if false, skip ALL session reloads on restart. Default: true */
  enabled?: boolean;
  /** Which roles to reload. Default: ['lead'] (never reload workers) */
  roles?: string[];
}

const DEFAULT_RELOAD_CONFIG: ReloadConfig = {
  enabled: true,
  roles: ['lead'],
};

/**
 * Load reload configuration from disk. Returns defaults if file doesn't exist.
 */
export function loadReloadConfig(): ReloadConfig {
  try {
    const raw = fs.readFileSync(RELOAD_CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_RELOAD_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_RELOAD_CONFIG;
  }
}

/**
 * Mark that a reload attempt failed. Next startup will see this and skip reload.
 */
export function markReloadFailed(): void {
  try {
    const state = loadGatewayState();
    if (state) {
      state.lastReloadFailed = true;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
      console.error('Marked reload as failed in gateway state.');
    }
  } catch (err) {
    console.error('Failed to mark reload failure:', err);
  }
}

/**
 * Clear the reload-failed flag (called after a successful reload).
 */
export function clearReloadFailed(): void {
  try {
    const state = loadGatewayState();
    if (state && state.lastReloadFailed) {
      state.lastReloadFailed = false;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    }
  } catch {
    // ignore
  }
}

// ── Agent PID tracking ──

const AGENT_PIDS_FILE = path.join(STATE_DIR, 'agent-pids.json');

/**
 * Save the set of agent child PIDs to disk. Called periodically alongside
 * gateway-state.json so that on unclean shutdown we can find orphans.
 */
export function saveAgentPids(gatewayPid: number, pids: number[]): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(AGENT_PIDS_FILE, JSON.stringify({ gatewayPid, pids, savedAt: new Date().toISOString() }), 'utf-8');
  } catch {
    // best effort
  }
}

/**
 * Load previously saved agent PIDs. Returns null if missing.
 */
export function loadAgentPids(): { gatewayPid: number; pids: number[] } | null {
  try {
    const raw = fs.readFileSync(AGENT_PIDS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.gatewayPid === 'number' && Array.isArray(data.pids)) {
      return { gatewayPid: data.gatewayPid, pids: data.pids };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the agent PIDs file (called after successful cleanup).
 */
export function clearAgentPids(): void {
  try { fs.unlinkSync(AGENT_PIDS_FILE); } catch {}
}

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill orphaned agent processes from a previous gateway run.
 * Only kills if the original gateway PID is no longer alive (unclean shutdown).
 * Returns the number of processes killed.
 */
export async function cleanupOrphanedAgents(): Promise<number> {
  const saved = loadAgentPids();
  if (!saved || saved.pids.length === 0) return 0;

  // If the gateway that spawned these is still alive, don't touch them
  if (isProcessAlive(saved.gatewayPid)) {
    return 0;
  }

  console.error(`Previous gateway (PID ${saved.gatewayPid}) is dead. Checking ${saved.pids.length} agent PID(s) for orphans...`);
  let killed = 0;

  for (const pid of saved.pids) {
    if (isProcessAlive(pid)) {
      console.error(`  Killing orphaned agent process PID ${pid}`);
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
      } catch {
        // already dead or permission denied
      }
    }
  }

  // Give SIGTERM a moment, then SIGKILL any survivors
  if (killed > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    for (const pid of saved.pids) {
      if (isProcessAlive(pid)) {
        console.error(`  Force-killing PID ${pid}`);
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }

  clearAgentPids();
  if (killed > 0) {
    console.error(`Cleaned up ${killed} orphaned agent process(es).`);
  } else {
    console.error('No orphaned agent processes found.');
  }
  return killed;
}

export { STATE_FILE, RELOAD_CONFIG_FILE, AGENT_PIDS_FILE };

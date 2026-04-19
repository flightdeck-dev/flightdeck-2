import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicSync } from '../infra/json-files.js';
import { FD_HOME } from './constants.js';

const STATE_DIR = FD_HOME;



// ── Agent PID tracking ──

const AGENT_PIDS_FILE = path.join(STATE_DIR, 'agent-pids.json');

/**
 * Save the set of agent child PIDs to disk. Called periodically alongside
 * gateway-state.json so that on unclean shutdown we can find orphans.
 */
export function saveAgentPids(gatewayPid: number, pids: number[]): void {
  try {
    writeJsonAtomicSync(AGENT_PIDS_FILE, { gatewayPid, pids, savedAt: new Date().toISOString() });
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

export { AGENT_PIDS_FILE };

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
}

const STATE_DIR = path.join(os.homedir(), '.flightdeck');
const STATE_FILE = path.join(STATE_DIR, 'gateway-state.json');

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

export { STATE_FILE };

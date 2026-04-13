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
  /** Set to true when a reload attempt failed (OOM, crash, etc.) */
  lastReloadFailed?: boolean;
}

const STATE_DIR = path.join(os.homedir(), '.flightdeck');
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

export { STATE_FILE, RELOAD_CONFIG_FILE };

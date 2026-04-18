import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  loadReloadConfig,
  saveAgentPids,
  loadAgentPids,
  clearAgentPids,
  cleanupOrphanedAgents,
  RELOAD_CONFIG_FILE,
  AGENT_PIDS_FILE,
} from '../../src/cli/gatewayState.js';

describe('gatewayState', () => {
  afterEach(() => {
    clearAgentPids();
    try { fs.unlinkSync(RELOAD_CONFIG_FILE); } catch { /* ignore */ }
  });

  // --- Reload config tests ---

  it('should return default reload config when file missing', () => {
    const config = loadReloadConfig();
    expect(config.enabled).toBe(true);
    expect(config.roles).toEqual(['lead']);
  });

  it('should load custom reload config', () => {
    fs.writeFileSync(RELOAD_CONFIG_FILE, JSON.stringify({ enabled: false, roles: [] }), 'utf-8');
    const config = loadReloadConfig();
    expect(config.enabled).toBe(false);
    expect(config.roles).toEqual([]);
  });

  it('should merge partial reload config with defaults', () => {
    fs.writeFileSync(RELOAD_CONFIG_FILE, JSON.stringify({ roles: ['lead', 'planner'] }), 'utf-8');
    const config = loadReloadConfig();
    expect(config.enabled).toBe(true); // default
    expect(config.roles).toEqual(['lead', 'planner']);
  });

  // --- Agent PID tracking tests ---

  it('should save and load agent PIDs', () => {
    saveAgentPids(12345, [100, 200, 300]);
    const loaded = loadAgentPids();
    expect(loaded).not.toBeNull();
    expect(loaded!.gatewayPid).toBe(12345);
    expect(loaded!.pids).toEqual([100, 200, 300]);
  });

  it('should return null when no PID file exists', () => {
    clearAgentPids();
    expect(loadAgentPids()).toBeNull();
  });

  it('should clear agent PIDs file', () => {
    saveAgentPids(12345, [100]);
    expect(fs.existsSync(AGENT_PIDS_FILE)).toBe(true);
    clearAgentPids();
    expect(fs.existsSync(AGENT_PIDS_FILE)).toBe(false);
  });

  it('should not kill agents if gateway is still alive', async () => {
    saveAgentPids(process.pid, [999999]);
    const killed = await cleanupOrphanedAgents();
    expect(killed).toBe(0);
  });

  it('should detect dead gateway and clean up orphans', async () => {
    saveAgentPids(2147483647, [2147483646]);
    const killed = await cleanupOrphanedAgents();
    expect(killed).toBe(0);
    expect(loadAgentPids()).toBeNull();
  });
});

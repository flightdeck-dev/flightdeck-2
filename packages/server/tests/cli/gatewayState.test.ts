import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
  saveAgentPids,
  loadAgentPids,
  clearAgentPids,
  cleanupOrphanedAgents,
  AGENT_PIDS_FILE,
} from '../../src/cli/gatewayState.js';

describe('gatewayState', () => {
  afterEach(() => {
    clearAgentPids();
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
    expect(existsSync(AGENT_PIDS_FILE)).toBe(true);
    clearAgentPids();
    expect(existsSync(AGENT_PIDS_FILE)).toBe(false);
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

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  saveGatewayState,
  loadGatewayState,
  clearGatewayState,
  loadReloadConfig,
  markReloadFailed,
  clearReloadFailed,
  STATE_FILE,
  RELOAD_CONFIG_FILE,
  type GatewayState,
  type SavedSession,
} from '../../src/cli/gatewayState.js';

describe('gatewayState', () => {
  afterEach(() => {
    clearGatewayState();
    try { fs.unlinkSync(RELOAD_CONFIG_FILE); } catch { /* ignore */ }
  });

  it('should save and load state round-trip', () => {
    const state: GatewayState = {
      savedAt: '2026-04-13T03:00:00.000Z',
      sessions: [
        {
          project: 'demo',
          agentId: 'lead-123',
          role: 'lead',
          acpSessionId: 'acp-abc',
          localSessionId: 'acp-local-1',
          cwd: '/tmp/test',
          model: 'claude-sonnet',
        },
        {
          project: 'demo',
          agentId: 'planner-456',
          role: 'planner',
          acpSessionId: 'acp-def',
          localSessionId: 'acp-local-2',
          cwd: '/tmp/test',
        },
      ],
    };

    saveGatewayState(state);

    // File should exist
    expect(fs.existsSync(STATE_FILE)).toBe(true);

    // Load should return the same data
    const loaded = loadGatewayState();
    expect(loaded).not.toBeNull();
    expect(loaded!.savedAt).toBe(state.savedAt);
    expect(loaded!.sessions).toHaveLength(2);
    expect(loaded!.sessions[0].acpSessionId).toBe('acp-abc');
    expect(loaded!.sessions[0].role).toBe('lead');
    expect(loaded!.sessions[1].acpSessionId).toBe('acp-def');
    expect(loaded!.sessions[1].role).toBe('planner');
    expect(loaded!.sessions[0].model).toBe('claude-sonnet');
    expect(loaded!.sessions[1].model).toBeUndefined();
  });

  it('should return null when no state file exists', () => {
    clearGatewayState();
    const loaded = loadGatewayState();
    expect(loaded).toBeNull();
  });

  it('should clear the state file', () => {
    saveGatewayState({ savedAt: new Date().toISOString(), sessions: [] });
    expect(fs.existsSync(STATE_FILE)).toBe(true);

    clearGatewayState();
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  it('should handle empty sessions array', () => {
    const state: GatewayState = {
      savedAt: new Date().toISOString(),
      sessions: [],
    };
    saveGatewayState(state);
    const loaded = loadGatewayState();
    expect(loaded).not.toBeNull();
    expect(loaded!.sessions).toHaveLength(0);
  });

  it('should save and load sessions with suspended status', () => {
    const state: GatewayState = {
      savedAt: new Date().toISOString(),
      sessions: [
        {
          project: 'demo',
          agentId: 'lead-123',
          role: 'lead',
          acpSessionId: 'acp-abc',
          localSessionId: 'acp-local-1',
          cwd: '/tmp/test',
          status: 'active',
        },
        {
          project: 'demo',
          agentId: 'planner-456',
          role: 'planner',
          acpSessionId: 'acp-def',
          localSessionId: 'acp-local-2',
          cwd: '/tmp/test',
          status: 'suspended',
        },
      ],
    };
    saveGatewayState(state);
    const loaded = loadGatewayState();
    expect(loaded).not.toBeNull();
    expect(loaded!.sessions[0].status).toBe('active');
    expect(loaded!.sessions[1].status).toBe('suspended');
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

  // --- Reload failure tracking tests ---

  it('should mark and detect reload failure', () => {
    saveGatewayState({ savedAt: new Date().toISOString(), sessions: [] });
    markReloadFailed();
    const loaded = loadGatewayState();
    expect(loaded).not.toBeNull();
    expect(loaded!.lastReloadFailed).toBe(true);
  });

  it('should clear reload failure flag', () => {
    saveGatewayState({ savedAt: new Date().toISOString(), sessions: [], lastReloadFailed: true });
    clearReloadFailed();
    const loaded = loadGatewayState();
    expect(loaded).not.toBeNull();
    expect(loaded!.lastReloadFailed).toBe(false);
  });

  it('should not mark failure when no state file exists', () => {
    clearGatewayState();
    markReloadFailed(); // should not throw
    expect(loadGatewayState()).toBeNull();
  });
});

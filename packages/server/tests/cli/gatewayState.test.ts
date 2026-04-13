import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  saveGatewayState,
  loadGatewayState,
  clearGatewayState,
  STATE_FILE,
  type GatewayState,
  type SavedSession,
} from '../../src/cli/gatewayState.js';

describe('gatewayState', () => {
  afterEach(() => {
    clearGatewayState();
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
});

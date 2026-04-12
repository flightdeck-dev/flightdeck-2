import { describe, it, expect } from 'vitest';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import type { ProjectConfig } from '@flightdeck-ai/shared';

describe('Governance shouldGateTaskStart', () => {
  it('autonomous mode never gates', () => {
    const gov = new GovernanceEngine({ name: 'test', governance: 'autonomous', isolation: 'none', onCompletion: 'stop' });
    expect(gov.shouldGateTaskStart('ready', 'worker')).toBe(false);
    expect(gov.shouldGateTaskStart('ready', 'reviewer')).toBe(false);
  });

  it('collaborative mode always gates', () => {
    const gov = new GovernanceEngine({ name: 'test', governance: 'collaborative', isolation: 'none', onCompletion: 'stop' });
    expect(gov.shouldGateTaskStart('ready', 'worker')).toBe(true);
    expect(gov.shouldGateTaskStart('ready', 'reviewer')).toBe(true);
  });

  it('supervised mode gates workers but not reviewers', () => {
    const gov = new GovernanceEngine({ name: 'test', governance: 'supervised', isolation: 'none', onCompletion: 'stop' });
    expect(gov.shouldGateTaskStart('ready', 'worker')).toBe(true);
    expect(gov.shouldGateTaskStart('ready', 'reviewer')).toBe(false);
  });
});

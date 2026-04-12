import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ModelConfig, PRESET_NAMES } from '../../src/agents/ModelConfig.js';

describe('ModelConfig', () => {
  let dir: string;
  let mc: ModelConfig;

  beforeEach(() => {
    dir = join(tmpdir(), `fd-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(dir, '.flightdeck'), { recursive: true });
    writeFileSync(join(dir, '.flightdeck', 'config.yaml'), `
agents:
  default_runtime: copilot
  default_model: high
  roles:
    lead:
      runtime: copilot
      model: medium
    worker:
      runtime: copilot
      model: high
`);
    mc = new ModelConfig(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads agents config', () => {
    const cfg = mc.getAgentsConfig();
    expect(cfg.default_runtime).toBe('copilot');
    expect(cfg.default_model).toBe('high');
    expect(cfg.roles?.lead?.model).toBe('medium');
    expect(cfg.roles?.worker?.model).toBe('high');
  });

  it('getRoleConfigs returns all 7 built-in roles + custom', () => {
    const configs = mc.getRoleConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(7);
    const roles = configs.map(c => c.role);
    expect(roles).toContain('lead');
    expect(roles).toContain('worker');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('product-thinker');
    expect(roles).toContain('qa-tester');
    expect(roles).toContain('tech-writer');
  });

  it('uses defaults for unconfigured roles', () => {
    const reviewer = mc.getRoleConfigs().find(c => c.role === 'reviewer')!;
    expect(reviewer.runtime).toBe('copilot'); // from default_runtime
    expect(reviewer.model).toBe('high');      // from default_model
  });

  it('getRoleConfig for single role', () => {
    const lead = mc.getRoleConfig('lead');
    expect(lead.runtime).toBe('copilot');
    expect(lead.model).toBe('medium');
  });

  it('setRole with runtime:model format', () => {
    mc.setRole('reviewer', 'claude-code:high');
    const cfg = mc.getRoleConfig('reviewer');
    expect(cfg.runtime).toBe('claude-code');
    expect(cfg.model).toBe('high');
  });

  it('setRole with model only', () => {
    mc.setRole('lead', 'fast');
    const cfg = mc.getRoleConfig('lead');
    expect(cfg.runtime).toBe('copilot'); // unchanged
    expect(cfg.model).toBe('fast');
  });

  it('setRole works for custom roles', () => {
    mc.setRole('my-custom-role', 'claude-code:claude-opus-4-6');
    const cfg = mc.getRoleConfig('my-custom-role');
    expect(cfg.runtime).toBe('claude-code');
    expect(cfg.model).toBe('claude-opus-4-6');

    // Custom role should appear in getRoleConfigs
    const all = mc.getRoleConfigs();
    expect(all.map(c => c.role)).toContain('my-custom-role');
  });

  it('setDefault updates default_runtime and default_model', () => {
    mc.setDefault('gemini:medium');
    const cfg = mc.getAgentsConfig();
    expect(cfg.default_runtime).toBe('gemini');
    expect(cfg.default_model).toBe('medium');
  });

  it('setDefault with runtime only', () => {
    mc.setDefault('claude-code');
    const cfg = mc.getAgentsConfig();
    expect(cfg.default_runtime).toBe('claude-code');
  });

  describe('presets', () => {
    it('has expected preset names', () => {
      expect(PRESET_NAMES).toContain('budget');
      expect(PRESET_NAMES).toContain('balanced');
      expect(PRESET_NAMES).toContain('performance');
    });

    it('budget preset sets all to fast', () => {
      mc.applyPreset('budget');
      const configs = mc.getRoleConfigs();
      for (const c of configs) {
        expect(c.model).toBe('fast');
      }
    });

    it('balanced preset: worker/reviewer/qa-tester=high, rest=medium', () => {
      mc.applyPreset('balanced');
      const configs = mc.getRoleConfigs();
      const byRole = Object.fromEntries(configs.map(c => [c.role, c]));
      expect(byRole.worker.model).toBe('high');
      expect(byRole.reviewer.model).toBe('high');
      expect(byRole['qa-tester'].model).toBe('high');
      expect(byRole.lead.model).toBe('medium');
      expect(byRole.planner.model).toBe('medium');
      expect(byRole['product-thinker'].model).toBe('medium');
      expect(byRole['tech-writer'].model).toBe('medium');
    });

    it('performance preset sets all to high', () => {
      mc.applyPreset('performance');
      const configs = mc.getRoleConfigs();
      for (const c of configs) {
        expect(c.model).toBe('high');
      }
    });

    it('returns false for unknown preset', () => {
      expect(mc.applyPreset('nonexistent')).toBe(false);
    });

    it('applies preset to custom roles too', () => {
      mc.setRole('my-role', 'copilot:medium');
      mc.applyPreset('budget');
      const cfg = mc.getRoleConfig('my-role');
      expect(cfg.model).toBe('fast');
    });
  });

  it('persists changes to disk', () => {
    mc.setRole('lead', 'claude-code:high');
    // Create a new instance to verify persistence
    const mc2 = new ModelConfig(dir);
    const cfg = mc2.getRoleConfig('lead');
    expect(cfg.runtime).toBe('claude-code');
    expect(cfg.model).toBe('high');
  });

  it('handles missing config file gracefully', () => {
    const emptyDir = join(tmpdir(), `fd-empty-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(emptyDir, '.flightdeck'), { recursive: true });
    const mc2 = new ModelConfig(emptyDir);
    const configs = mc2.getRoleConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(7);
    // Should use defaults
    expect(configs[0].runtime).toBe('copilot');
    expect(configs[0].model).toBe('high');
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

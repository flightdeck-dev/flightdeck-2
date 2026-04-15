import { readFileSync, existsSync } from 'node:fs';
import { writeTextAtomicSync } from '../infra/json-files.js';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentsConfig } from '@flightdeck-ai/shared';
import { AGENT_ROLES } from '@flightdeck-ai/shared';

export interface ResolvedRoleConfig {
  role: string;
  runtime: string;
  model: string;       // raw value from config (tier or model ID)
  resolvedModel?: string; // after tier resolution
  tier?: string;
}

const BALANCED_HIGH_ROLES = new Set(['worker', 'reviewer', 'qa-tester']);

const PRESETS: Record<string, (role: string) => string> = {
  budget: () => 'fast',
  balanced: (role) => BALANCED_HIGH_ROLES.has(role) ? 'high' : 'medium',
  performance: () => 'high',
};

export const PRESET_NAMES = Object.keys(PRESETS);

/**
 * Read/write the agents section of .flightdeck/config.yaml.
 */
export class ModelConfig {
  private configPath: string;

  constructor(projectDir: string) {
    this.configPath = join(projectDir, '.flightdeck', 'config.yaml');
  }

  private readFull(): Record<string, unknown> {
    if (!existsSync(this.configPath)) return {};
    const raw = readFileSync(this.configPath, 'utf-8');
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  }

  private writeFull(config: Record<string, unknown>): void {
    writeTextAtomicSync(this.configPath, stringifyYaml(config, { lineWidth: 120 }));
  }

  getAgentsConfig(): AgentsConfig {
    const full = this.readFull();
    return (full.agents as AgentsConfig) ?? {};
  }

  setAgentsConfig(agents: AgentsConfig): void {
    const full = this.readFull();
    full.agents = agents;
    this.writeFull(full);
  }

  /**
   * Get resolved config for all configured roles (built-in + custom).
   */
  getRoleConfigs(): ResolvedRoleConfig[] {
    const agents = this.getAgentsConfig();
    const defaultRuntime = agents.default_runtime ?? 'copilot';
    const defaultModel = agents.default_model ?? 'high';

    // Collect all roles: built-in + any custom ones in config
    const allRoles = new Set<string>([...AGENT_ROLES]);
    if (agents.roles) {
      for (const role of Object.keys(agents.roles)) {
        allRoles.add(role);
      }
    }

    return [...allRoles].map(role => {
      const rc = agents.roles?.[role] ?? {};
      return {
        role,
        runtime: rc.runtime ?? defaultRuntime,
        model: rc.model ?? defaultModel,
      };
    });
  }

  /**
   * Get config for a single role.
   */
  getRoleConfig(role: string): ResolvedRoleConfig {
    const agents = this.getAgentsConfig();
    const rc = agents.roles?.[role] ?? {};
    return {
      role,
      runtime: rc.runtime ?? agents.default_runtime ?? 'copilot',
      model: rc.model ?? agents.default_model ?? 'high',
    };
  }

  /**
   * Set runtime:model for a role. Format: "runtime:model" or just "model".
   * Works for any role name (built-in or custom).
   */
  setRole(role: string, spec: string): void {
    const agents = this.getAgentsConfig();
    if (!agents.roles) agents.roles = {};

    const colonIdx = spec.indexOf(':');
    let runtime: string | undefined;
    let model: string;

    if (colonIdx >= 0) {
      runtime = spec.slice(0, colonIdx);
      model = spec.slice(colonIdx + 1);
    } else {
      model = spec;
    }

    const existing = agents.roles[role] ?? {};
    if (runtime) existing.runtime = runtime;
    existing.model = model;
    agents.roles[role] = existing;
    this.setAgentsConfig(agents);
  }

  /**
   * Set default runtime:model for all roles.
   */
  setDefault(spec: string): void {
    const agents = this.getAgentsConfig();
    const colonIdx = spec.indexOf(':');

    if (colonIdx >= 0) {
      agents.default_runtime = spec.slice(0, colonIdx);
      agents.default_model = spec.slice(colonIdx + 1);
    } else {
      agents.default_runtime = spec;
    }
    this.setAgentsConfig(agents);
  }

  /**
   * Apply a preset (budget/balanced/performance).
   */
  applyPreset(preset: string): boolean {
    const fn = PRESETS[preset];
    if (!fn) return false;

    const agents = this.getAgentsConfig();
    if (!agents.roles) agents.roles = {};

    // Apply to all built-in roles + any custom roles already in config
    const allRoles = new Set<string>([...AGENT_ROLES]);
    for (const role of Object.keys(agents.roles)) {
      allRoles.add(role);
    }

    for (const role of allRoles) {
      const existing = agents.roles[role] ?? {};
      existing.model = fn(role);
      agents.roles[role] = existing;
    }
    this.setAgentsConfig(agents);
    return true;
  }
}

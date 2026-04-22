import { readFileSync, existsSync } from 'node:fs';
import { writeTextAtomicSync } from '../infra/json-files.js';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentsConfig, EnabledModel } from '@flightdeck-ai/shared';
import { AGENT_ROLES } from '@flightdeck-ai/shared';

export interface ResolvedRoleConfig {
  role: string;
  runtime: string;
  model: string;       // concrete model ID
  enabledModels?: EnabledModel[];
}

const PRESETS: Record<string, (role: string) => string> = {
  budget: () => '',
  balanced: () => '',
  performance: () => '',
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
    const defaultModel = agents.default_model ?? '';

    // Collect all roles: built-in + any custom ones in config
    const allRoles = new Set<string>([...AGENT_ROLES]);
    if (agents.roles) {
      for (const role of Object.keys(agents.roles)) {
        allRoles.add(role);
      }
    }

    return [...allRoles].map(role => {
      const rc = agents.roles?.[role] ?? {};
      const enabledModels = this.getRoleEnabledModelsWithDiscovery(role);
      return {
        role,
        runtime: rc.runtime ?? defaultRuntime,
        model: rc.model ?? defaultModel,
        enabledModels,
      };
    });
  }

  /**
   * Get config for a single role.
   */
  getRoleConfig(role: string): ResolvedRoleConfig {
    const agents = this.getAgentsConfig();
    const rc = agents.roles?.[role] ?? {};
    const enabledModels = this.getRoleEnabledModelsWithDiscovery(role);
    return {
      role,
      runtime: rc.runtime ?? agents.default_runtime ?? 'copilot',
      model: rc.model ?? agents.default_model ?? '',
      enabledModels,
    };
  }

  /**
   * Get enabled models for a role. If enabledModels is not set,
   * falls back to a single-item array from legacy runtime+model fields.
   */
  getRoleEnabledModels(role: string): EnabledModel[] {
    const agents = this.getAgentsConfig();
    const rc = agents.roles?.[role];
    if (rc?.enabledModels && rc.enabledModels.length > 0) {
      return rc.enabledModels;
    }
    // Backward compat: synthesize from legacy fields.
    // Don't set a default runtime here — let the adapter decide.
    const runtime = rc?.runtime ?? agents.default_runtime;
    const model = rc?.model ?? agents.default_model;
    if (!runtime && !model) return []; // No config → let adapter use its default
    return [{ runtime: runtime ?? 'copilot', model: model ?? '', enabled: true, isDefault: true }];
  }

  /**
   * Get enabled models for a role, with auto-population from discovered models
   * when no explicit configuration exists.
   */
  getRoleEnabledModelsWithDiscovery(role: string): EnabledModel[] {
    let result = this.getRoleEnabledModels(role);
    if (result.length === 0) {
      // Auto-populate from discovered models in the registry
      try {
        const { modelRegistry } = require('./ModelRegistry.js') as { modelRegistry: { getRuntimes(): string[]; getModels(rt: string): Array<{ modelId: string }> } };
        const autoModels: EnabledModel[] = [];
        for (const rt of modelRegistry.getRuntimes()) {
          const models = modelRegistry.getModels(rt);
          for (const m of models) {
            autoModels.push({ runtime: rt, model: m.modelId, enabled: true, isDefault: autoModels.length === 0 });
          }
        }
        result = autoModels;
      } catch { /* best effort */ }
    }
    // Filter out disabled runtimes
    try {
      const { loadGlobalConfig } = require('../config/GlobalConfig.js') as { loadGlobalConfig(): { disabledRuntimes?: string[] } };
      const disabled = new Set(loadGlobalConfig().disabledRuntimes ?? []);
      if (disabled.size > 0) {
        result = result.filter(m => !disabled.has(m.runtime));
      }
    } catch { /* best effort */ }
    return result;
  }

  /**
   * Set the full enabledModels array for a role.
   */
  setRoleEnabledModels(role: string, models: EnabledModel[]): void {
    const agents = this.getAgentsConfig();
    if (!agents.roles) agents.roles = {};
    const existing = agents.roles[role] ?? {};
    existing.enabledModels = models;
    // Keep legacy fields in sync with the default model
    const defaultModel = models.find(m => m.isDefault && m.enabled) ?? models.find(m => m.enabled);
    if (defaultModel) {
      existing.runtime = defaultModel.runtime;
      existing.model = defaultModel.model;
    }
    agents.roles[role] = existing;
    this.setAgentsConfig(agents);
  }

  /**
   * Toggle a specific model's enabled state for a role.
   */
  toggleModel(role: string, runtime: string, model: string, enabled: boolean): void {
    const models = this.getRoleEnabledModels(role);
    const idx = models.findIndex(m => m.runtime === runtime && m.model === model);
    if (idx >= 0) {
      models[idx].enabled = enabled;
    } else {
      models.push({ runtime, model, enabled });
    }
    this.setRoleEnabledModels(role, models);
  }

  /**
   * Set a model as the default for a role.
   */
  setDefaultModel(role: string, runtime: string, model: string): void {
    const models = this.getRoleEnabledModels(role);
    for (const m of models) {
      m.isDefault = (m.runtime === runtime && m.model === model);
    }
    // Ensure the model exists and is enabled
    const idx = models.findIndex(m => m.runtime === runtime && m.model === model);
    if (idx < 0) {
      models.push({ runtime, model, enabled: true, isDefault: true });
    } else {
      models[idx].enabled = true;
    }
    this.setRoleEnabledModels(role, models);
  }

  /**
   * Set runtime:model for a role. Format: "runtime:model" or just "model".
   * Works for any role name (built-in or custom).
   * Also updates enabledModels if present.
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
    // Also update enabledModels: set as default
    if (runtime && existing.enabledModels) {
      for (const m of existing.enabledModels) m.isDefault = false;
      const idx = existing.enabledModels.findIndex(m => m.runtime === runtime && m.model === model);
      if (idx >= 0) {
        existing.enabledModels[idx].enabled = true;
        existing.enabledModels[idx].isDefault = true;
      } else {
        existing.enabledModels.push({ runtime, model, enabled: true, isDefault: true });
      }
    }
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

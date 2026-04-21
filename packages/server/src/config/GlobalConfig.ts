import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const CONFIG_DIR = join(homedir(), '.flightdeck', 'v2');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

export interface CustomRuntimeConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  icon?: string;
  supportsSessionLoad?: boolean;
}

export interface GlobalConfig {
  customRuntimes?: Record<string, CustomRuntimeConfig>;
  defaultRuntime?: string;
  runtimeOrder?: string[];
  disabledRuntimes?: string[];
  timezone?: string;
  display?: {
    thinking?: boolean;
    toolCalls?: string;
    flightdeckTools?: string;
    agentStreaming?: boolean;
  };
  auth?: { mode: 'none' | 'token'; token?: string };
  bind?: string;
  port?: number;
}

export function loadGlobalConfig(): GlobalConfig {
  let config: GlobalConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      config = (parseYaml(raw) as GlobalConfig) ?? {};
    } catch { /* best effort */ }
  }

  // One-time migration from global-config.json
  const oldJsonPath = join(CONFIG_DIR, 'global-config.json');
  if (existsSync(oldJsonPath)) {
    try {
      const oldConfig = JSON.parse(readFileSync(oldJsonPath, 'utf-8'));
      config = { ...config, ...oldConfig };
      saveGlobalConfig(config);
      unlinkSync(oldJsonPath);
      console.error('[GlobalConfig] Migrated global-config.json → config.yaml');
    } catch { /* best effort */ }
  }

  return config;
}

export function saveGlobalConfig(config: GlobalConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, stringifyYaml(config));
}

export function getGlobalConfigPath(): string {
  return CONFIG_PATH;
}

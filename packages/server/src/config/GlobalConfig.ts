import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  auth?: { mode: 'none' | 'token'; token?: string };
  bind?: string;
  port?: number;
}

export function loadGlobalConfig(): GlobalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return (parseYaml(raw) as GlobalConfig) ?? {};
  } catch {
    return {};
  }
}

export function saveGlobalConfig(config: GlobalConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, stringifyYaml(config));
}

export function getGlobalConfigPath(): string {
  return CONFIG_PATH;
}

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProjectConfig, FlightdeckJson, AgentRole } from '@flightdeck-ai/shared';
import { generateAgentConfigs, type AgentConfigOutput } from '../agents/AgentConfigs.js';

const FLIGHTDECK_HOME = join(homedir(), '.flightdeck');
const SUBDIRS = ['specs', 'decisions', 'memory', 'agents', 'messages', 'reports'];

export class ProjectStore {
  private projectDir: string;

  constructor(projectName: string) {
    this.projectDir = join(FLIGHTDECK_HOME, 'projects', projectName);
  }

  get path(): string {
    return this.projectDir;
  }

  init(projectName: string): void {
    mkdirSync(this.projectDir, { recursive: true });
    for (const sub of SUBDIRS) {
      mkdirSync(join(this.projectDir, sub), { recursive: true });
    }
    // Write default config
    const defaultConfig: ProjectConfig = {
      name: projectName,
      governance: 'autonomous',
      isolation: 'none',
      onCompletion: 'ask',
    };
    this.setConfig(defaultConfig);
  }

  getConfig(): ProjectConfig {
    const configPath = join(this.projectDir, 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ProjectConfig;
  }

  setConfig(config: ProjectConfig): void {
    const configPath = join(this.projectDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  static resolve(cwd: string): string | null {
    let dir = resolve(cwd);
    while (true) {
      const candidate = join(dir, '.flightdeck.json');
      if (existsSync(candidate)) {
        try {
          const raw = readFileSync(candidate, 'utf-8');
          const parsed = JSON.parse(raw) as FlightdeckJson;
          return parsed.project;
        } catch {
          return null;
        }
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  static writeFlightdeckJson(dir: string, projectName: string): void {
    const data: FlightdeckJson = { project: projectName };
    writeFileSync(join(dir, '.flightdeck.json'), JSON.stringify(data, null, 2));
  }

  ensureDirs(): void {
    mkdirSync(this.projectDir, { recursive: true });
    for (const sub of SUBDIRS) {
      mkdirSync(join(this.projectDir, sub), { recursive: true });
    }
  }

  subpath(...parts: string[]): string {
    return join(this.projectDir, ...parts);
  }

  exists(): boolean {
    return existsSync(this.projectDir);
  }

  generateAgentConfigs(role: AgentRole): AgentConfigOutput {
    return generateAgentConfigs(role);
  }

  /**
   * Write AGENTS.md and .mcp.json to a target directory (typically the working directory).
   */
  static writeAgentFiles(dir: string, role: AgentRole): AgentConfigOutput {
    const configs = generateAgentConfigs(role);
    writeFileSync(join(dir, 'AGENTS.md'), configs.agentsMd);
    writeFileSync(join(dir, '.mcp.json'), configs.mcpJson);
    return configs;
  }
}

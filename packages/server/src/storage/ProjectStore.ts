import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProjectConfig, FlightdeckJson, AgentRole } from '@flightdeck-ai/shared';
import { generateAgentConfigs, type AgentConfigOutput } from '../agents/AgentConfigs.js';

const FLIGHTDECK_HOME = join(homedir(), '.flightdeck');
const SUBDIRS = ['specs', 'decisions', 'memory', 'agents', 'messages', 'reports'];

const HEARTBEAT_TEMPLATE = `# Heartbeat Instructions

## Periodic Checks
- Review any pending decisions and handle them
- Check if any specs are blocked and need re-planning
- Compress memory/decisions.md if it's getting long

## Memory Maintenance
- Update memory/PROJECT.md if architecture changed
- Write retrospective for any newly completed specs
- Clean stale info from memory/learnings.md

## Explore Directions (when on_completion=explore)
- Focus on test coverage gaps
- Look for performance bottlenecks
- Check for missing error handling

## User Notes
- (Add your own instructions here)
`;

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
    // Create memory subdirectories
    mkdirSync(join(this.projectDir, 'memory', 'retrospectives'), { recursive: true });

    // Write default config
    const defaultConfig: ProjectConfig = {
      name: projectName,
      governance: 'autonomous',
      isolation: 'none',
      onCompletion: 'ask',
    };
    this.setConfig(defaultConfig);

    // Write default HEARTBEAT.md
    const heartbeatPath = join(this.projectDir, 'HEARTBEAT.md');
    if (!existsSync(heartbeatPath)) {
      writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE);
    }

    // Write empty memory files
    const memoryFiles: Record<string, string> = {
      'memory/PROJECT.md': '# Project Overview\n\n_Describe the project architecture, key decisions, and conventions here._\n',
      'memory/decisions.md': '# Decision Summary\n\n_Lead will maintain a compressed summary of recent decisions here._\n',
      'memory/learnings.md': '# Learnings\n\n_Patterns, gotchas, and lessons learned across the project._\n',
    };
    for (const [rel, content] of Object.entries(memoryFiles)) {
      const p = join(this.projectDir, rel);
      if (!existsSync(p)) {
        writeFileSync(p, content);
      }
    }
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

  readHeartbeat(): string | null {
    const p = join(this.projectDir, 'HEARTBEAT.md');
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
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

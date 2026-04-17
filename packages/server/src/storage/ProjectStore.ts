import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { writeJsonAtomicSync } from '../infra/json-files.js';
import { join, resolve } from 'node:path';
import type { ProjectConfig, FlightdeckJson, AgentRole } from '@flightdeck-ai/shared';
import { generateAgentConfigs, type AgentConfigOutput } from '../agents/AgentConfigs.js';
import { FD_HOME } from '../cli/constants.js';

const FLIGHTDECK_HOME = FD_HOME;
const SUBDIRS = ['specs', 'decisions', 'memory', 'agents', 'messages', 'reports'];

const ROLE_PREFERENCE_TEMPLATE = `# Role & Model Selection Preference

## Role Assignment
- Use **worker** for implementation tasks
- Use **reviewer** for code review after worker submits
- Use **qa-tester** only for user-facing features
- Skip **tech-writer** unless explicitly requested

## Model Selection
- Complex architecture/refactoring → high-performance model
- Routine bug fixes, small changes → budget model
- Code review → mid-tier is fine
- If a task fails once, retry with a higher-tier model

## Runtime Preference
- Prefer the default runtime for general work
- Use alternative runtimes when the default is unavailable
`;

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

  /** Alias for path — the project working directory. */
  get cwd(): string {
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
      isolation: 'file_lock',
      onCompletion: 'ask',
    };
    this.setConfig(defaultConfig);

    // Write default HEARTBEAT.md
    const heartbeatPath = join(this.projectDir, 'HEARTBEAT.md');
    if (!existsSync(heartbeatPath)) {
      writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE);
    }

    // Write default role-preference.md
    const rolePrefPath = join(this.projectDir, 'role-preference.md');
    if (!existsSync(rolePrefPath)) {
      writeFileSync(rolePrefPath, ROLE_PREFERENCE_TEMPLATE);
    }

    // Create new memory subdirectories
    mkdirSync(join(this.projectDir, 'memory', 'discoveries'), { recursive: true });

    // Write empty memory files
    const memoryFiles: Record<string, string> = {
      'memory/PROJECT.md': '# Project Overview\n\n_Describe the project architecture, key decisions, and conventions here._\n',
      'memory/decisions.md': '# Decision Summary\n\n_Lead will maintain a compressed summary of recent decisions here._\n',
      'memory/learnings.md': '# Learnings\n\n_Patterns, gotchas, and lessons learned across the project._\n',
      'memory/SOUL.md': `# SOUL.md - Lead Identity

You are Lead — the project coordinator and decision-maker.

## Work Style
- Decide and delegate, don't implement
- Adapt plans when reality changes
- Escalate to user when genuinely uncertain

## Project Understanding
_Updated automatically as the project evolves._

---
_This file defines who Lead is. Update it as the project personality develops._
`,
      'memory/USER.md': `# USER.md - About the User

_Lead will learn user preferences over time and record them here._

## Communication Style
- (observed preferences will be added)

## Technical Preferences
- (coding style, tool preferences, etc.)

---
_Updated by Lead as it learns how the user works._
`,
      'memory/MEMORY.md': `# MEMORY.md - Long-Term Memory

_Curated insights and key decisions. Distilled from daily logs._

## Architecture Decisions
_(none yet)_

## Lessons Learned
_(none yet)_

## Key Context
_(none yet)_

---
_Updated periodically by consolidating daily logs._
`,
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
    writeJsonAtomicSync(configPath, config);
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
    writeJsonAtomicSync(join(dir, '.flightdeck.json'), data);
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

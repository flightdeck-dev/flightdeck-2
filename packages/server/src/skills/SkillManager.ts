import { readFileSync, readdirSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { AgentRole } from '@flightdeck-ai/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, 'defaults');

/** Resolve absolute path to the MCP server entry point (works for both .ts and compiled .js). */
function resolveMcpServerPath(): string {
  const tsPath = join(__dirname, '..', 'mcp', 'server.ts');
  if (existsSync(tsPath)) return tsPath;
  const jsPath = join(__dirname, '..', 'mcp', 'server.js');
  if (existsSync(jsPath)) return jsPath;
  // Fallback — return ts path and let tsx handle it
  return tsPath;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string; // relative path to SKILL.md from project root
}

export interface McpServerConfig {
  command: string;
  args?: string[];
}

export interface SkillsConfig {
  global?: string[];
  roles?: Record<string, string[]>;
}

export interface McpConfig {
  global?: Record<string, McpServerConfig>;
  roles?: Record<string, Record<string, McpServerConfig>>;
}

export interface ProjectConfig {
  skills?: SkillsConfig;
  mcp?: McpConfig;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 */
function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '' };
  try {
    const fm = parseYaml(match[1]) as Record<string, unknown>;
    return {
      name: (fm.name as string) || '',
      description: (fm.description as string) || '',
    };
  } catch {
    return { name: '', description: '' };
  }
}

export class SkillManager {
  private config: ProjectConfig | null = null;
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Load .flightdeck/config.yaml from the project directory.
   */
  loadProjectConfig(projectDir?: string): ProjectConfig {
    const dir = projectDir ?? this.projectDir;
    const configPath = join(dir, '.flightdeck', 'config.yaml');
    if (!existsSync(configPath)) {
      this.config = {};
      return this.config;
    }
    try {
      const raw = readFileSync(configPath, 'utf-8');
      this.config = (parseYaml(raw) as ProjectConfig) || {};
      return this.config;
    } catch {
      this.config = {};
      return this.config;
    }
  }

  private getConfig(): ProjectConfig {
    if (!this.config) this.loadProjectConfig();
    return this.config!;
  }

  /**
   * Get skill names for a given role (global + role-specific).
   */
  getSkillsForRole(role: AgentRole): string[] {
    const config = this.getConfig();
    const global = config.skills?.global ?? [];
    const roleSkills = config.skills?.roles?.[role] ?? [];
    // Deduplicate while preserving order
    return [...new Set([...global, ...roleSkills])];
  }

  /**
   * Get MCP server configs for a given role (global + role-specific).
   */
  getMcpForRole(role: AgentRole): Record<string, McpServerConfig> {
    const config = this.getConfig();
    const global = config.mcp?.global ?? {};
    const roleMcp = config.mcp?.roles?.[role] ?? {};
    return { ...global, ...roleMcp };
  }

  /**
   * List all installed skills in .flightdeck/skills/.
   */
  listInstalledSkills(): SkillInfo[] {
    const skillsDir = join(this.projectDir, '.flightdeck', 'skills');
    if (!existsSync(skillsDir)) return [];

    const skills: SkillInfo[] = [];
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        const content = readFileSync(skillMd, 'utf-8');
        const { name, description } = parseSkillFrontmatter(content);
        skills.push({
          name: name || entry.name,
          description,
          path: `.flightdeck/skills/${entry.name}/SKILL.md`,
        });
      }
    } catch { /* ignore */ }
    return skills;
  }

  /**
   * Get SkillInfo for specific skill names, resolving from installed skills.
   */
  private resolveSkills(names: string[]): SkillInfo[] {
    const installed = this.listInstalledSkills();
    const byName = new Map(installed.map(s => [s.name, s]));
    return names
      .map(n => byName.get(n))
      .filter((s): s is SkillInfo => s !== undefined);
  }

  /**
   * Generate AGENTS.md content for a given role.
   */
  generateAgentsMd(role: AgentRole, taskContext?: string): string {
    const skillNames = this.getSkillsForRole(role);
    const skills = this.resolveSkills(skillNames);

    let md = `# AGENTS.md (auto-generated for ${role})\n\nYou are a Flightdeck ${role} agent.\n`;

    if (skills.length > 0) {
      md += `\n## Available Skills\nWhen a skill matches your current task, read its SKILL.md for detailed instructions.\n\n`;
      for (const skill of skills) {
        md += `- **${skill.name}**: ${skill.description}\n  → ${skill.path}\n`;
      }
    }

    if (taskContext) {
      md += `\n## Current Task Context\n${taskContext}\n`;
    }

    return md;
  }

  /**
   * Generate .mcp.json content for a given role.
   */
  generateMcpJson(role: AgentRole): string {
    const servers = this.getMcpForRole(role);
    const mcpServers: Record<string, { command: string; args?: string[] }> = {};

    for (const [name, config] of Object.entries(servers)) {
      // Parse command into command + args if needed
      const parts = config.command.split(/\s+/);
      const cmd = parts[0];
      const cmdArgs = [...parts.slice(1), ...(config.args ?? [])];
      mcpServers[name] = cmdArgs.length > 0
        ? { command: cmd, args: cmdArgs }
        : { command: cmd };
    }

    return JSON.stringify({ mcpServers }, null, 2);
  }

  /**
   * Install a skill to .flightdeck/skills/ from a source directory.
   */
  installSkill(source: string): SkillInfo | null {
    const skillsDir = join(this.projectDir, '.flightdeck', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    if (!existsSync(source)) return null;

    // Determine skill name from the source directory
    const skillMd = join(source, 'SKILL.md');
    if (!existsSync(skillMd)) return null;

    const content = readFileSync(skillMd, 'utf-8');
    const { name, description } = parseSkillFrontmatter(content);
    const skillName = name || source.split('/').pop()!;

    const destDir = join(skillsDir, skillName);
    cpSync(source, destDir, { recursive: true });

    return {
      name: skillName,
      description,
      path: `.flightdeck/skills/${skillName}/SKILL.md`,
    };
  }

  /**
   * Copy built-in default skills to .flightdeck/skills/.
   */
  static copyDefaults(projectDir: string): void {
    const skillsDir = join(projectDir, '.flightdeck', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    if (!existsSync(DEFAULTS_DIR)) return;
    for (const entry of readdirSync(DEFAULTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = join(skillsDir, entry.name);
      if (!existsSync(dest)) {
        cpSync(join(DEFAULTS_DIR, entry.name), dest, { recursive: true });
      }
    }
  }

  /**
   * Generate default config.yaml content.
   */
  static generateDefaultConfig(): string {
    return `# Flightdeck Project Configuration

agents:
  default_runtime: copilot
  default_model: high          # fallback for any role not specified

  roles:
    lead:
      runtime: copilot
      model: medium
    planner:
      runtime: copilot
      model: medium
    worker:
      runtime: copilot
      model: high
    reviewer:
      runtime: copilot
      model: high
    product-thinker:
      runtime: copilot
      model: medium
    qa-tester:
      runtime: copilot
      model: high
    tech-writer:
      runtime: copilot
      model: medium

skills:
  global:
    - flightdeck-basics
    - task-workflow
  roles:
    lead:
      - memory-management
    worker: []
    reviewer: []
    planner: []

mcp:
  global:
    flightdeck:
      command: "npx tsx ${resolveMcpServerPath()}"
  roles:
    lead: {}
    worker: {}
    reviewer: {}
`;
  }
}

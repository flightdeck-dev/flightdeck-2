import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { FD_HOME } from '../cli/constants.js';

export interface RolePermissions {
  [key: string]: boolean;
}

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  model?: string;
  permissions: RolePermissions;
  instructions: string; // markdown body after frontmatter
}

export interface SpecialistDefinition {
  id: string;
  name: string;
  scope: string;
  checklist: string[];
  outputSchema: string;
  content: string;
}

/** Directory containing built-in default role .md files */
const DEFAULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'defaults');

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
    return { frontmatter, body: match[2].trim() };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function loadRoleFromFile(filePath: string): RoleDefinition | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const id = (frontmatter.id as string) || (frontmatter.name as string);
    if (!id) return null;
    return {
      id,
      name: (frontmatter.name as string) || frontmatter.id as string,
      description: (frontmatter.description as string) || '',
      icon: (frontmatter.icon as string) || '🔧',
      color: (frontmatter.color as string) || '#888888',
      model: frontmatter.model as string | undefined,
      permissions: (frontmatter.permissions as RolePermissions) || {},
      instructions: body,
    };
  } catch {
    return null;
  }
}

function loadSpecialistsFromDir(dir: string): SpecialistDefinition[] {
  if (!existsSync(dir)) return [];
  const specialists: SpecialistDefinition[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const content = readFileSync(join(dir, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      specialists.push({
        id: (frontmatter.id as string) || file.replace('.md', ''),
        name: (frontmatter.name as string) || file.replace('.md', ''),
        scope: (frontmatter.scope as string) || '',
        checklist: (frontmatter.checklist as string[]) || [],
        outputSchema: (frontmatter.outputSchema as string) || '',
        content: body,
      });
    }
  } catch { /* ignore read errors */ }
  return specialists;
}

export class RoleRegistry {
  private roles = new Map<string, RoleDefinition>();
  private specialists = new Map<string, SpecialistDefinition[]>();

  constructor(projectName?: string) {
    // 1. Load built-in defaults from src/roles/defaults/*.md
    this.loadFromDir(DEFAULTS_DIR);

    // Load global roles (can override built-ins)
    const globalDir = join(FD_HOME, 'roles');
    this.loadFromDir(globalDir);

    // Load project roles (can override global)
    if (projectName) {
      const projectDir = join(FD_HOME, 'projects', projectName, 'roles');
      this.loadFromDir(projectDir);
    }
  }

  private loadFromDir(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const role = loadRoleFromFile(join(dir, entry.name));
          if (role) this.roles.set(role.id, role);
        }
        if (entry.isDirectory()) {
          // Check for specialists subdirectory
          const specialistsDir = join(dir, entry.name, 'specialists');
          const specs = loadSpecialistsFromDir(specialistsDir);
          if (specs.length > 0) {
            this.specialists.set(entry.name, specs);
          }
          // Also check if the directory itself has a role md
          const roleMd = join(dir, entry.name, `${entry.name}.md`);
          if (existsSync(roleMd)) {
            const role = loadRoleFromFile(roleMd);
            if (role) this.roles.set(role.id, role);
          }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Discover and register custom agent roles from repo convention paths:
   * .github/agents/*.md and .claude/agents/*.md
   */
  discoverRepoRoles(cwd: string): void {
    const dirs = [
      join(cwd, '.github', 'agents'),
      join(cwd, '.claude', 'agents'),
    ];
    for (const dir of dirs) {
      this.loadFromDir(dir);
    }
  }

  get(id: string): RoleDefinition | null {
    return this.roles.get(id) ?? null;
  }

  list(): RoleDefinition[] {
    return Array.from(this.roles.values());
  }

  getPermissions(roleId: string): RolePermissions {
    return this.roles.get(roleId)?.permissions ?? {};
  }

  hasPermission(roleId: string, permission: string): boolean {
    const perms = this.getPermissions(roleId);
    return perms[permission] === true;
  }

  getSpecialists(roleId: string): SpecialistDefinition[] {
    return this.specialists.get(roleId) ?? [];
  }
}

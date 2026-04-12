import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

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

// Built-in role defaults
const BUILT_IN_ROLES: Record<string, RoleDefinition> = {
  lead: {
    id: 'lead', name: 'Lead', description: 'Orchestrates agents and manages project execution',
    icon: '👑', color: '#f0883e', model: 'claude-opus-4',
    permissions: { task_add: true, task_fail: true, discuss: true, agent_spawn: true, agent_terminate: true, task_cancel: true, task_pause: true, task_retry: true, task_skip: true, task_complete: true, task_reopen: true },
    instructions: 'You are the Lead agent. You orchestrate the project, manage other agents, and make high-level decisions.',
  },
  planner: {
    id: 'planner', name: 'Planner', description: 'Breaks down specs into tasks and plans execution',
    icon: '📋', color: '#a371f7', model: 'claude-sonnet-4',
    permissions: { task_add: true, discuss: true, task_skip: true, declare_tasks: true },
    instructions: 'You are the Planner. You analyze specs and create detailed task breakdowns.',
  },
  worker: {
    id: 'worker', name: 'Worker', description: 'Writes and modifies code, implements features and fixes',
    icon: '💻', color: '#3fb950', model: 'claude-sonnet-4',
    permissions: { task_claim: true, task_submit: true, task_fail: true, task_cancel: true, memory_write: true },
    instructions: 'You are a skilled Software Developer. Implement tasks thoroughly and submit quality work.',
  },
  reviewer: {
    id: 'reviewer', name: 'Reviewer', description: 'Reviews submitted work for quality and correctness',
    icon: '🔍', color: '#58a6ff', model: 'claude-sonnet-4',
    permissions: { task_complete: true, task_fail: true },
    instructions: 'You are a Code Reviewer. Review submitted work carefully for correctness, quality, and adherence to standards.',
  },
  'product-thinker': {
    id: 'product-thinker', name: 'Product Thinker', description: 'Provides product perspective and UX insights',
    icon: '💡', color: '#d2a8ff', model: 'claude-sonnet-4',
    permissions: { discuss: true, memory_write: true },
    instructions: 'You are a Product Thinker. Provide product perspective, UX insights, and strategic thinking.',
  },
  'qa-tester': {
    id: 'qa-tester', name: 'QA Tester', description: 'Tests implementations and reports issues',
    icon: '🧪', color: '#f778ba', model: 'claude-sonnet-4',
    permissions: { task_claim: true, task_submit: true, task_fail: true, memory_write: true },
    instructions: 'You are a QA Tester. Test implementations thoroughly and report any issues found.',
  },
  'tech-writer': {
    id: 'tech-writer', name: 'Tech Writer', description: 'Writes documentation and guides',
    icon: '📝', color: '#7ee787', model: 'claude-sonnet-4',
    permissions: { task_claim: true, task_submit: true, memory_write: true },
    instructions: 'You are a Technical Writer. Write clear, accurate documentation.',
  },
};

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
    if (!frontmatter.id) return null;
    return {
      id: frontmatter.id as string,
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
    // Load built-in defaults
    for (const [id, role] of Object.entries(BUILT_IN_ROLES)) {
      this.roles.set(id, { ...role });
    }

    // Load global roles (can override built-ins)
    const globalDir = join(homedir(), '.flightdeck', 'roles');
    this.loadFromDir(globalDir);

    // Load project roles (can override global)
    if (projectName) {
      const projectDir = join(homedir(), '.flightdeck', 'projects', projectName, 'roles');
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

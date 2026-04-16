import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillManager } from '../../src/skills/SkillManager.js';

const TEST_DIR = join(tmpdir(), `flightdeck-skill-test-${Date.now()}`);

function setupProject(config?: string): string {
  const dir = join(TEST_DIR, `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.flightdeck', 'skills', 'flightdeck-basics'), { recursive: true });
  mkdirSync(join(dir, '.flightdeck', 'skills', 'task-workflow'), { recursive: true });
  mkdirSync(join(dir, '.flightdeck', 'skills', 'memory-management'), { recursive: true });
  mkdirSync(join(dir, '.flightdeck', 'skills', 'deploy-aws'), { recursive: true });

  writeFileSync(join(dir, '.flightdeck', 'skills', 'flightdeck-basics', 'SKILL.md'),
    '---\nname: flightdeck-basics\ndescription: How to use Flightdeck MCP tools\n---\nContent here.');
  writeFileSync(join(dir, '.flightdeck', 'skills', 'task-workflow', 'SKILL.md'),
    '---\nname: task-workflow\ndescription: The claim → execute → submit workflow\n---\nContent.');
  writeFileSync(join(dir, '.flightdeck', 'skills', 'memory-management', 'SKILL.md'),
    '---\nname: memory-management\ndescription: How to manage project memory\n---\nContent.');
  writeFileSync(join(dir, '.flightdeck', 'skills', 'deploy-aws', 'SKILL.md'),
    '---\nname: deploy-aws\ndescription: AWS deployment procedures\n---\nContent.');

  if (config) {
    writeFileSync(join(dir, '.flightdeck', 'config.yaml'), config);
  }

  return dir;
}

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('SkillManager', () => {
  describe('loadProjectConfig', () => {
    it('returns empty config when no config.yaml exists', () => {
      const dir = setupProject();
      const sm = new SkillManager(dir);
      const config = sm.loadProjectConfig();
      expect(config).toEqual({});
    });

    it('loads config.yaml', () => {
      const dir = setupProject(`
skills:
  global:
    - flightdeck-basics
  roles:
    worker:
      - deploy-aws
mcp:
  global:
    flightdeck:
      command: "npx flightdeck-mcp"
`);
      const sm = new SkillManager(dir);
      const config = sm.loadProjectConfig();
      expect(config.skills?.global).toEqual(['flightdeck-basics']);
      expect(config.skills?.roles?.worker).toEqual(['deploy-aws']);
      expect(config.mcp?.global?.flightdeck?.command).toBe('npx flightdeck-mcp');
    });
  });

  describe('getSkillsForRole', () => {
    it('returns global + role-specific skills', () => {
      const dir = setupProject(`
skills:
  global:
    - flightdeck-basics
    - task-workflow
  roles:
    worker:
      - deploy-aws
    lead:
      - memory-management
`);
      const sm = new SkillManager(dir);
      const workerSkills = sm.getSkillsForRole('worker');
      expect(workerSkills).toEqual(['flightdeck-basics', 'task-workflow', 'deploy-aws']);

      const leadSkills = sm.getSkillsForRole('lead');
      expect(leadSkills).toEqual(['flightdeck-basics', 'task-workflow', 'memory-management']);
    });

    it('deduplicates skills', () => {
      const dir = setupProject(`
skills:
  global:
    - flightdeck-basics
  roles:
    worker:
      - flightdeck-basics
      - deploy-aws
`);
      const sm = new SkillManager(dir);
      const skills = sm.getSkillsForRole('worker');
      expect(skills).toEqual(['flightdeck-basics', 'deploy-aws']);
    });

    it('returns empty when role has no config', () => {
      const dir = setupProject(`
skills:
  global: []
`);
      const sm = new SkillManager(dir);
      expect(sm.getSkillsForRole('reviewer')).toEqual([]);
    });
  });

  describe('getMcpForRole', () => {
    it('returns global + role-specific MCP servers', () => {
      const dir = setupProject(`
mcp:
  global:
    flightdeck:
      command: "npx flightdeck-mcp"
  roles:
    worker:
      postgres:
        command: "npx @mcp/server-postgres"
        args: ["postgresql://localhost/mydb"]
`);
      const sm = new SkillManager(dir);
      const mcp = sm.getMcpForRole('worker');
      expect(mcp.flightdeck.command).toBe('npx flightdeck-mcp');
      expect(mcp.postgres.command).toBe('npx @mcp/server-postgres');
      expect(mcp.postgres.args).toEqual(['postgresql://localhost/mydb']);
    });

    it('returns only global when role has no MCP config', () => {
      const dir = setupProject(`
mcp:
  global:
    flightdeck:
      command: "npx flightdeck-mcp"
`);
      const sm = new SkillManager(dir);
      const mcp = sm.getMcpForRole('reviewer');
      expect(Object.keys(mcp)).toEqual(['flightdeck']);
    });
  });

  describe('listInstalledSkills', () => {
    it('lists all skills in .flightdeck/skills/', () => {
      const dir = setupProject();
      const sm = new SkillManager(dir);
      const skills = sm.listInstalledSkills();
      const names = skills.map(s => s.name).sort();
      expect(names).toEqual(['deploy-aws', 'flightdeck-basics', 'memory-management', 'task-workflow']);
    });

    it('returns empty for missing skills dir', () => {
      const dir = join(TEST_DIR, 'empty-proj');
      mkdirSync(dir, { recursive: true });
      const sm = new SkillManager(dir);
      expect(sm.listInstalledSkills()).toEqual([]);
    });
  });

  describe('generateAgentsMd', () => {
    it('generates AGENTS.md with skill descriptions', () => {
      const dir = setupProject(`
skills:
  global:
    - flightdeck-basics
  roles:
    worker:
      - deploy-aws
`);
      const sm = new SkillManager(dir);
      const md = sm.generateAgentsMd('worker');
      expect(md).toContain('Worker Agent');
      expect(md).toContain('**flightdeck-basics**');
      expect(md).toContain('How to use Flightdeck MCP tools');
      expect(md).toContain('**deploy-aws**');
      expect(md).toContain('AWS deployment procedures');
      expect(md).toContain('.flightdeck/skills/flightdeck-basics/SKILL.md');
    });

    it('includes task context when provided', () => {
      const dir = setupProject(`
skills:
  global: []
`);
      const sm = new SkillManager(dir);
      const md = sm.generateAgentsMd('worker', 'Implement the auth module');
      expect(md).toContain('Current Task Context');
      expect(md).toContain('Implement the auth module');
    });

    it('omits skills section when no skills configured', () => {
      const dir = setupProject(`
skills:
  global: []
`);
      const sm = new SkillManager(dir);
      const md = sm.generateAgentsMd('worker');
      expect(md).not.toContain('Available Skills');
    });
  });

  describe('generateMcpJson', () => {
    it('generates valid .mcp.json', () => {
      const dir = setupProject(`
mcp:
  global:
    flightdeck:
      command: "npx flightdeck-mcp"
  roles:
    worker:
      postgres:
        command: "npx @mcp/server-postgres"
        args: ["postgresql://localhost/mydb"]
`);
      const sm = new SkillManager(dir);
      const json = sm.generateMcpJson('worker');
      const parsed = JSON.parse(json);
      expect(parsed.mcpServers.flightdeck).toEqual({ command: 'npx', args: ['flightdeck-mcp'] });
      expect(parsed.mcpServers.postgres).toEqual({
        command: 'npx',
        args: ['@mcp/server-postgres', 'postgresql://localhost/mydb'],
      });
    });

    it('generates empty mcpServers when no config', () => {
      const dir = setupProject();
      const sm = new SkillManager(dir);
      const json = sm.generateMcpJson('reviewer');
      const parsed = JSON.parse(json);
      expect(parsed.mcpServers).toEqual({});
    });
  });

  describe('copyDefaults', () => {
    it('copies built-in skills to project', () => {
      const dir = join(TEST_DIR, `copy-test-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      SkillManager.copyDefaults(dir);
      expect(existsSync(join(dir, '.flightdeck', 'skills', 'flightdeck-basics', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, '.flightdeck', 'skills', 'task-workflow', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, '.flightdeck', 'skills', 'memory-management', 'SKILL.md'))).toBe(true);
    });
  });

  describe('generateDefaultConfig', () => {
    it('generates valid YAML config', () => {
      const config = SkillManager.generateDefaultConfig();
      expect(config).toContain('skills:');
      expect(config).toContain('mcp:');
      expect(config).toContain('flightdeck-basics');
      expect(config).toContain('task-workflow');
      expect(config).toContain('npx tsx');
    });
  });

  describe('installSkill', () => {
    it('installs a skill from source directory', () => {
      const dir = setupProject();
      const sourceDir = join(TEST_DIR, 'ext-skill');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'SKILL.md'),
        '---\nname: docker-deploy\ndescription: Docker deployment\n---\nHow to deploy with Docker.');

      const sm = new SkillManager(dir);
      const result = sm.installSkill(sourceDir);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('docker-deploy');
      expect(existsSync(join(dir, '.flightdeck', 'skills', 'docker-deploy', 'SKILL.md'))).toBe(true);
    });

    it('returns null for missing source', () => {
      const dir = setupProject();
      const sm = new SkillManager(dir);
      expect(sm.installSkill('/nonexistent')).toBeNull();
    });
  });
});

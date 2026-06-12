import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LeadManager, HEARTBEAT_OK, FLIGHTDECK_NO_REPLY } from '../../src/lead/LeadManager.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { ProjectStore } from '../../src/storage/ProjectStore.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('LeadManager', () => {
  const projectName = `test-lead-${Date.now()}`;
  let project: ProjectStore;
  let sqlite: SqliteStore;
  let acpAdapter: AcpAdapter;

  beforeEach(() => {
    project = new ProjectStore(projectName);
    if (!project.exists()) project.init(projectName);
    project.ensureDirs();
    sqlite = new SqliteStore(project.subpath('state.sqlite'));
    acpAdapter = new AcpAdapter();
  });

  afterEach(() => {
    sqlite?.close();
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('builds user_message steer', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const steer = lm.buildSteer({
      type: 'user_message',
      message: { id: 'msg-1', parentId: null, taskId: null, authorType: 'user', authorId: 'user', content: 'Hello Lead', metadata: null, createdAt: new Date().toISOString(), updatedAt: null },
    });
    expect(steer).toContain('[USER]');
    expect(steer).toContain('Hello Lead');
  });

  it('builds task_failure steer', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const steer = lm.buildSteer({
      type: 'task_failure',
      taskId: 'task-001',
      error: 'npm test failed',
    });
    expect(steer).toContain('[SYSTEM]');
    expect(steer).toContain('task_failure');
    expect(steer).toContain('task-001');
    expect(steer).toContain('npm test failed');
  });

  it('builds heartbeat steer with minimal prompt', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const steer = lm.buildHeartbeatSteer();
    expect(steer).toContain('HEARTBEAT.md');
    expect(steer).toContain('HEARTBEAT_OK');
    expect(steer).not.toContain('[heartbeat steer]');
  });

  it('builds same heartbeat steer regardless of HEARTBEAT.md existence', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const hbPath = project.subpath('HEARTBEAT.md');
    if (existsSync(hbPath)) rmSync(hbPath);
    const steer = lm.buildHeartbeatSteer();
    expect(steer).toContain('HEARTBEAT.md');
    expect(steer).toContain('HEARTBEAT_OK');
  });

  it('checkHeartbeatConditions passes with no conditions', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    expect(lm.checkHeartbeatConditions()).toBe(true);
  });

  it('checkHeartbeatConditions fails tasks_completed when 0', () => {
    const lm = new LeadManager({
      sqlite,
      project,
      acpAdapter: new AcpAdapter(),
      heartbeat: {
        enabled: true,
        interval: 60000,
        conditions: [{ type: 'tasks_completed', min: 1 }],
      },
    });
    expect(lm.checkHeartbeatConditions()).toBe(false);
    lm.recordTaskCompletion();
    expect(lm.checkHeartbeatConditions()).toBe(true);
  });

  // --- NO_REPLY / IDLE filtering tests ---

  describe('handleLeadResponse', () => {
    it('suppresses HEARTBEAT_OK', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('HEARTBEAT_OK')).toBeNull();
    });

    it('suppresses HEARTBEAT_OK with whitespace', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('  HEARTBEAT_OK  \n')).toBeNull();
    });

    it('suppresses FLIGHTDECK_NO_REPLY', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('FLIGHTDECK_NO_REPLY')).toBeNull();
    });

    it('suppresses FLIGHTDECK_NO_REPLY with whitespace', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('  FLIGHTDECK_NO_REPLY  ')).toBeNull();
    });

    it('forwards normal responses', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      const response = 'Here is what I found about the task...';
      expect(lm.handleLeadResponse(response)).toBe(response);
    });

    it('forwards responses that contain sentinel strings but are not exact matches', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      const response = 'The agent returned HEARTBEAT_OK but I want to report it';
      expect(lm.handleLeadResponse(response)).toBe(response);
    });
  });

  // --- Sentinel constants tests ---

  it('exports sentinel constants', () => {
    expect(HEARTBEAT_OK).toBe('HEARTBEAT_OK');
    expect(FLIGHTDECK_NO_REPLY).toBe('FLIGHTDECK_NO_REPLY');
  });

  // --- Director session management ---

  describe('Director persistent session', () => {
    it('directorSessionId is null initially', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.getDirectorSessionId()).toBeNull();
    });

    it('leadSessionId is null initially', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.getLeadSessionId()).toBeNull();
    });
  });

  describe('director spawn', () => {
    function fakeAdapter(spawns: any[], opts?: { failDirector?: boolean }) {
      return {
        spawn: async (o: any) => {
          if (opts?.failDirector && o.role === 'director') {
            throw new Error('Runtime "codex" is not available: command "codex" not found on PATH.');
          }
          spawns.push(o);
          return { agentId: `${o.role}-fake`, sessionId: `sess-${o.role}`, status: 'running' };
        },
        getSession: () => undefined,
        steer: async () => '',
        kill: async () => { /* noop */ },
        getMetadata: async () => null,
      };
    }

    it('director inherits lead runtime/model when not explicitly configured', async () => {
      // Regression: an unconfigured director used to fall back to the global
      // default runtime (codex) — which may not be installed — and then
      // silently dropped every message from the Lead.
      const cwd = project.subpath('.');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(cwd, '.flightdeck'), { recursive: true });
      writeFileSync(join(cwd, '.flightdeck', 'config.yaml'), [
        'agents:', '  roles:', '    lead:', '      runtime: copilot', '      model: claude-sonnet-4.6', '',
      ].join('\n'));
      const spawns: any[] = [];
      const lm = new LeadManager({
        sqlite, project, acpAdapter: fakeAdapter(spawns), cwd,
        leadRuntime: 'copilot' as any, leadModel: 'claude-sonnet-4.6',
      });
      await lm.spawnDirector();
      const d = spawns.find(s => s.role === 'director');
      expect(d.runtime).toBe('copilot');
      expect(d.model).toBe('claude-sonnet-4.6');
    });

    it('surfaces director spawn failure via onSystemNotice instead of failing silently', async () => {
      const spawns: any[] = [];
      const notices: string[] = [];
      const lm = new LeadManager({
        sqlite, project, acpAdapter: fakeAdapter(spawns, { failDirector: true }), cwd: project.subpath('.'),
      });
      lm.onSystemNotice = c => notices.push(c);
      await lm.spawnLead();
      expect(notices.some(n => n.includes('Director failed to start'))).toBe(true);
      expect(notices.some(n => n.includes('not found on PATH'))).toBe(true);
    });
  });
});

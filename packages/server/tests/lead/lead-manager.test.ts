import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LeadManager, FLIGHTDECK_IDLE, FLIGHTDECK_NO_REPLY } from '../../src/lead/LeadManager.js';
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
    const projDir = join(homedir(), '.flightdeck', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('builds user_message steer', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const steer = lm.buildSteer({
      type: 'user_message',
      message: { id: 'msg-1', threadId: null, parentId: null, taskId: null, authorType: 'user', authorId: 'user', content: 'Hello Lead', metadata: null, createdAt: new Date().toISOString(), updatedAt: null },
    });
    expect(steer).toContain('[user message]');
    expect(steer).toContain('Hello Lead');
  });

  it('builds task_failure steer', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const steer = lm.buildSteer({
      type: 'task_failure',
      taskId: 'task-001',
      error: 'npm test failed',
    });
    expect(steer).toContain('[task failure]');
    expect(steer).toContain('task-001');
    expect(steer).toContain('npm test failed');
  });

  it('builds heartbeat steer with HEARTBEAT.md', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    writeFileSync(project.subpath('HEARTBEAT.md'), '# Check stuff\n- Do the thing\n');
    const steer = lm.buildHeartbeatSteer();
    expect(steer).toContain('[heartbeat steer]');
    expect(steer).toContain('HEARTBEAT.md');
    expect(steer).toContain('Check stuff');
    expect(steer).toContain('Do the thing');
  });

  it('builds heartbeat steer without HEARTBEAT.md', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    const hbPath = project.subpath('HEARTBEAT.md');
    if (existsSync(hbPath)) rmSync(hbPath);
    const steer = lm.buildHeartbeatSteer();
    expect(steer).toContain('[heartbeat steer]');
    expect(steer).not.toContain('HEARTBEAT.md');
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
    it('suppresses FLIGHTDECK_IDLE', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('FLIGHTDECK_IDLE')).toBeNull();
    });

    it('suppresses FLIGHTDECK_IDLE with whitespace', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.handleLeadResponse('  FLIGHTDECK_IDLE  \n')).toBeNull();
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
      const response = 'The agent returned FLIGHTDECK_IDLE but I want to report it';
      expect(lm.handleLeadResponse(response)).toBe(response);
    });
  });

  // --- Sentinel constants tests ---

  it('exports sentinel constants', () => {
    expect(FLIGHTDECK_IDLE).toBe('FLIGHTDECK_IDLE');
    expect(FLIGHTDECK_NO_REPLY).toBe('FLIGHTDECK_NO_REPLY');
  });

  // --- Planner session management ---

  describe('Planner persistent session', () => {
    it('plannerSessionId is null initially', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.getPlannerSessionId()).toBeNull();
    });

    it('leadSessionId is null initially', () => {
      const lm = new LeadManager({ sqlite, project, acpAdapter });
      expect(lm.getLeadSessionId()).toBeNull();
    });
  });
});

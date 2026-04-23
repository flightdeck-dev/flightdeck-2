import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LeadManager, type DirectorEvent } from '../../src/lead/LeadManager.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { ProjectStore } from '../../src/storage/ProjectStore.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getToolsForRole } from '../../src/mcp/toolPermissions.js';

describe('Reactive Director', () => {
  const projectName = `test-director-${Date.now()}`;
  let project: ProjectStore;
  let sqlite: SqliteStore;
  let acpAdapter: AcpAdapter;
  let lm: LeadManager;

  beforeEach(() => {
    project = new ProjectStore(projectName);
    if (!project.exists()) project.init(projectName);
    project.ensureDirs();
    sqlite = new SqliteStore(project.subpath('state.sqlite'));
    acpAdapter = new AcpAdapter();
    lm = new LeadManager({ sqlite, project, acpAdapter });
  });

  afterEach(() => {
    sqlite?.close();
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  describe('buildDirectorSteer', () => {
    it('generates steer for critical_task_completed', () => {
      const event: DirectorEvent = {
        type: 'critical_task_completed',
        taskId: 'task-001',
        specId: 'spec-1',
        title: 'Setup database',
        remainingInSpec: 3,
      };
      const steer = lm.buildDirectorSteer(event);
      expect(steer).toContain('[plan event: critical task completed]');
      expect(steer).toContain('Setup database');
      expect(steer).toContain('task-001');
      expect(steer).toContain('Remaining tasks in spec: 3');
      expect(steer).toContain('validate');
    });

    it('generates steer for task_failed', () => {
      const event: DirectorEvent = {
        type: 'task_failed',
        taskId: 'task-002',
        error: 'Build failed with exit code 1',
        retriesLeft: 1,
      };
      const steer = lm.buildDirectorSteer(event);
      expect(steer).toContain('[plan event: task failed]');
      expect(steer).toContain('task-002');
      expect(steer).toContain('Build failed with exit code 1');
      expect(steer).toContain('Retries left: 1');
    });

    it('generates steer for worker_escalation', () => {
      const event: DirectorEvent = {
        type: 'worker_escalation',
        taskId: 'task-003',
        agentId: 'agent-w1',
        reason: 'Cannot access the API endpoint',
      };
      const steer = lm.buildDirectorSteer(event);
      expect(steer).toContain('[plan event: worker escalation]');
      expect(steer).toContain('agent-w1');
      expect(steer).toContain('Cannot access the API endpoint');
    });

    it('generates steer for spec_milestone', () => {
      const event: DirectorEvent = {
        type: 'spec_milestone',
        specId: 'spec-1',
        completed: 5,
        total: 10,
      };
      const steer = lm.buildDirectorSteer(event);
      expect(steer).toContain('[plan event: spec milestone]');
      expect(steer).toContain('5/10');
      expect(steer).toContain('spec-1');
    });

    it('generates steer for plan_validation_request', () => {
      const event: DirectorEvent = {
        type: 'plan_validation_request',
        specId: 'spec-2',
        context: 'Major architecture change detected',
      };
      const steer = lm.buildDirectorSteer(event);
      expect(steer).toContain('[plan event: validation request]');
      expect(steer).toContain('spec-2');
      expect(steer).toContain('Major architecture change detected');
    });
  });

  describe('Director tool permissions', () => {
    it('includes task_get for director role', () => {
      const tools = getToolsForRole('director');
      expect(tools).toContain('flightdeck_task_get');
    });

    it('includes memory_write for director role', () => {
      const tools = getToolsForRole('director');
      expect(tools).toContain('flightdeck_memory_write');
    });
  });
});

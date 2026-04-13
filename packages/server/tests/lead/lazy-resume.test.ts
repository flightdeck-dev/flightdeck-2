import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LeadManager } from '../../src/lead/LeadManager.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { ProjectStore } from '../../src/storage/ProjectStore.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('LeadManager lazy resume', () => {
  const projectName = `test-lazy-${Date.now()}`;
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

  it('isPlannerSuspended returns false initially', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    expect(lm.isPlannerSuspended()).toBe(false);
  });

  it('isPlannerSuspended returns true after setSuspendedPlanner', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    lm.setSuspendedPlanner({ acpSessionId: 'acp-123', cwd: '/tmp/test' });
    expect(lm.isPlannerSuspended()).toBe(true);
  });

  it('steerPlanner auto-resumes suspended planner', async () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    
    // Mock resumeSession to track the call
    const resumeSpy = vi.spyOn(acpAdapter, 'resumeSession').mockResolvedValue({
      agentId: 'planner-resumed' as any,
      sessionId: 'session-resumed',
      status: 'running',
    });
    const steerSpy = vi.spyOn(acpAdapter, 'steer').mockResolvedValue('ok');

    lm.setSuspendedPlanner({ acpSessionId: 'acp-old', cwd: '/tmp/test', model: 'claude-sonnet' });
    expect(lm.isPlannerSuspended()).toBe(true);

    await lm.steerPlanner('Plan this spec');

    // Should have resumed first
    expect(resumeSpy).toHaveBeenCalledWith({
      previousSessionId: 'acp-old',
      cwd: '/tmp/test',
      role: 'planner',
      model: 'claude-sonnet',
    });

    // Then steered
    expect(steerSpy).toHaveBeenCalledWith('session-resumed', { content: 'Plan this spec' });

    // No longer suspended
    expect(lm.isPlannerSuspended()).toBe(false);
    expect(lm.getPlannerSessionId()).toBe('session-resumed');
  });

  it('steerPlanner handles resume failure gracefully', async () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    
    vi.spyOn(acpAdapter, 'resumeSession').mockRejectedValue(new Error('session expired'));
    const steerSpy = vi.spyOn(acpAdapter, 'steer').mockResolvedValue('ok');

    lm.setSuspendedPlanner({ acpSessionId: 'acp-expired', cwd: '/tmp/test' });
    
    // Should not throw
    await lm.steerPlanner('Plan this spec');

    // Should not have steered (resume failed)
    expect(steerSpy).not.toHaveBeenCalled();
    // Suspended info cleared (won't retry endlessly)
    expect(lm.isPlannerSuspended()).toBe(false);
  });
});

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
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('isDirectorSuspended returns false initially', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    expect(lm.isDirectorSuspended()).toBe(false);
  });

  it('isDirectorSuspended returns true after setSuspendedDirector', () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    lm.setSuspendedDirector({ acpSessionId: 'acp-123', cwd: '/tmp/test' });
    expect(lm.isDirectorSuspended()).toBe(true);
  });

  it('steerDirector auto-resumes suspended director', async () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    
    // Mock resumeSession to track the call
    const resumeSpy = vi.spyOn(acpAdapter, 'resumeSession').mockResolvedValue({
      agentId: 'director-resumed' as any,
      sessionId: 'session-resumed',
      status: 'running',
    });
    const steerSpy = vi.spyOn(acpAdapter, 'steer').mockResolvedValue('ok');

    lm.setSuspendedDirector({ acpSessionId: 'acp-old', cwd: '/tmp/test', model: 'claude-sonnet' });
    expect(lm.isDirectorSuspended()).toBe(true);

    await lm.steerDirector('Plan this spec');

    // Should have resumed first
    expect(resumeSpy).toHaveBeenCalledWith({
      previousSessionId: 'acp-old',
      cwd: '/tmp/test',
      role: 'director',
      model: 'claude-sonnet',
    });

    // Then steered
    expect(steerSpy).toHaveBeenCalledWith('session-resumed', { content: 'Plan this spec' });

    // No longer suspended
    expect(lm.isDirectorSuspended()).toBe(false);
    expect(lm.getDirectorSessionId()).toBe('session-resumed');
  });

  it('steerDirector handles resume failure gracefully', async () => {
    const lm = new LeadManager({ sqlite, project, acpAdapter });
    
    vi.spyOn(acpAdapter, 'resumeSession').mockRejectedValue(new Error('session expired'));
    const steerSpy = vi.spyOn(acpAdapter, 'steer').mockResolvedValue('ok');

    lm.setSuspendedDirector({ acpSessionId: 'acp-expired', cwd: '/tmp/test' });
    
    // Should not throw
    await lm.steerDirector('Plan this spec');

    // Should not have steered (resume failed)
    expect(steerSpy).not.toHaveBeenCalled();
    // Suspended info cleared (won't retry endlessly)
    expect(lm.isDirectorSuspended()).toBe(false);
  });
});

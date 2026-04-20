import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import type { AgentId } from '@flightdeck-ai/shared';

describe('Flightdeck Facade', () => {
  let fd: Flightdeck;
  const projectName = `test-facade-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
  });

  afterEach(() => {
    fd.close();
    // Clean up
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('initializes a project', () => {
    const status = fd.status();
    expect(status.config.name).toBe(projectName);
    expect(status.agentCount).toBe(0);
    expect(status.totalCost).toBeUndefined();
  });

  it('creates specs', () => {
    const spec = fd.createSpec('Add OAuth2', 'Implement OAuth2 support');
    expect(spec.title).toBe('Add OAuth2');
    expect(fd.listSpecs()).toHaveLength(1);
  });

  it('adds and lists tasks', () => {
    const task = fd.addTask({ title: 'Implement auth' });
    expect(task.state).toBe('ready');
    expect(fd.listTasks()).toHaveLength(1);
  });

  it('full task lifecycle: add -> claim -> submit -> complete', () => {
    fd.registerAgent({
      id: 'agent-1' as AgentId,
      role: 'worker', runtime: 'acp', acpSessionId: null,
      status: 'idle', currentSpecId: null, costAccumulated: 0, lastHeartbeat: null,
    });

    const task = fd.addTask({ title: 'Build feature' });
    const claimed = fd.claimTask(task.id, 'agent-1' as AgentId);
    expect(claimed.state).toBe('running');

    const submitted = fd.submitTask(task.id);
    expect(submitted.state).toBe('in_review');

    const completed = fd.completeTask(task.id);
    expect(completed.state).toBe('done');
  });

  it('sends and reads messages', () => {
    fd.sendMessage({
      id: 'msg-1' as any,
      from: 'agent-1' as AgentId,
      to: null,
      channel: 'general',
      content: 'Hello team!',
      timestamp: new Date().toISOString(),
    }, 'general');

    const messages = fd.readMessages('general');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello team!');
  });

  it('writes and searches memory', () => {
    fd.writeMemory('auth.md', '# Auth\nUsing PKCE flow for OAuth2');
    const results = fd.searchMemory('PKCE');
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('auth.md');
  });

  it('returns correct task stats', () => {
    fd.addTask({ title: 'A' });
    fd.addTask({ title: 'B' });
    const t = fd.addTask({ title: 'C' });
    fd.claimTask(t.id, 'agent-1' as AgentId);

    const stats = fd.getTaskStats();
    expect(stats.ready).toBe(2);
    expect(stats.running).toBe(1);
  });
});

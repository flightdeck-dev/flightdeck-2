import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StatusFileWriter, type StatusData } from '../../src/status/StatusFileWriter.js';
import { TaskContextWriter } from '../../src/status/TaskContextWriter.js';
import type { Task, Agent } from '@flightdeck-ai/shared';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001' as any,
    specId: null,
    title: 'Implement auth',
    description: 'Add JWT authentication',
    state: 'running',
    role: 'worker',
    dependsOn: [],
    priority: 1,
    assignedAgent: 'agent-001' as any,
    acpSessionId: null,
    source: 'planned',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-001' as any,
    role: 'worker',
    runtime: 'acp',
    acpSessionId: null,
    status: 'busy',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
    ...overrides,
  } as Agent;
}

describe('StatusFileWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-status-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes status.md to state directory (not cwd)', () => {
    const stateDir = join(tmpDir, 'state');
    const writer = new StatusFileWriter(0, stateDir);
    const data: StatusData = {
      projectName: 'test-project',
      governance: 'autonomous',
      tasks: [makeTask(), makeTask({ id: 'task-002' as any, state: 'done', title: 'Setup CI' })],
      agents: [makeAgent()],
      totalCost: 1.23,
    };

    writer.writeStatusImmediate(tmpDir, data);

    // Should NOT write to cwd/.flightdeck/
    expect(existsSync(join(tmpDir, '.flightdeck', 'status.md'))).toBe(false);
    // Should write to state dir
    const filePath = join(stateDir, 'status.md');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Project Status: test-project');
    expect(content).toContain('Governance: autonomous');
    expect(content).toContain('Total: 2');
    expect(content).toContain('Running: 1');
    expect(content).toContain('Done: 1');
    expect(content).toContain('agent-001');
    expect(content).toContain('Implement auth');
    expect(content).toContain('$1.23');
  });

  it('generates correct markdown', () => {
    const data: StatusData = {
      projectName: 'my-app',
      governance: 'collaborative',
      tasks: [
        makeTask({ state: 'ready', assignedAgent: null }),
        makeTask({ id: 'task-002' as any, state: 'running', title: 'Add tests' }),
        makeTask({ id: 'task-003' as any, state: 'done', title: 'Init repo', updatedAt: new Date(Date.now() - 3600_000).toISOString() }),
      ],
      agents: [makeAgent({ status: 'busy' }), makeAgent({ id: 'agent-lead' as any, role: 'lead', status: 'idle' })],
      totalCost: 0.5,
    };

    const md = StatusFileWriter.generateMarkdown(data);
    expect(md).toContain('Ready: 1');
    expect(md).toContain('Running: 1');
    expect(md).toContain('Done: 1');
    expect(md).toContain('## Active Agents');
    expect(md).toContain('agent-lead');
    expect(md).toContain('## Recent Completions');
    expect(md).toContain('Init repo');
    expect(md).toContain('$0.50');
  });

  it('is a no-op when no stateDir is provided', () => {
    const writer = new StatusFileWriter(0);
    const nested = join(tmpDir, 'deep', 'project');
    const data: StatusData = {
      projectName: 'test',
      governance: 'autonomous',
      tasks: [],
      agents: [],
      totalCost: 0,
    };

    writer.writeStatusImmediate(nested, data);
    expect(existsSync(join(nested, '.flightdeck', 'status.md'))).toBe(false);
  });

  it('shows epics with progress in status markdown', () => {
    const epicTask = makeTask({ id: 'epic-1' as any, title: 'Auth System', state: 'pending', parentTaskId: null });
    const sub1 = makeTask({ id: 'sub-1' as any, title: 'Login', state: 'done', parentTaskId: 'epic-1' as any });
    const sub2 = makeTask({ id: 'sub-2' as any, title: 'Logout', state: 'running', parentTaskId: 'epic-1' as any });
    const sub3 = makeTask({ id: 'sub-3' as any, title: 'Token', state: 'ready', parentTaskId: 'epic-1' as any });
    const data: StatusData = {
      projectName: 'epic-test',
      governance: 'autonomous',
      tasks: [epicTask, sub1, sub2, sub3],
      agents: [],
      totalCost: 0,
    };
    const md = StatusFileWriter.generateMarkdown(data);
    expect(md).toContain('## Epics');
    expect(md).toContain('Auth System [1/3 done]');
  });
});

describe('TaskContextWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-taskctx-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeAll is a no-op (context served via MCP tool)', () => {
    const tasks = [
      makeTask(),
      makeTask({ id: 'task-002' as any, title: 'Add tests', state: 'ready', assignedAgent: null }),
    ];
    const agents = [makeAgent()];

    TaskContextWriter.writeAll(tmpDir, tasks, agents);

    // Should NOT write any files
    const file1 = join(tmpDir, '.flightdeck', 'tasks', 'task-001.md');
    const file2 = join(tmpDir, '.flightdeck', 'tasks', 'task-002.md');
    expect(existsSync(file1)).toBe(false);
    expect(existsSync(file2)).toBe(false);
  });

  it('includes dependencies in task context', () => {
    const task = makeTask({ dependsOn: ['dep-1' as any, 'dep-2' as any] });
    const md = TaskContextWriter.generateMarkdown(task, []);
    expect(md).toContain('## Dependencies');
    expect(md).toContain('- dep-1');
    expect(md).toContain('- dep-2');
  });

  it('does nothing for empty task list', () => {
    TaskContextWriter.writeAll(tmpDir, [], []);
    expect(existsSync(join(tmpDir, '.flightdeck', 'tasks'))).toBe(false);
  });
});

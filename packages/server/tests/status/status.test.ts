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

  it('writes status.md to .flightdeck directory', () => {
    const writer = new StatusFileWriter(0);
    const data: StatusData = {
      projectName: 'test-project',
      governance: 'autonomous',
      tasks: [makeTask(), makeTask({ id: 'task-002' as any, state: 'done', title: 'Setup CI' })],
      agents: [makeAgent()],
      totalCost: 1.23,
    };

    writer.writeStatusImmediate(tmpDir, data);

    const filePath = join(tmpDir, '.flightdeck', 'status.md');
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

  it('creates .flightdeck directory if it does not exist', () => {
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
    expect(existsSync(join(nested, '.flightdeck', 'status.md'))).toBe(true);
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

  it('writes per-task markdown files', () => {
    const tasks = [
      makeTask(),
      makeTask({ id: 'task-002' as any, title: 'Add tests', state: 'ready', assignedAgent: null }),
    ];
    const agents = [makeAgent()];

    TaskContextWriter.writeAll(tmpDir, tasks, agents);

    const file1 = join(tmpDir, '.flightdeck', 'tasks', 'task-001.md');
    const file2 = join(tmpDir, '.flightdeck', 'tasks', 'task-002.md');
    expect(existsSync(file1)).toBe(true);
    expect(existsSync(file2)).toBe(true);

    const content1 = readFileSync(file1, 'utf-8');
    expect(content1).toContain('# Implement auth');
    expect(content1).toContain('**State:** running');
    expect(content1).toContain('**Assigned Agent:** agent-001');
    expect(content1).toContain('## Description');
    expect(content1).toContain('Add JWT authentication');

    const content2 = readFileSync(file2, 'utf-8');
    expect(content2).toContain('# Add tests');
    expect(content2).toContain('**State:** ready');
    expect(content2).not.toContain('**Assigned Agent:**');
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

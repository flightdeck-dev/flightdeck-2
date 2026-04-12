import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DailyReport } from '../../src/reporting/DailyReport.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { DecisionLog } from '../../src/storage/DecisionLog.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task, TaskId, AgentId, SpecId, DecisionId, Agent } from '@flightdeck-ai/shared';

function makeTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}` as TaskId,
    specId: null,
    title: 'Test task',
    description: '',
    state: 'pending',
    role: 'worker',
    dependsOn: [],
    priority: 0,
    assignedAgent: null,
    acpSessionId: null,
    source: 'planned',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DailyReport', () => {
  let dir: string;
  let sqlite: SqliteStore;
  let decLog: DecisionLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-report-'));
    sqlite = new SqliteStore(join(dir, 'state.sqlite'));
    decLog = new DecisionLog(join(dir, 'decisions'));
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates report with empty state', () => {
    const report = new DailyReport(sqlite, decLog);
    const md = report.generate();
    expect(md).toContain('# Flightdeck Daily Report');
    expect(md).toContain('0/0 tasks complete');
  });

  it('shows completed tasks', () => {
    const now = new Date().toISOString();
    sqlite.insertTask(makeTask({ id: 'task-001' as TaskId, title: 'Setup DB', state: 'done', updatedAt: now }));
    sqlite.insertTask(makeTask({ id: 'task-002' as TaskId, title: 'Add API', state: 'running' }));

    const report = new DailyReport(sqlite, decLog);
    const md = report.generate({ since: '2020-01-01T00:00:00.000Z' });
    expect(md).toContain('## Completed Today');
    expect(md).toContain('Setup DB');
    expect(md).toContain('1/2 tasks complete (50%)');
  });

  it('shows blocked and gated tasks', () => {
    sqlite.insertTask(makeTask({ id: 'task-b1' as TaskId, title: 'Blocked task', state: 'blocked' }));
    sqlite.insertTask(makeTask({ id: 'task-g1' as TaskId, title: 'Gated task', state: 'gated' }));

    const report = new DailyReport(sqlite, decLog);
    const md = report.generate();
    expect(md).toContain('## Blocked');
    expect(md).toContain('Blocked task');
    expect(md).toContain('Gated task');
  });

  it('shows in_review tasks', () => {
    sqlite.insertTask(makeTask({ id: 'task-r1' as TaskId, title: 'Review me', state: 'in_review' }));
    const report = new DailyReport(sqlite, decLog);
    const md = report.generate();
    expect(md).toContain('## In Review');
    expect(md).toContain('Review me');
  });

  it('includes decisions', () => {
    decLog.append({
      id: 'dec-1' as DecisionId,
      taskId: 'task-1' as TaskId,
      agentId: 'agent-1' as AgentId,
      type: 'architecture',
      title: 'Chose PKCE flow',
      reasoning: 'OAuth 2.1 standard',
      alternatives: ['Implicit'],
      confidence: 0.95,
      reversible: true,
      timestamp: new Date().toISOString(),
      status: 'auto_approved',
    });

    const report = new DailyReport(sqlite, decLog);
    const md = report.generate({ since: '2020-01-01T00:00:00.000Z' });
    expect(md).toContain('## Key Decisions');
    expect(md).toContain('Chose PKCE flow');
    expect(md).toContain('auto-approved');
  });

  it('shows tomorrow plan with ready tasks', () => {
    sqlite.insertTask(makeTask({ id: 'task-r1' as TaskId, title: 'Next task', state: 'ready' }));
    const report = new DailyReport(sqlite, decLog);
    const md = report.generate();
    expect(md).toContain("## Tomorrow's Plan");
    expect(md).toContain('Next task');
  });

  it('shows cost breakdown when agents have cost', () => {
    const agent: Agent = {
      id: 'agent-w1' as AgentId,
      role: 'worker',
      runtime: 'acp',
      acpSessionId: null,
      status: 'busy',
      currentSpecId: null,
      costAccumulated: 3.50,
      lastHeartbeat: null,
    };
    sqlite.insertAgent(agent);

    const report = new DailyReport(sqlite, decLog);
    const md = report.generate();
    expect(md).toContain('## Cost Breakdown');
    expect(md).toContain('$3.50');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecisionLog } from '../../src/storage/DecisionLog.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Decision, DecisionId, TaskId, AgentId } from '@flightdeck-ai/shared';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `dec-${Math.random().toString(36).slice(2, 8)}` as DecisionId,
    taskId: 'task-1' as TaskId,
    agentId: 'agent-1' as AgentId,
    type: 'implementation',
    title: 'Test decision',
    reasoning: 'Because reasons',
    alternatives: ['Alt A'],
    confidence: 0.8,
    reversible: true,
    timestamp: new Date().toISOString(),
    status: 'auto_approved',
    ...overrides,
  };
}

describe('DecisionLog', () => {
  let dir: string;
  let log: DecisionLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-declog-'));
    log = new DecisionLog(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and reads decisions', () => {
    const d1 = makeDecision({ title: 'First' });
    const d2 = makeDecision({ title: 'Second' });
    log.append(d1);
    log.append(d2);
    const all = log.readAll();
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe('First');
    expect(all[1].title).toBe('Second');
  });

  it('returns empty array when no file exists', () => {
    expect(log.readAll()).toEqual([]);
  });

  it('filters by taskId', () => {
    log.append(makeDecision({ taskId: 'task-a' as TaskId }));
    log.append(makeDecision({ taskId: 'task-b' as TaskId }));
    log.append(makeDecision({ taskId: 'task-a' as TaskId }));
    const filtered = log.list({ taskId: 'task-a' });
    expect(filtered).toHaveLength(2);
  });

  it('filters by status', () => {
    log.append(makeDecision({ status: 'auto_approved' }));
    log.append(makeDecision({ status: 'pending_review' }));
    log.append(makeDecision({ status: 'auto_approved' }));
    expect(log.list({ status: 'pending_review' })).toHaveLength(1);
  });

  it('filters by type', () => {
    log.append(makeDecision({ type: 'architecture' }));
    log.append(makeDecision({ type: 'dependency' }));
    expect(log.list({ type: 'architecture' })).toHaveLength(1);
  });

  it('limits results', () => {
    for (let i = 0; i < 10; i++) log.append(makeDecision({ title: `D${i}` }));
    const limited = log.list({ limit: 3 });
    expect(limited).toHaveLength(3);
    expect(limited[0].title).toBe('D7'); // last 3
  });

  it('getPending returns only pending_review', () => {
    log.append(makeDecision({ status: 'auto_approved' }));
    log.append(makeDecision({ status: 'pending_review' }));
    expect(log.getPending()).toHaveLength(1);
    expect(log.getPending()[0].status).toBe('pending_review');
  });
});

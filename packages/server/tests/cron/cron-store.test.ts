import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronStore } from '../../src/cron/CronStore.js';
import type { CronSchedule } from '../../src/cron/CronStore.js';

describe('CronStore', () => {
  let dir: string;
  let store: CronStore;
  const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cron-test-'));
    store = new CronStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns empty default when no file exists', () => {
    const file = store.load();
    expect(file).toEqual({ version: 1, jobs: [] });
  });

  it('addJob creates job with UUID and state', () => {
    const job = store.addJob({ name: 'test', schedule, prompt: 'do stuff' });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.name).toBe('test');
    expect(job.enabled).toBe(true);
    expect(job.state.lastRunAt).toBeNull();
    expect(job.state.nextRunAt).toBeTruthy();
    expect(job.state.consecutiveErrors).toBe(0);
  });

  it('getJob returns the job by id', () => {
    const job = store.addJob({ name: 'a', schedule, prompt: 'p' });
    expect(store.getJob(job.id)?.name).toBe('a');
    expect(store.getJob('nonexistent')).toBeNull();
  });

  it('listJobs returns all jobs', () => {
    store.addJob({ name: 'a', schedule, prompt: 'p' });
    store.addJob({ name: 'b', schedule, prompt: 'q' });
    expect(store.listJobs()).toHaveLength(2);
  });

  it('removeJob removes and returns true, false for missing', () => {
    const job = store.addJob({ name: 'a', schedule, prompt: 'p' });
    expect(store.removeJob(job.id)).toBe(true);
    expect(store.listJobs()).toHaveLength(0);
    expect(store.removeJob('nope')).toBe(false);
  });

  it('enableJob / disableJob toggles enabled', () => {
    const job = store.addJob({ name: 'a', schedule, prompt: 'p', enabled: false });
    expect(store.getJob(job.id)?.enabled).toBe(false);
    store.enableJob(job.id);
    expect(store.getJob(job.id)?.enabled).toBe(true);
    store.disableJob(job.id);
    expect(store.getJob(job.id)?.enabled).toBe(false);
  });

  it('getDueJobs returns only enabled+due jobs', () => {
    const job = store.addJob({ name: 'a', schedule, prompt: 'p' });
    // Set nextRunAt to the past
    store.updateJobState(job.id, { nextRunAt: new Date(Date.now() - 60000).toISOString() });
    expect(store.getDueJobs()).toHaveLength(1);

    // Disable it
    store.disableJob(job.id);
    expect(store.getDueJobs()).toHaveLength(0);
  });

  it('computeNextRun returns a future date for valid expression', () => {
    const next = store.computeNextRun({ kind: 'cron', expr: '* * * * *' });
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('computeNextRun returns null for invalid expression', () => {
    expect(store.computeNextRun({ kind: 'cron', expr: 'invalid' })).toBeNull();
  });

  it('updateJobState updates state fields', () => {
    const job = store.addJob({ name: 'a', schedule, prompt: 'p' });
    store.updateJobState(job.id, { lastRunStatus: 'ok', consecutiveErrors: 0 });
    const updated = store.getJob(job.id)!;
    expect(updated.state.lastRunStatus).toBe('ok');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronStore } from '../../src/cron/CronStore.js';
import { CronScheduler } from '../../src/cron/CronScheduler.js';
import type { CronSchedule } from '../../src/cron/CronStore.js';

describe('CronScheduler', () => {
  let dir: string;
  let store: CronStore;
  const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cron-sched-test-'));
    store = new CronStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('start and stop control the timer', () => {
    const handler = vi.fn().mockResolvedValue(null);
    const scheduler = new CronScheduler(store, handler, 999999);
    scheduler.start();
    scheduler.stop();
  });

  it('tick calls onJobDue for due jobs', async () => {
    const job = store.addJob({ name: 'test', schedule, prompt: 'go' });
    store.updateJobState(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    const done = new Promise<void>(resolve => {
      const handler = vi.fn().mockImplementation(async () => { resolve(); return null; });
      const scheduler = new CronScheduler(store, handler, 999999);
      scheduler.tick();
      // Store ref for assertion after resolve
      (globalThis as any).__testHandler = handler;
      (globalThis as any).__testScheduler = scheduler;
    });

    await done;
    // Small delay for state update
    await new Promise(r => setTimeout(r, 50));

    const handler = (globalThis as any).__testHandler;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].id).toBe(job.id);

    const updated = store.getJob(job.id)!;
    expect(updated.state.lastRunStatus).toBe('ok');
    (globalThis as any).__testScheduler.stop();
  });

  it('error updates job state', async () => {
    const job = store.addJob({ name: 'fail', schedule, prompt: 'go' });
    store.updateJobState(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    let handlerCalled: () => void;
    const calledPromise = new Promise<void>(r => { handlerCalled = r; });

    const handler = vi.fn().mockImplementation(async () => {
      handlerCalled();
      throw new Error('boom');
    });
    const scheduler = new CronScheduler(store, handler, 999999);
    scheduler.tick();

    await calledPromise;
    // Wait for the catch/finally to complete
    await new Promise(r => setTimeout(r, 50));

    const updated = store.getJob(job.id)!;
    expect(updated.state.lastRunStatus).toBe('error');
    expect(updated.state.lastError).toBe('boom');
    expect(updated.state.consecutiveErrors).toBe(1);
    scheduler.stop();
  });

  it('running jobs are not double-executed', async () => {
    const job = store.addJob({ name: 'slow', schedule, prompt: 'go' });
    store.updateJobState(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    let resolveHandler: () => void;
    const handlerPromise = new Promise<void>(r => { resolveHandler = r; });
    const handler = vi.fn().mockImplementation(() => handlerPromise);

    const scheduler = new CronScheduler(store, handler, 999999);
    scheduler.tick();
    scheduler.tick(); // Second tick while first is running

    expect(handler).toHaveBeenCalledTimes(1);
    expect(scheduler.activeJobCount).toBe(1);

    resolveHandler!();
    await new Promise(r => setTimeout(r, 50));
    scheduler.stop();
  });
});

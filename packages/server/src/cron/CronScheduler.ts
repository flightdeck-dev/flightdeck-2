import type { CronStore, CronJob } from './CronStore.js';

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();

  constructor(
    private cronStore: CronStore,
    private onJobDue: (job: CronJob) => Promise<string | null>,
    private tickIntervalMs: number = 30_000,
  ) {}

  start(): void {
    // Recompute nextRunAt for all enabled jobs on startup
    const file = this.cronStore.load();
    for (const job of file.jobs) {
      if (job.enabled && !job.state.nextRunAt) {
        job.state.nextRunAt = this.cronStore.computeNextRun(job.schedule)?.toISOString() ?? null;
      }
    }
    this.cronStore.save(file);

    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    // Also tick immediately on start
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get activeJobCount(): number {
    return this.running.size;
  }

  tick(): void {
    const dueJobs = this.cronStore.getDueJobs();
    for (const job of dueJobs) {
      if (this.running.has(job.id)) continue;
      this.running.add(job.id);
      this.executeJob(job)
        .catch(() => {})
        .finally(() => this.running.delete(job.id));
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startTime = Date.now();
    try {
      await this.onJobDue(job);
      this.cronStore.updateJobState(job.id, {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: 'ok',
        lastDurationMs: Date.now() - startTime,
        consecutiveErrors: 0,
        lastError: undefined,
        nextRunAt: this.cronStore.computeNextRun(job.schedule)?.toISOString() ?? null,
      });
    } catch (err) {
      this.cronStore.updateJobState(job.id, {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: 'error',
        lastDurationMs: Date.now() - startTime,
        consecutiveErrors: job.state.consecutiveErrors + 1,
        lastError: err instanceof Error ? err.message : String(err),
        nextRunAt: this.cronStore.computeNextRun(job.schedule)?.toISOString() ?? null,
      });
    }
  }
}

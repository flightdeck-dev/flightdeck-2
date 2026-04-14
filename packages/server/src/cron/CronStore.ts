import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CronExpressionParser } from 'cron-parser';

export interface CronSchedule {
  kind: 'cron';
  expr: string;      // cron expression "0 9 * * *"
  tz?: string;        // IANA timezone, default UTC
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  schedule: CronSchedule;
  skill?: string;       // skill name (reads SKILL.md)
  prompt: string;       // message to send to Lead
  delivery?: {
    mode: 'webhook' | 'log';
    webhookUrl?: string;
  };
  state: {
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: 'ok' | 'error' | null;
    lastDurationMs: number | null;
    consecutiveErrors: number;
    lastError?: string;
  };
}

export interface CronFile {
  version: 1;
  jobs: CronJob[];
}

export class CronStore {
  private filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'cron.json');
  }

  load(): CronFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, jobs: [] };
    }
    return JSON.parse(readFileSync(this.filePath, 'utf-8'));
  }

  save(file: CronFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  addJob(opts: { name: string; description?: string; schedule: CronSchedule; skill?: string; prompt: string; enabled?: boolean; delivery?: CronJob['delivery'] }): CronJob {
    const file = this.load();
    const now = new Date().toISOString();
    const job: CronJob = {
      id: randomUUID(),
      name: opts.name,
      description: opts.description,
      enabled: opts.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      schedule: opts.schedule,
      skill: opts.skill,
      prompt: opts.prompt,
      delivery: opts.delivery,
      state: {
        nextRunAt: this.computeNextRun(opts.schedule)?.toISOString() ?? null,
        lastRunAt: null,
        lastRunStatus: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
      },
    };
    file.jobs.push(job);
    this.save(file);
    return job;
  }

  removeJob(id: string): boolean {
    const file = this.load();
    const before = file.jobs.length;
    file.jobs = file.jobs.filter(j => j.id !== id);
    if (file.jobs.length === before) return false;
    this.save(file);
    return true;
  }

  getJob(id: string): CronJob | null {
    return this.load().jobs.find(j => j.id === id) ?? null;
  }

  listJobs(): CronJob[] {
    return this.load().jobs;
  }

  enableJob(id: string): boolean {
    return this.updateJob(id, { enabled: true }) !== null;
  }

  disableJob(id: string): boolean {
    return this.updateJob(id, { enabled: false }) !== null;
  }

  updateJob(id: string, updates: Partial<Pick<CronJob, 'name' | 'description' | 'enabled' | 'schedule' | 'prompt' | 'skill' | 'delivery'>>): CronJob | null {
    const file = this.load();
    const job = file.jobs.find(j => j.id === id);
    if (!job) return null;
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    if (updates.schedule) {
      job.state.nextRunAt = this.computeNextRun(updates.schedule)?.toISOString() ?? null;
    }
    this.save(file);
    return job;
  }

  updateJobState(id: string, stateUpdates: Partial<CronJob['state']>): void {
    const file = this.load();
    const job = file.jobs.find(j => j.id === id);
    if (!job) return;
    Object.assign(job.state, stateUpdates);
    this.save(file);
  }

  getDueJobs(): CronJob[] {
    const now = Date.now();
    return this.load().jobs.filter(j =>
      j.enabled && j.state.nextRunAt && new Date(j.state.nextRunAt).getTime() <= now
    );
  }

  computeNextRun(schedule: CronSchedule, after?: Date): Date | null {
    try {
      const options: any = { currentDate: after ?? new Date() };
      if (schedule.tz) options.tz = schedule.tz;
      const cron = CronExpressionParser.parse(schedule.expr, options);
      return cron.next().toDate();
    } catch {
      return null;
    }
  }
}

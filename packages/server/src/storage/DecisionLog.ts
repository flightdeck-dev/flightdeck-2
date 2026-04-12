import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision } from '@flightdeck-ai/shared';

export interface DecisionListOptions {
  taskId?: string;
  type?: string;
  status?: string;
  since?: string;
  limit?: number;
}

export class DecisionLog {
  constructor(private decisionsDir: string) {}

  append(decision: Decision, filename: string = 'decisions.jsonl'): void {
    mkdirSync(this.decisionsDir, { recursive: true });
    const filepath = join(this.decisionsDir, filename);
    appendFileSync(filepath, JSON.stringify(decision) + '\n');
  }

  readAll(filename: string = 'decisions.jsonl'): Decision[] {
    const filepath = join(this.decisionsDir, filename);
    if (!existsSync(filepath)) return [];
    const lines = readFileSync(filepath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l) as Decision);
  }

  list(opts?: DecisionListOptions, filename: string = 'decisions.jsonl'): Decision[] {
    let decisions = this.readAll(filename);

    if (opts?.taskId) {
      decisions = decisions.filter(d => d.taskId === opts.taskId);
    }
    if (opts?.type) {
      decisions = decisions.filter(d => d.type === opts.type);
    }
    if (opts?.status) {
      decisions = decisions.filter(d => d.status === opts.status);
    }
    if (opts?.since) {
      decisions = decisions.filter(d => d.timestamp >= opts.since!);
    }
    if (opts?.limit && opts.limit > 0) {
      decisions = decisions.slice(-opts.limit);
    }

    return decisions;
  }

  getPending(filename: string = 'decisions.jsonl'): Decision[] {
    return this.list({ status: 'pending_review' }, filename);
  }
}

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Decision } from '@flightdeck-ai/shared';

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
}

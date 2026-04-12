import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LearningCategory = 'pattern' | 'gotcha' | 'decision' | 'performance' | 'security';

export interface Learning {
  id: string;
  agentId: string;
  category: LearningCategory;
  content: string;
  tags: string[];
  timestamp: string;
}

export class LearningsStore {
  private filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'learnings.jsonl');
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  append(learning: Omit<Learning, 'id' | 'timestamp'>): Learning {
    const entry: Learning = {
      id: randomUUID(),
      ...learning,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    return entry;
  }

  list(category?: LearningCategory): Learning[] {
    const all = this.readAll();
    if (!category) return all;
    return all.filter(l => l.category === category);
  }

  search(query: string): Learning[] {
    const q = query.toLowerCase();
    return this.readAll().filter(l =>
      l.content.toLowerCase().includes(q) ||
      l.tags.some(t => t.toLowerCase().includes(q)) ||
      l.category.toLowerCase().includes(q)
    );
  }

  prune(olderThan: Date): number {
    const all = this.readAll();
    const kept = all.filter(l => new Date(l.timestamp) >= olderThan);
    const pruned = all.length - kept.length;
    writeFileSync(this.filePath, kept.map(l => JSON.stringify(l)).join('\n') + (kept.length ? '\n' : ''));
    return pruned;
  }

  private readAll(): Learning[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => {
      try { return JSON.parse(line) as Learning; }
      catch { return null; }
    }).filter((l): l is Learning => l !== null);
  }
}

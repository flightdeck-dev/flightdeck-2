import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Suggestion, SuggestionStatus } from '../orchestrator/Scout.js';

/**
 * Persists suggestions to a JSON file in the project directory.
 */
export class SuggestionStore {
  private filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'suggestions.json');
  }

  list(opts?: { specId?: string; status?: SuggestionStatus }): Suggestion[] {
    const all = this.readAll();
    return all.filter(s => {
      if (opts?.specId && s.specId !== opts.specId) return false;
      if (opts?.status && s.status !== opts.status) return false;
      return true;
    });
  }

  get(id: string): Suggestion | null {
    return this.readAll().find(s => s.id === id) ?? null;
  }

  addMany(suggestions: Suggestion[]): void {
    const all = this.readAll();
    all.push(...suggestions);
    this.writeAll(all);
  }

  updateStatus(id: string, status: SuggestionStatus): Suggestion | null {
    const all = this.readAll();
    const idx = all.findIndex(s => s.id === id);
    if (idx === -1) return null;
    all[idx].status = status;
    this.writeAll(all);
    return all[idx];
  }

  private readAll(): Suggestion[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as Suggestion[];
    } catch {
      return [];
    }
  }

  private writeAll(suggestions: Suggestion[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(suggestions, null, 2));
  }
}

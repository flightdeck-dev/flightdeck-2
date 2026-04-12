import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class ReportStore {
  constructor(private reportsDir: string) {}

  write(filename: string, content: string): void {
    mkdirSync(this.reportsDir, { recursive: true });
    writeFileSync(join(this.reportsDir, filename), content);
  }

  read(filename: string): string | null {
    const filepath = join(this.reportsDir, filename);
    if (!existsSync(filepath)) return null;
    return readFileSync(filepath, 'utf-8');
  }

  list(): string[] {
    if (!existsSync(this.reportsDir)) return [];
    return readdirSync(this.reportsDir).filter(f => f.endsWith('.md')).sort();
  }

  latest(): string | null {
    const files = this.list();
    if (files.length === 0) return null;
    return this.read(files[files.length - 1]);
  }
}

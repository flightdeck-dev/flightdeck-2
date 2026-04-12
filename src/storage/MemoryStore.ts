import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export class MemoryStore {
  constructor(private memoryDir: string) {}

  list(): string[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
  }

  read(filename: string): string | null {
    const filepath = join(this.memoryDir, filename);
    if (!existsSync(filepath)) return null;
    return readFileSync(filepath, 'utf-8');
  }

  write(filename: string, content: string): void {
    mkdirSync(this.memoryDir, { recursive: true });
    writeFileSync(join(this.memoryDir, filename), content);
  }

  search(query: string): Array<{ filename: string; snippet: string }> {
    const results: Array<{ filename: string; snippet: string }> = [];
    const files = this.list();
    const lowerQuery = query.toLowerCase();
    for (const f of files) {
      const content = this.read(f);
      if (!content) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          results.push({ filename: f, snippet: lines.slice(start, end).join('\n') });
          break;
        }
      }
    }
    return results;
  }
}

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface MemorySearchResult {
  filename: string;
  line: number;
  snippet: string;
}

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

  /** Recursively collect all .md files under memoryDir */
  private listAllMd(dir?: string): string[] {
    const base = dir ?? this.memoryDir;
    if (!existsSync(base)) return [];
    const results: string[] = [];
    for (const entry of readdirSync(base)) {
      const full = join(base, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...this.listAllMd(full));
      } else if (entry.endsWith('.md')) {
        results.push(full);
      }
    }
    return results;
  }

  /**
   * Full-text search across all memory/*.md and memory/**\/*.md files.
   * Returns matching snippets with file path and line numbers.
   */
  search(query: string): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    const files = this.listAllMd();
    const lowerQuery = query.toLowerCase();

    for (const filepath of files) {
      const content = readFileSync(filepath, 'utf-8');
      const lines = content.split('\n');
      const relPath = relative(this.memoryDir, filepath);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          results.push({
            filename: relPath,
            line: i + 1,
            snippet: lines.slice(start, end).join('\n'),
          });
        }
      }
    }
    return results;
  }
}

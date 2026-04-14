import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

export interface MemorySearchResult {
  filename: string;
  line: number;
  snippet: string;
}

export class MemoryStore {
  private db: DatabaseInstance | null = null;

  constructor(
    private memoryDir: string,
    dbPathOrDb?: string | DatabaseInstance,
  ) {
    if (dbPathOrDb) {
      if (typeof dbPathOrDb === 'string') {
        // Lazy-import to avoid hard dependency when not using FTS
        const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic require returns untyped module
        const BetterSqlite3 = require('better-sqlite3') as any;
        this.db = new BetterSqlite3(dbPathOrDb) as DatabaseInstance;
        this.db!.pragma('journal_mode = WAL');
      } else {
        this.db = dbPathOrDb;
      }
      this.initFts();
      this.reindex();
    }
  }

  private initFts(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        filename,
        line_number,
        content,
        tokenize='porter unicode61'
      )
    `);
  }

  /** Reindex all .md files into the FTS5 table. */
  reindex(): void {
    if (!this.db) return;
    const files = this.listAllMd();
    this.db.exec('DELETE FROM memory_fts');
    const insert = this.db.prepare(
      'INSERT INTO memory_fts (filename, line_number, content) VALUES (?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const filepath of files) {
        const content = readFileSync(filepath, 'utf-8');
        const lines = content.split('\n');
        const relPath = relative(this.memoryDir, filepath);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim()) {
            insert.run(relPath, String(i + 1), lines[i]);
          }
        }
      }
    });
    tx();
  }

  list(): string[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
  }

  async listAsync(): Promise<string[]> {
    try {
      const entries = await readdir(this.memoryDir);
      return entries.filter(f => f.endsWith('.md'));
    } catch {
      return [];
    }
  }

  read(filename: string): string | null {
    const filepath = join(this.memoryDir, filename);
    if (!existsSync(filepath)) return null;
    return readFileSync(filepath, 'utf-8');
  }

  async readAsync(filename: string): Promise<string | null> {
    const filepath = join(this.memoryDir, filename);
    try {
      return await readFile(filepath, 'utf-8');
    } catch {
      return null;
    }
  }

  write(filename: string, content: string): void {
    mkdirSync(this.memoryDir, { recursive: true });
    writeFileSync(join(this.memoryDir, filename), content);
    this.reindexFile(filename, content);
  }

  async writeAsync(filename: string, content: string): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(join(this.memoryDir, filename), content);
    this.reindexFile(filename, content);
  }

  /** Incrementally reindex a single file in the FTS5 table. */
  private reindexFile(filename: string, content: string): void {
    if (!this.db) return;
    const relPath = filename; // already relative for direct writes
    this.db.exec(`DELETE FROM memory_fts WHERE filename = '${relPath.replace(/'/g, "''")}'`);
    const insert = this.db.prepare(
      'INSERT INTO memory_fts (filename, line_number, content) VALUES (?, ?, ?)',
    );
    const lines = content.split('\n');
    const tx = this.db.transaction(() => {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          insert.run(relPath, String(i + 1), lines[i]);
        }
      }
    });
    tx();
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
   * FTS5-powered search with bm25 ranking.
   * Returns matching snippets with context lines.
   */
  searchFts(query: string, limit = 20): MemorySearchResult[] {
    if (!this.db) return [];
    // Sanitize query for FTS5: escape double quotes, wrap terms
    const sanitized = query
      .replace(/"/g, '""')
      .split(/\s+/)
      .filter(Boolean)
      .map(term => `"${term}"`)
      .join(' ');
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT filename, line_number, content
         FROM memory_fts
         WHERE content MATCH ?
         ORDER BY bm25(memory_fts)
         LIMIT ?`,
      )
      .all(sanitized, limit) as { filename: string; line_number: string; content: string }[];

    // Build snippets with ±1 line context
    return rows.map(row => {
      const lineNum = parseInt(row.line_number, 10);
      const filepath = join(this.memoryDir, row.filename);
      let snippet = row.content;
      try {
        const lines = readFileSync(filepath, 'utf-8').split('\n');
        const start = Math.max(0, lineNum - 2); // -1 for 0-index, -1 for context
        const end = Math.min(lines.length, lineNum + 1); // +1 for context
        snippet = lines.slice(start, end).join('\n');
      } catch {
        // file may have been deleted; use indexed content
      }
      return { filename: row.filename, line: lineNum, snippet };
    });
  }

  /**
   * Full-text search across all memory/*.md and memory/**\/*.md files.
   * Uses FTS5 when available, falls back to substring grep.
   */
  search(query: string, limit?: number): MemorySearchResult[] {
    if (this.db) {
      return this.searchFts(query, limit);
    }
    return this.searchGrep(query);
  }

  /** Get today's daily log filename */
  getDailyLogFilename(): string {
    return new Date().toISOString().split('T')[0] + '.md';
  }

  /** Append to today's daily log (append-only!) */
  appendDailyLog(entry: string): void {
    const filename = this.getDailyLogFilename();
    const existing = this.read(filename) ?? `# ${this.getDailyLogFilename().replace('.md', '')}\n\n`;
    const timestamp = new Date().toISOString().slice(11, 19) + 'Z';
    this.write(filename, existing + `\n[${timestamp}] ${entry}\n`);
  }

  /** Read recent daily logs (today + yesterday) */
  readRecentLogs(): { today: string | null; yesterday: string | null } {
    const today = this.getDailyLogFilename();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0] + '.md';
    return {
      today: this.read(today),
      yesterday: this.read(yesterday),
    };
  }

  /** Archive daily logs older than N days by moving to archive/ subdir */
  archiveOldLogs(daysToKeep: number = 7): number {
    const archiveDir = join(this.memoryDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    const cutoff = Date.now() - daysToKeep * 86400000;
    let archived = 0;
    if (!existsSync(this.memoryDir)) return 0;
    for (const entry of readdirSync(this.memoryDir)) {
      if (!datePattern.test(entry)) continue;
      const dateStr = entry.replace('.md', '');
      const fileDate = new Date(dateStr + 'T00:00:00Z').getTime();
      if (fileDate < cutoff) {
        const src = join(this.memoryDir, entry);
        const dest = join(archiveDir, entry);
        const content = readFileSync(src, 'utf-8');
        writeFileSync(dest, content);
        unlinkSync(src);
        archived++;
      }
    }
    return archived;
  }

  /** Get MEMORY.md size in lines for budget awareness */
  getMemorySize(): { lines: number; bytes: number } | null {
    const content = this.read('MEMORY.md');
    if (!content) return null;
    return { lines: content.split('\n').length, bytes: Buffer.byteLength(content) };
  }

  /** Original grep-based search (fallback). */
  private searchGrep(query: string): MemorySearchResult[] {
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

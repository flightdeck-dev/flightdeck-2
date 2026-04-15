import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { FD_HOME } from '../cli/constants.js';
import { sessions } from '../db/schema.js';
import type { FlightdeckDatabase } from '../db/database.js';

export interface SessionEntry {
  id: string;
  cwd: string;
  projectName: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionEvent {
  role: 'user' | 'agent';
  content: string;
  ts: number;
}

export class SessionStore {
  private baseDir: string;
  private db: FlightdeckDatabase;

  constructor(projectName: string, db: FlightdeckDatabase) {
    this.baseDir = path.join(FD_HOME, 'projects', projectName, 'sessions');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.db = db;
    this.ensureTable();
    this.migrateFromJson();
  }

  /** Create the sessions table if it doesn't exist (runtime migration). */
  private ensureTable(): void {
    this.db.run(sql.raw(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      project_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    )`));
    this.db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name)`));
  }

  /** Migrate legacy index.json into SQLite if it exists. */
  private migrateFromJson(): void {
    const indexPath = path.join(this.baseDir, 'index.json');
    if (!fs.existsSync(indexPath)) return;
    try {
      const entries: SessionEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(entries) && entries.length > 0) {
        for (const entry of entries) {
          // Skip if already exists
          const existing = this.db.select().from(sessions).where(eq(sessions.id, entry.id)).get();
          if (!existing) {
            this.db.insert(sessions).values({
              id: entry.id,
              cwd: entry.cwd,
              projectName: entry.projectName,
              createdAt: entry.createdAt,
              lastActiveAt: entry.lastActiveAt,
            }).run();
          }
        }
      }
      // Remove legacy file after successful migration
      fs.unlinkSync(indexPath);
      // Also remove tmp file if it exists
      try { fs.unlinkSync(indexPath + '.tmp'); } catch { /* ignore */ }
    } catch {
      // Corrupted index.json — just ignore
    }
  }

  private eventLogPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  private rowToEntry(row: typeof sessions.$inferSelect): SessionEntry {
    return {
      id: row.id,
      cwd: row.cwd,
      projectName: row.projectName,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
    };
  }

  createSession(projectName: string, cwd: string): SessionEntry {
    const entry: SessionEntry = {
      id: randomUUID(),
      cwd,
      projectName,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    this.db.insert(sessions).values({
      id: entry.id,
      cwd: entry.cwd,
      projectName: entry.projectName,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
    }).run();
    // Create empty JSONL
    fs.writeFileSync(this.eventLogPath(entry.id), '');
    return entry;
  }

  getSession(sessionId: string): SessionEntry | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    return row ? this.rowToEntry(row) : undefined;
  }

  listSessions(projectName: string): SessionEntry[] {
    return this.db.select().from(sessions)
      .where(eq(sessions.projectName, projectName))
      .all()
      .map(r => this.rowToEntry(r));
  }

  /** List all sessions regardless of project. */
  listAll(): SessionEntry[] {
    return this.db.select().from(sessions).all().map(r => this.rowToEntry(r));
  }

  appendEvent(sessionId: string, event: SessionEvent): void {
    fs.appendFileSync(this.eventLogPath(sessionId), JSON.stringify(event) + '\n');
  }

  readEvents(sessionId: string): SessionEvent[] {
    try {
      const content = fs.readFileSync(this.eventLogPath(sessionId), 'utf-8').trim();
      if (!content) return [];
      return content.split('\n').map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  updateLastActive(sessionId: string): void {
    this.db.update(sessions)
      .set({ lastActiveAt: new Date().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  /**
   * Search across all session event logs for matching content.
   * Returns matching events with session context.
   */
  searchEvents(query: string, opts: { limit?: number } = {}): Array<{ sessionId: string; projectName: string; role: string; content: string; ts: number }> {
    const limit = opts.limit ?? 20;
    const lowerQuery = query.toLowerCase();
    const results: Array<{ sessionId: string; projectName: string; role: string; content: string; ts: number }> = [];
    const entries = this.listAll();

    for (const entry of entries) {
      if (results.length >= limit) break;
      const events = this.readEvents(entry.id);
      for (const event of events) {
        if (results.length >= limit) break;
        if (event.content.toLowerCase().includes(lowerQuery)) {
          results.push({
            sessionId: entry.id,
            projectName: entry.projectName,
            role: event.role,
            content: event.content.length > 500 ? event.content.slice(0, 500) + '...' : event.content,
            ts: event.ts,
          });
        }
      }
    }
    return results;
  }
}

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

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

  constructor(projectName: string) {
    this.baseDir = path.join(homedir(), '.flightdeck', 'projects', projectName, 'sessions');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private indexPath(): string {
    return path.join(this.baseDir, 'index.json');
  }

  private eventLogPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  private readIndex(): SessionEntry[] {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath(), 'utf-8'));
    } catch {
      return [];
    }
  }

  private writeIndex(entries: SessionEntry[]): void {
    const tmp = this.indexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, this.indexPath());
  }

  createSession(projectName: string, cwd: string): SessionEntry {
    const entry: SessionEntry = {
      id: randomUUID(),
      cwd,
      projectName,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    const entries = this.readIndex();
    entries.push(entry);
    this.writeIndex(entries);
    // Create empty JSONL
    fs.writeFileSync(this.eventLogPath(entry.id), '');
    return entry;
  }

  getSession(sessionId: string): SessionEntry | undefined {
    return this.readIndex().find(e => e.id === sessionId);
  }

  listSessions(projectName: string): SessionEntry[] {
    return this.readIndex().filter(e => e.projectName === projectName);
  }

  /** List all sessions regardless of project. */
  listAll(): SessionEntry[] {
    return this.readIndex();
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
    const entries = this.readIndex();
    const entry = entries.find(e => e.id === sessionId);
    if (entry) {
      entry.lastActiveAt = new Date().toISOString();
      this.writeIndex(entries);
    }
  }
}

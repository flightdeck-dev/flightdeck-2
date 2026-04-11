// Database initialization and connection
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type FlightdeckDB = ReturnType<typeof createDatabase>;

export function createDatabase(path: string = ':memory:') {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      role TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '[]',
      depends_on TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      spec_requirement_id TEXT,
      plan_id TEXT,
      assigned_agent TEXT,
      model TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      compacted INTEGER NOT NULL DEFAULT 0,
      compacted_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS specs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      requirements TEXT NOT NULL DEFAULT '[]',
      user_scenarios TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      diff TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      title TEXT NOT NULL,
      task_ids TEXT NOT NULL DEFAULT '[]',
      requirement_mapping TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      from_agent TEXT NOT NULL,
      to_agents TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      thread_id TEXT,
      reply_to TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL,
      read_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      capabilities TEXT NOT NULL DEFAULT '[]',
      cost_accumulated REAL NOT NULL DEFAULT 0,
      last_heartbeat TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 1,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      await_type TEXT NOT NULL,
      await_id TEXT NOT NULL,
      timeout INTEGER,
      cleared INTEGER NOT NULL DEFAULT 0,
      cleared_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      writer_agent TEXT NOT NULL,
      writer_model TEXT NOT NULL,
      reviewer_agent TEXT,
      reviewer_model TEXT,
      verdict TEXT,
      comments TEXT NOT NULL DEFAULT '[]',
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_gates_task ON gates(task_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
  `);

  return db;
}

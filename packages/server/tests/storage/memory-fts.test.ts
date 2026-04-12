import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../../src/storage/MemoryStore.js';

describe('MemoryStore FTS5', () => {
  let tmpDir: string;
  let memDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-fts-'));
    memDir = join(tmpDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    db = new Database(join(tmpDir, 'test.sqlite'));
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedFiles() {
    writeFileSync(join(memDir, 'notes.md'), [
      '# Project Notes',
      'Deploy the application to production server.',
      'Run database migrations before deployment.',
      '',
      '## Security',
      'Enable two-factor authentication for all users.',
    ].join('\n'));
    writeFileSync(join(memDir, 'todo.md'), [
      '- Fix deployment pipeline',
      '- Review pull requests',
      '- Update documentation for API changes',
    ].join('\n'));
  }

  it('indexes .md files and returns search results', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.search('deployment');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toMatch(/\.md$/);
    expect(results[0].snippet).toBeTruthy();
  });

  it('returns ranked results using bm25', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.search('deploy');
    // Should find at least one match
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Results should be ranked (first result most relevant)
    expect(results[0].snippet).toBeTruthy();
  });

  it('supports prefix queries', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.searchFts('deploy*');
    expect(results.length).toBeGreaterThan(0);
  });

  it('reindexes after write', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const before = store.search('kubernetes');
    expect(before.length).toBe(0);

    store.write('infra.md', 'Deploy to kubernetes cluster\nScale pods to 3 replicas');
    const after = store.search('kubernetes');
    expect(after.length).toBe(1);
  });

  it('falls back to grep when no DB provided', () => {
    seedFiles();
    const store = new MemoryStore(memDir);
    const results = store.search('deploy');
    expect(results.length).toBeGreaterThan(0);
    // Grep fallback should still work
    expect(results[0].snippet).toContain('deploy');
  });

  it('returns empty for no matches', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.search('zzzznonexistent');
    expect(results.length).toBe(0);
  });

  it('returns empty for empty query', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.search('');
    expect(results.length).toBe(0);
  });

  it('returns snippets with context lines', () => {
    seedFiles();
    const store = new MemoryStore(memDir, db);
    const results = store.search('migrations');
    expect(results.length).toBe(1);
    // Should have context: line before + match + line after
    const lines = results[0].snippet.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('handles subdirectories', () => {
    mkdirSync(join(memDir, 'sub'), { recursive: true });
    writeFileSync(join(memDir, 'sub', 'deep.md'), 'Nested document content here');
    const store = new MemoryStore(memDir, db);
    const results = store.search('nested');
    expect(results.length).toBe(1);
    expect(results[0].filename).toBe(join('sub', 'deep.md'));
  });

  it('respects limit parameter', () => {
    // Create many matching lines
    const lines = Array.from({ length: 50 }, (_, i) => `Item ${i} deploy now`);
    writeFileSync(join(memDir, 'big.md'), lines.join('\n'));
    const store = new MemoryStore(memDir, db);
    const results = store.search('deploy', 5);
    expect(results.length).toBe(5);
  });
});

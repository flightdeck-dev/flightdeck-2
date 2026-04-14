import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/storage/MemoryStore.js';
import { buildMemoryContext } from '../../src/agents/AgentManager.js';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `fd-memory-test-${Date.now()}`);

describe('MemoryStore - daily logs & memory helpers', () => {
  let store: MemoryStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new MemoryStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('getDailyLogFilename returns YYYY-MM-DD.md', () => {
    const filename = store.getDailyLogFilename();
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('appendDailyLog creates file and appends with timestamp', () => {
    store.appendDailyLog('first entry');
    const filename = store.getDailyLogFilename();
    const content = store.read(filename)!;
    expect(content).toContain('first entry');
    expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}Z\]/);

    // Append again — should not overwrite
    store.appendDailyLog('second entry');
    const content2 = store.read(filename)!;
    expect(content2).toContain('first entry');
    expect(content2).toContain('second entry');
  });

  it('readRecentLogs returns today and yesterday', () => {
    const todayFile = store.getDailyLogFilename();
    store.write(todayFile, '# Today\nSome content');

    const logs = store.readRecentLogs();
    expect(logs.today).toContain('Some content');
    // Yesterday likely doesn't exist in test
    expect(logs.yesterday).toBeNull();
  });

  it('archiveOldLogs moves old files to archive/', () => {
    // Create a "old" daily log
    const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] + '.md';
    store.write(oldDate, '# Old log');
    // Create today's log
    store.appendDailyLog('today entry');

    const archived = store.archiveOldLogs(7);
    expect(archived).toBe(1);
    expect(existsSync(join(TEST_DIR, oldDate))).toBe(false);
    expect(existsSync(join(TEST_DIR, 'archive', oldDate))).toBe(true);
    // Today's log should still be there
    expect(store.read(store.getDailyLogFilename())).toBeTruthy();
  });

  it('getMemorySize returns line and byte count', () => {
    expect(store.getMemorySize()).toBeNull();

    store.write('MEMORY.md', 'line1\nline2\nline3\n');
    const size = store.getMemorySize()!;
    expect(size.lines).toBe(4); // trailing newline creates empty last element
    expect(size.bytes).toBeGreaterThan(0);
  });
});

describe('buildMemoryContext', () => {
  const memDir = join(tmpdir(), `fd-memctx-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  it('returns empty string when no memory files exist', () => {
    expect(buildMemoryContext(memDir)).toBe('');
  });

  it('includes SOUL.md, USER.md, MEMORY.md when present', () => {
    writeFileSync(join(memDir, 'SOUL.md'), '# Soul content');
    writeFileSync(join(memDir, 'USER.md'), '# User prefs');
    writeFileSync(join(memDir, 'MEMORY.md'), '# Memory');

    const ctx = buildMemoryContext(memDir);
    expect(ctx).toContain('## Project Memory');
    expect(ctx).toContain('### SOUL.md');
    expect(ctx).toContain('Soul content');
    expect(ctx).toContain('### USER.md');
    expect(ctx).toContain('### MEMORY.md');
  });

  it('truncates MEMORY.md over 300 lines', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}`).join('\n');
    writeFileSync(join(memDir, 'MEMORY.md'), lines);

    const ctx = buildMemoryContext(memDir);
    expect(ctx).toContain('truncated to last 200 lines');
    expect(ctx).toContain('Line 400');
    expect(ctx).not.toContain('Line 1\n');
  });

  it('includes today daily log if present', () => {
    const today = new Date().toISOString().split('T')[0] + '.md';
    writeFileSync(join(memDir, today), '# Today\nDid stuff');

    const ctx = buildMemoryContext(memDir);
    expect(ctx).toContain('Did stuff');
    expect(ctx).toContain('Today');
  });
});

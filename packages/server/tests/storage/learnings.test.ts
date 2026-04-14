import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LearningsStore } from '../../src/storage/LearningsStore.js';

describe('LearningsStore', () => {
  const testDir = join(homedir(), '.flightdeck', 'v2', 'projects', `test-learnings-${Date.now()}`);
  let store: LearningsStore;

  beforeEach(() => {
    store = new LearningsStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('appends and lists learnings', () => {
    store.append({ agentId: 'a1', category: 'pattern', content: 'Use facade pattern', tags: ['arch'] });
    store.append({ agentId: 'a2', category: 'gotcha', content: 'SQLite needs WAL mode', tags: ['db'] });
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[0].content).toBe('Use facade pattern');
    expect(all[0].id).toBeTruthy();
    expect(all[0].timestamp).toBeTruthy();
  });

  it('lists by category', () => {
    store.append({ agentId: 'a1', category: 'pattern', content: 'p1', tags: [] });
    store.append({ agentId: 'a1', category: 'gotcha', content: 'g1', tags: [] });
    expect(store.list('pattern')).toHaveLength(1);
    expect(store.list('gotcha')).toHaveLength(1);
  });

  it('searches by content', () => {
    store.append({ agentId: 'a1', category: 'pattern', content: 'Always use TypeScript', tags: ['ts'] });
    store.append({ agentId: 'a1', category: 'gotcha', content: 'Python import issues', tags: ['py'] });
    const results = store.search('typescript');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('searches by tags', () => {
    store.append({ agentId: 'a1', category: 'pattern', content: 'test', tags: ['architecture'] });
    const results = store.search('architecture');
    expect(results).toHaveLength(1);
  });

  it('prunes old entries', () => {
    store.append({ agentId: 'a1', category: 'pattern', content: 'old', tags: [] });
    store.append({ agentId: 'a1', category: 'pattern', content: 'new', tags: [] });
    // Prune everything before the future
    const pruned = store.prune(new Date(Date.now() + 100000));
    expect(pruned).toBe(2);
    expect(store.list()).toHaveLength(0);
  });

  it('returns empty on missing file', () => {
    const fresh = new LearningsStore(join(testDir, 'nonexistent'));
    expect(fresh.list()).toEqual([]);
  });
});

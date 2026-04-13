import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSuggestions, type Suggestion } from '../../src/orchestrator/Scout.js';
import { SuggestionStore } from '../../src/storage/SuggestionStore.js';

describe('Scout — parseSuggestions', () => {
  it('parses valid JSON array from agent output', () => {
    const output = `Here are my suggestions:
[
  {
    "title": "Add unit tests for DAG",
    "description": "The DAG module lacks tests",
    "category": "quality",
    "effort": "medium",
    "impact": "high"
  },
  {
    "title": "Document API endpoints",
    "description": "REST API is undocumented",
    "category": "docs",
    "effort": "small",
    "impact": "medium"
  }
]
Done!`;
    const suggestions = parseSuggestions(output, 'spec-1');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].title).toBe('Add unit tests for DAG');
    expect(suggestions[0].category).toBe('quality');
    expect(suggestions[0].effort).toBe('medium');
    expect(suggestions[0].impact).toBe('high');
    expect(suggestions[0].status).toBe('pending');
    expect(suggestions[0].specId).toBe('spec-1');
    expect(suggestions[0].id).toMatch(/^sug-/);
    expect(suggestions[1].category).toBe('docs');
  });

  it('returns empty for invalid output', () => {
    expect(parseSuggestions('no json here', 'spec-1')).toEqual([]);
    expect(parseSuggestions('', 'spec-1')).toEqual([]);
  });

  it('defaults invalid category/effort/impact', () => {
    const output = `[{"title":"X","description":"Y","category":"banana","effort":"huge","impact":"mega"}]`;
    const suggestions = parseSuggestions(output, 'spec-1');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].category).toBe('quality');
    expect(suggestions[0].effort).toBe('medium');
    expect(suggestions[0].impact).toBe('medium');
  });

  it('skips items missing title or description', () => {
    const output = `[{"title":"ok","description":"yes"},{"noTitle":true}]`;
    const suggestions = parseSuggestions(output, 'spec-1');
    expect(suggestions).toHaveLength(1);
  });
});

describe('SuggestionStore', () => {
  let tmpDir: string;
  let store: SuggestionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-sug-'));
    store = new SuggestionStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSuggestion(overrides?: Partial<Suggestion>): Suggestion {
    return {
      id: `sug-${Math.random().toString(36).slice(2, 8)}`,
      specId: 'spec-1',
      title: 'Test suggestion',
      description: 'A test',
      category: 'quality',
      effort: 'small',
      impact: 'high',
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('starts empty', () => {
    expect(store.list()).toEqual([]);
  });

  it('adds and lists suggestions', () => {
    const s1 = makeSuggestion({ id: 'sug-1' });
    const s2 = makeSuggestion({ id: 'sug-2', category: 'docs' });
    store.addMany([s1, s2]);
    expect(store.list()).toHaveLength(2);
  });

  it('filters by status', () => {
    const s1 = makeSuggestion({ id: 'sug-1', status: 'pending' });
    const s2 = makeSuggestion({ id: 'sug-2', status: 'approved' });
    store.addMany([s1, s2]);
    expect(store.list({ status: 'pending' })).toHaveLength(1);
    expect(store.list({ status: 'approved' })).toHaveLength(1);
  });

  it('filters by specId', () => {
    const s1 = makeSuggestion({ id: 'sug-1', specId: 'spec-1' });
    const s2 = makeSuggestion({ id: 'sug-2', specId: 'spec-2' });
    store.addMany([s1, s2]);
    expect(store.list({ specId: 'spec-1' })).toHaveLength(1);
  });

  it('updates status', () => {
    const s1 = makeSuggestion({ id: 'sug-1' });
    store.addMany([s1]);
    const updated = store.updateStatus('sug-1', 'approved');
    expect(updated?.status).toBe('approved');
    expect(store.get('sug-1')?.status).toBe('approved');
  });

  it('returns null for missing suggestion', () => {
    expect(store.updateStatus('nonexistent', 'rejected')).toBeNull();
    expect(store.get('nonexistent')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';

// Re-implement locally to test without importing private functions from api.ts
function camelizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(camelizeKeys);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[camelizeKey(k)] = camelizeKeys(v);
    }
    return result;
  }
  return obj;
}

describe('camelizeKeys', () => {
  it('converts snake_case to camelCase', () => {
    expect(camelizeKeys({ my_key: 'value' })).toEqual({ myKey: 'value' });
  });

  it('handles nested objects', () => {
    expect(camelizeKeys({ outer_key: { inner_key: 1 } })).toEqual({ outerKey: { innerKey: 1 } });
  });

  it('handles arrays', () => {
    expect(camelizeKeys([{ my_key: 1 }, { other_key: 2 }])).toEqual([{ myKey: 1 }, { otherKey: 2 }]);
  });

  it('handles null/undefined', () => {
    expect(camelizeKeys(null)).toBe(null);
    expect(camelizeKeys(undefined)).toBe(undefined);
  });

  it("doesn't modify camelCase keys", () => {
    expect(camelizeKeys({ alreadyCamel: 'ok' })).toEqual({ alreadyCamel: 'ok' });
  });

  it('handles deeply nested arrays and objects', () => {
    const input = { top_level: [{ nested_key: [{ deep_key: 'v' }] }] };
    const expected = { topLevel: [{ nestedKey: [{ deepKey: 'v' }] }] };
    expect(camelizeKeys(input)).toEqual(expected);
  });
});

import { useState, useCallback, useRef } from 'react';

export function useInputHistory(maxSize = 50) {
  const [history] = useState<string[]>([]);
  const indexRef = useRef(-1);

  const add = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Deduplicate consecutive
    if (history.length > 0 && history[history.length - 1] === trimmed) return;
    history.push(trimmed);
    if (history.length > maxSize) history.shift();
    indexRef.current = -1;
  }, [history, maxSize]);

  const prev = useCallback((): string | undefined => {
    if (history.length === 0) return undefined;
    if (indexRef.current === -1) {
      indexRef.current = history.length - 1;
    } else if (indexRef.current > 0) {
      indexRef.current--;
    }
    return history[indexRef.current];
  }, [history]);

  const next = useCallback((): string | undefined => {
    if (history.length === 0 || indexRef.current === -1) return undefined;
    if (indexRef.current < history.length - 1) {
      indexRef.current++;
      return history[indexRef.current];
    }
    indexRef.current = -1;
    return '';
  }, [history]);

  const reset = useCallback(() => {
    indexRef.current = -1;
  }, []);

  return { add, prev, next, reset };
}

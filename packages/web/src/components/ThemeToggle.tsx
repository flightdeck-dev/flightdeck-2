import { useEffect, useState, useCallback } from 'react';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem('flightdeck:theme');
      return stored ? stored === 'dark' : true;
    } catch { return true; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('flightdeck:theme', dark ? 'dark' : 'light'); } catch {}
  }, [dark]);

  const toggle = useCallback(() => setDark(d => !d), []);

  return (
    <button
      onClick={toggle}
      className="p-2 rounded-lg hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] transition-colors"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

function getSystemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function applyTheme(theme: Theme): void {
  const isDark = theme === 'system' ? getSystemDark() : theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('flightdeck:theme') as Theme) ?? 'system';
    } catch { return 'system'; }
  });

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem('flightdeck:theme', theme); } catch {}

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme(t => t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system');
  }, []);

  const icon = theme === 'system' ? <Monitor size={16} strokeWidth={1.5} />
    : theme === 'dark' ? <Sun size={16} strokeWidth={1.5} />
    : <Moon size={16} strokeWidth={1.5} />;

  const label = theme === 'system' ? 'System theme'
    : theme === 'dark' ? 'Switch to light'
    : 'Switch to dark';

  return (
    <button
      onClick={cycle}
      className="w-8 h-8 flex items-center justify-center rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
      title={label}
    >
      {icon}
    </button>
  );
}

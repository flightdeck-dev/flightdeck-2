import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { Sidebar } from './Sidebar.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { DisplaySettings } from './DisplaySettings.tsx';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { projectName } = useParams();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const prefix = projectName ? `/${encodeURIComponent(projectName)}` : '';
  const COMMANDS = [
    ...(projectName ? [
      { label: 'Go to Dashboard', path: `${prefix}`, keys: ['g', 'd'] },
      { label: 'Go to Chat', path: `${prefix}/chat`, keys: ['g', 'c'] },
      { label: 'Go to Tasks', path: `${prefix}/tasks`, keys: ['g', 't'] },
      { label: 'Go to Agents', path: `${prefix}/agents`, keys: ['g', 'a'] },
      { label: 'Go to Decisions', path: `${prefix}/decisions`, keys: ['g', 'e'] },
    ] : []),
    { label: 'Go to Settings', path: '/settings', keys: ['g', '⚙'] },
  ];

  const filtered = COMMANDS.filter(c =>
    c.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (path: string) => {
    navigate(path);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden"
           onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && filtered.length > 0) handleSelect(filtered[0].path);
            }}
            placeholder="Type a command..."
            className="w-full bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none" />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.map(c => (
            <button key={c.path} onClick={() => handleSelect(c.path)}
              className="w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors flex items-center justify-between">
              <span>{c.label}</span>
              <kbd className="text-xs text-[var(--color-text-tertiary)] font-mono">{c.keys.join(' ')}</kbd>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-sm text-[var(--color-text-tertiary)] text-center">No commands found</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed(c => !c), []);

  // Auto-collapse on narrow viewport
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const toggleDisplaySettings = useCallback(() => setShowDisplaySettings(s => !s), []);
  const closeDisplaySettings = useCallback(() => setShowDisplaySettings(false), []);
  const { status, connected, projectName } = useFlightdeck();

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowPalette(p => !p);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <header className="h-12 flex items-center justify-between px-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-text-primary)] text-sm font-mono font-semibold">
            Flightdeck <span className="text-[var(--color-text-tertiary)] opacity-60 font-normal">v2.0.0-alpha</span>
          </span>
          <span className="text-[var(--color-border)]">·</span>
          <span className="text-[var(--color-text-tertiary)] text-sm font-mono">
            {projectName ?? status?.config?.name ?? ''}
          </span>
          {status && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              {status.config.governance}
            </span>
          )}
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
                title={connected ? 'Connected' : 'Disconnected'} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPalette(true)}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] transition-colors">
            <span>Search</span>
            <kbd className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">⌘K</kbd>
          </button>
          <button
            onClick={toggleDisplaySettings}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
            title="Display settings"
          >
            <Settings size={16} strokeWidth={1.5} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {showDisplaySettings && <DisplaySettings onClose={closeDisplaySettings} />}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        <main className="flex-1 overflow-y-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

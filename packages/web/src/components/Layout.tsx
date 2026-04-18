import { useState, useCallback, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { Sidebar } from './Sidebar.tsx';
import { SectionErrorBoundary } from './ErrorBoundary.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { DisplaySettings } from './DisplaySettings.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import { useProject } from '../hooks/useProject.tsx';

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
  const { status, connected, projectName } = useProject();

  // Gateway health check (independent of project WebSocket)
  const [gatewayOnline, setGatewayOnline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch('/health').then(r => { if (!cancelled) setGatewayOnline(r.ok); }).catch(() => { if (!cancelled) setGatewayOnline(false); });
    };
    check();
    const interval = setInterval(check, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

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
          {projectName && (
            <>
              <span className="text-[var(--color-border)]">·</span>
              <span className="text-[var(--color-text-tertiary)] text-sm font-mono">
                {projectName ?? status?.config?.name ?? ''}
              </span>
            </>
          )}
          {status && (
            <div className="relative">
              <select
                value={status.config.governance}
                onChange={async (e) => {
                  try {
                    await fetch(`/api/projects/${encodeURIComponent(projectName ?? '')}/config`, {
                      method: 'PUT', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ governance: e.target.value }),
                    });
                  } catch {}
                }}
                className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer appearance-none pr-5 focus:outline-none"
              >
                <option value="autonomous">autonomous</option>
                <option value="supervised">supervised</option>
                <option value="collaborative">collaborative</option>
              </select>
              <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] text-[var(--color-text-tertiary)] pointer-events-none">▾</span>
            </div>
          )}
          {projectName && (
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
                  title={connected ? 'Connected' : 'Disconnected'} />
          )}
          {!projectName && (
            <span className={`w-2 h-2 rounded-full ${gatewayOnline ? 'bg-green-500' : 'bg-red-500'}`}
                  title={gatewayOnline ? 'Gateway online' : 'Gateway offline'} />
          )}
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
      {showPalette && <SearchDialog onClose={() => setShowPalette(false)} />}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        <main className="flex-1 overflow-y-auto p-8">
          <SectionErrorBoundary>
            <Outlet />
          </SectionErrorBoundary>
        </main>
      </div>
    </div>
  );
}

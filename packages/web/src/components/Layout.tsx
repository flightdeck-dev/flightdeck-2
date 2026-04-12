import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { DisplaySettings } from './DisplaySettings.tsx';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);
  const { status, connected } = useFlightdeck();

  return (
    <div className="h-screen flex flex-col">
      <header className="h-12 flex items-center justify-between px-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-text-tertiary)] text-sm font-mono">
            {status?.config?.name ?? '...'}
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
          <button
            onClick={() => setShowDisplaySettings(!showDisplaySettings)}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
            title="Display settings"
          >
            ⚙
          </button>
          <ThemeToggle />
        </div>
      </header>

      {showDisplaySettings && <DisplaySettings onClose={() => setShowDisplaySettings(false)} />}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        <main className="flex-1 overflow-y-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

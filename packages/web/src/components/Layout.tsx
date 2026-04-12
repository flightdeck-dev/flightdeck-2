import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useFlightdeck } from '../hooks/useFlightdeck.ts';

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const data = useFlightdeck();

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-text-tertiary)] text-sm font-mono">
            {data.project?.name ?? '...'}
          </span>
          {data.project && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              {data.project.governance}
            </span>
          )}
        </div>
        <ThemeToggle />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        <main className="flex-1 overflow-y-auto p-8">
          <Outlet context={data} />
        </main>
      </div>
    </div>
  );
}

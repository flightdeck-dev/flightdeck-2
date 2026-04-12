import { NavLink } from 'react-router-dom';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  badge?: () => string | number | null;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { tasks, agents } = useFlightdeck();

  const activeTasks = tasks.filter(t => t.state === 'running' || t.state === 'ready' || t.state === 'in_review').length;
  const activeAgents = agents.filter(a => a.status !== 'terminated' && a.status !== 'ended').length;
  const busyAgents = agents.filter(a => a.status === 'busy' || a.status === 'working').length;

  const NAV_ITEMS: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: '◻' },
    { to: '/chat', label: 'Chat', icon: '💬', badge: () => null },
    { to: '/tasks', label: 'Tasks', icon: '☰', badge: () => activeTasks || null },
    { to: '/agents', label: 'Agents', icon: '●', badge: () => activeAgents || null },
    { to: '/specs', label: 'Specs', icon: '◇' },
    { to: '/decisions', label: 'Decisions', icon: '⚖' },
    { to: '/settings', label: 'Settings', icon: '⚙' },
  ];

  return (
    <aside
      className={`flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] transition-all duration-200 ${
        collapsed ? 'w-12' : 'w-56'
      }`}
    >
      <div className="flex items-center gap-2 px-3 h-12 border-b border-[var(--color-border)]">
        <button
          onClick={onToggle}
          className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] text-sm"
        >
          {collapsed ? '▶' : '◀'}
        </button>
        {!collapsed && (
          <span className="font-semibold text-sm text-[var(--color-text-primary)] truncate">
            Flightdeck
          </span>
        )}
      </div>

      <nav className="flex-1 py-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const badgeValue = item.badge?.();
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`
              }
            >
              <span className="w-5 text-center text-xs">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {badgeValue != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-status-ready)] text-white font-medium min-w-[18px] text-center">
                      {badgeValue}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Agent status summary */}
      {!collapsed && activeAgents > 0 && (
        <div className="px-3 py-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-running)] animate-pulse" />
            <span>{busyAgents} busy</span>
            <span className="text-[var(--color-text-tertiary)]">·</span>
            <span>{activeAgents - busyAgents} idle</span>
          </div>
        </div>
      )}
    </aside>
  );
}

import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '◻' },
  { to: '/chat', label: 'Chat', icon: '💬' },
  { to: '/tasks', label: 'Tasks', icon: '☰' },
  { to: '/agents', label: 'Agents', icon: '●' },
  { to: '/specs', label: 'Specs', icon: '◇' },
  { to: '/decisions', label: 'Decisions', icon: '⚖' },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
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
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
                isActive
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`
            }
          >
            <span className="w-5 text-center text-xs">{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

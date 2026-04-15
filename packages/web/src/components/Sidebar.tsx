import { NavLink, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { ProjectSummary } from '../lib/types.ts';
import { Folder, LayoutDashboard, MessageSquare, ListTodo, Bot, Scale, Settings, ChevronDown, ChevronRight, PanelLeftClose, PanelLeft } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

interface SubNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

const PROJECT_NAV: SubNavItem[] = [
  { path: '', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/chat', label: 'Chat', icon: MessageSquare },
  { path: '/tasks', label: 'Tasks', icon: ListTodo },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/decisions', label: 'Decisions', icon: Scale },
];

function ProjectItem({ project, isActive, collapsed }: { project: ProjectSummary; isActive: boolean; collapsed: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const { projectName } = useParams();
  const activeTasks = (project.taskStats?.running ?? 0) + (project.taskStats?.ready ?? 0) + (project.taskStats?.in_review ?? 0);

  // Auto-expand active project
  if (isActive && !expanded) setExpanded(true);

  if (collapsed) {
    return (
      <NavLink
        to={`/${encodeURIComponent(project.name)}`}
        className={`flex items-center justify-center mx-1 py-1.5 rounded-md text-sm transition-colors ${
          isActive
            ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
        title={project.name}
      >
        <Folder size={16} strokeWidth={1.5} />
      </NavLink>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(e => !e)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
          isActive
            ? 'text-[var(--color-text-primary)] font-medium'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <span className="w-3 text-center text-[var(--color-text-tertiary)]">
          {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
        </span>
        <span className="flex-1 text-left truncate">{project.name}</span>
        <div className="flex items-center gap-1.5">
          {project.agentCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-status-running)] text-white font-medium min-w-[18px] text-center">
              {project.agentCount}
            </span>
          )}
          {activeTasks > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-status-ready)] text-white font-medium min-w-[18px] text-center">
              {activeTasks}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <nav className="ml-4 mt-0.5 space-y-0.5">
          {PROJECT_NAV.map((item) => (
            <NavLink
              key={item.path}
              to={`/${encodeURIComponent(project.name)}${item.path}`}
              end={item.path === ''}
              className={({ isActive: linkActive }) =>
                `flex items-center gap-2 px-3 py-1 mx-1 rounded-md text-xs transition-colors ${
                  linkActive
                    ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                    : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]'
                }`
              }
            >
              <item.icon size={14} strokeWidth={1.5} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { projects, agents } = useFlightdeck();
  const { projectName } = useParams();

  const activeAgents = agents.filter(a => !['terminated', 'ended', 'offline', 'hibernated', 'retired'].includes(a.status)).length;
  const busyAgents = agents.filter(a => a.status === 'busy' || a.status === 'working').length;

  return (
    <aside
      className={`flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] transition-all duration-200 ${
        collapsed ? 'w-12' : 'w-56'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-12 border-b border-[var(--color-border)]">
        <button
          onClick={onToggle}
          className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] text-sm"
        >
          {collapsed ? <PanelLeft size={16} strokeWidth={1.5} /> : <PanelLeftClose size={16} strokeWidth={1.5} />}
        </button>
        {!collapsed && (
          <span className="font-semibold text-sm text-[var(--color-text-primary)] truncate">
            Flightdeck
          </span>
        )}
      </div>

      {/* Projects */}
      <div className="flex-1 py-2 space-y-0.5 overflow-y-auto">
        {!collapsed && (
          <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium">
            Projects
          </div>
        )}
        {projects.map((project) => (
          <ProjectItem
            key={project.name}
            project={project}
            isActive={projectName === project.name}
            collapsed={collapsed}
          />
        ))}
        {projects.length === 0 && !collapsed && (
          <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
            No projects
          </div>
        )}
      </div>

      {/* Bottom: Settings */}
      <div className="border-t border-[var(--color-border)] py-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
              isActive
                ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
            }`
          }
        >
          <Settings size={16} strokeWidth={1.5} />
          {!collapsed && <span>Settings</span>}
        </NavLink>
      </div>

      {/* Agent status summary */}
      {!collapsed && activeAgents > 0 && (
        <div className="px-3 py-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${busyAgents > 0 ? 'bg-[var(--color-status-running)] animate-pulse' : 'bg-[var(--color-status-ready)]'}`} />
            <span>{busyAgents} busy</span>
            <span className="text-[var(--color-text-tertiary)]">·</span>
            <span>{activeAgents - busyAgents} idle</span>
          </div>
        </div>
      )}
    </aside>
  );
}

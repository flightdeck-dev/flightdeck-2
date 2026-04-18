import { NavLink, useParams, useNavigate } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { useProject } from '../hooks/useProject.tsx';
import { useAgents } from '../hooks/useAgents.tsx';
import { api } from '../lib/api.ts';
import type { ProjectSummary } from '../lib/types.ts';
import { Folder, LayoutDashboard, MessageSquare, ListTodo, Bot, Scale, Settings, ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, Plus, MoreHorizontal, Trash2, Archive, X, Clock, Crown } from 'lucide-react';

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
  { path: '/cron', label: 'Cron', icon: Clock },
  { path: '/roles', label: 'Roles', icon: Crown },
  { path: '/settings', label: 'Settings', icon: Settings },
];

function ProjectItem({ project, isActive, collapsed, onDeleted }: { project: ProjectSummary; isActive: boolean; collapsed: boolean; onDeleted: () => void }) {
  const [expanded, setExpanded] = useState(isActive);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const activeTasks = (project.taskStats?.running ?? 0) + (project.taskStats?.ready ?? 0) + (project.taskStats?.in_review ?? 0);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleDelete = async () => {
    if (!window.confirm(`Delete project "${project.name}"? This permanently removes all data and cannot be undone.`)) return;
    try {
      await api.deleteProject(project.name);
      setMenuOpen(false);
      if (isActive) navigate('/');
      onDeleted();
    } catch (e) {
      alert(`Failed to delete: ${e}`);
    }
  };

  const handleArchive = async () => {
    try {
      await fetch(`/api/projects/${encodeURIComponent(project.name)}/archive`, { method: 'POST' });
      setMenuOpen(false);
      if (isActive) navigate('/');
      onDeleted();
    } catch (e) {
      alert(`Failed to archive: ${e}`);
    }
  };

  // M8: Sync expanded state via useEffect instead of during render to avoid extra re-render
  useEffect(() => {
    if (isActive && !expanded) setExpanded(true);
  }, [isActive]);

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
      <div
        onClick={() => setExpanded(e => !e)}
        role="button"
        className={`group w-full flex items-center gap-2 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors cursor-pointer ${
          isActive
            ? 'text-[var(--color-text-primary)] font-medium'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <span className="w-3 text-center text-[var(--color-text-tertiary)]">
          {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
        </span>
        <span className="flex-1 text-left truncate">{project.name}</span>
        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
          <div className="relative" ref={menuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(m => !m); }}
              className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <MoreHorizontal size={14} strokeWidth={1.5} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md shadow-lg py-1 min-w-[120px]">
                <button
                  onClick={handleArchive}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <Archive size={12} strokeWidth={1.5} />
                  Archive
                </button>
                <button
                  onClick={handleDelete}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                  Delete
                </button>
              </div>
            )}
          </div>
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
      </div>

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
  const { projects, refresh } = useProject();
  const { agents } = useAgents();
  const [archivedProjects, setArchivedProjects] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  // M6: Debounce archived projects fetch — don't refetch on every WS state:update
  const archivedFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (archivedFetchRef.current) clearTimeout(archivedFetchRef.current);
    archivedFetchRef.current = setTimeout(() => {
      fetch('/api/projects/archived').then(r => r.json()).then(d => setArchivedProjects(d.projects ?? [])).catch(() => {});
    }, 500);
    return () => { if (archivedFetchRef.current) clearTimeout(archivedFetchRef.current); };
  }, [projects]);
  const { projectName } = useParams();
  const [showCreate, setShowCreate] = useState(false);

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

      </div>

      {/* Projects */}
      <div className="flex-1 py-2 space-y-0.5 overflow-y-auto">
        {!collapsed && (
          <div className="flex items-center justify-between px-4 py-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium">Projects</span>
            <button
              onClick={() => setShowCreate(true)}
              className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
              title="Create project"
            >
              <Plus size={14} strokeWidth={1.5} />
            </button>
          </div>
        )}
        {projects.map((project) => (
          <ProjectItem
            key={project.name}
            project={project}
            isActive={projectName === project.name}
            collapsed={collapsed}
            onDeleted={refresh}
          />
        ))}
        {projects.length === 0 && !collapsed && (
          <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
            No projects
          </div>
        )}

        {/* Archived projects */}
        {!collapsed && archivedProjects.length > 0 && (
          <div className="mt-2">
            <button onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-2 px-3 py-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] w-full">
              <Archive size={10} strokeWidth={1.5} />
              {archivedProjects.length} archived
              <span className="ml-auto">{showArchived ? '▴' : '▾'}</span>
            </button>
            {showArchived && archivedProjects.map(name => (
              <div key={name} className="flex items-center gap-2 px-3 py-1 text-xs text-[var(--color-text-tertiary)]">
                <span className="flex-1 truncate opacity-60">{name}</span>
                <button onClick={async () => {
                  await fetch(`/api/projects/${encodeURIComponent(name)}/unarchive`, { method: 'POST' });
                  refresh();
                }} className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]" title="Unarchive">
                  Restore
                </button>
                <button onClick={async () => {
                  if (!window.confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
                  await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
                  refresh();
                }} className="text-[10px] text-red-400 hover:text-red-300" title="Delete permanently">
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent status summary — above Settings for stable position */}
      {!collapsed && activeAgents > 0 && (
        <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${busyAgents > 0 ? 'bg-[var(--color-status-running)] animate-pulse' : 'bg-[var(--color-status-ready)]'}`} />
            <span>{busyAgents} busy</span>
            <span className="text-[var(--color-text-tertiary)]">·</span>
            <span>{activeAgents - busyAgents} idle</span>
          </div>
        </div>
      )}

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


      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
    </aside>
  );
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [governance, setGovernance] = useState('autonomous');
  const [isolation, setIsolation] = useState('file_lock');
  const [leadRuntime, setLeadRuntime] = useState('');
  const [leadModel, setLeadModel] = useState('');
  const [availableModels, setAvailableModels] = useState<Array<{ modelId: string; displayName?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !cwd.trim()) return;
    setLoading(true);
    try {
      await api.createProject(name.trim(), cwd.trim(), governance, leadRuntime || undefined, leadModel || undefined);
      onCreated();
      onClose();
      navigate(`/${encodeURIComponent(name.trim())}`);
    } catch (err) {
      alert(`Failed to create project: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl w-[400px] p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Create Project</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Project name</label>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="my-project"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Working directory</label>
            <div className="flex gap-1.5">
              <input
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                className="flex-1 px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                placeholder="/home/user/projects/my-project"
              />
              <button type="button" onClick={async () => {
                try {
                  const res = await fetch('/api/browse-directory' + (cwd ? `?path=${encodeURIComponent(cwd)}` : ''));
                  const data = await res.json();
                  if (data.path) setCwd(data.path);
                } catch { /* fallback: user types manually */ }
              }}
                className="px-2.5 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] shrink-0"
                title="Browse directory">
                📂
              </button>
            </div>
            <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">Absolute path to your project</p>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Governance mode</label>
            <select
              value={governance}
              onChange={e => setGovernance(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="autonomous">Autonomous</option>
              <option value="collaborative">Collaborative</option>
              <option value="supervised">Supervised</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Isolation</label>
            <select
              value={isolation}
              onChange={e => setIsolation(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="file_lock">File Lock (shared directory)</option>
              <option value="git_worktree">Git Worktree (per-task branches)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Lead runtime</label>
            <select
              value={leadRuntime}
              onChange={e => {
                setLeadRuntime(e.target.value);
                setLeadModel('');
                setAvailableModels([]);
                if (e.target.value) {
                  // Fetch available models for this runtime from any existing project (or wait until project created)
                  fetch('/api/projects').then(r => r.json()).then(data => {
                    const p = data.projects?.[0]?.name;
                    if (p) {
                      fetch(`/api/projects/${p}/models/available`).then(r => r.json()).then(models => {
                        const rtModels = models[e.target.value];
                        if (rtModels) {
                          const all = [...(rtModels.high ?? []), ...(rtModels.medium ?? []), ...(rtModels.fast ?? [])];
                          setAvailableModels(all);
                        }
                      }).catch(() => {});
                    }
                  }).catch(() => {});
                }
              }}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Default</option>
              <option value="copilot">copilot</option>
              <option value="codex">codex</option>
              <option value="claude-code">claude-code</option>
              <option value="gemini">gemini</option>
              <option value="opencode">opencode</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Lead model <span className="text-[var(--color-text-tertiary)]">(optional)</span></label>
            <select
              value={leadModel}
              onChange={e => setLeadModel(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Default</option>
              {availableModels.map(m => (
                <option key={m.modelId} value={m.modelId}>{m.displayName ?? m.modelId}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !cwd.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-[#2f80ed] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

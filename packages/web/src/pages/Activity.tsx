import { useState, useEffect, useCallback } from 'react';
import { useProject } from '../hooks/useProject.tsx';
import { api } from '../lib/api.ts';
import { useWsEventBus } from '../hooks/useWsEventBus.tsx';
import { Activity as ActivityIcon, Filter, ChevronDown, ChevronRight, User, Bot, Shield, Eye } from 'lucide-react';
import type { ActivityEntry } from '../lib/types.ts';

const ROLE_COLORS: Record<string, string> = {
  lead: 'var(--color-status-in-review)',
  director: '#a855f7',
  worker: 'var(--color-status-done)',
  reviewer: '#f59e0b',
};

const ROLE_ICONS: Record<string, React.ReactNode> = {
  lead: <Shield size={12} strokeWidth={2} />,
  director: <User size={12} strokeWidth={2} />,
  worker: <Bot size={12} strokeWidth={2} />,
  reviewer: <Eye size={12} strokeWidth={2} />,
};

function ActivityCard({ entry, isExpanded, onToggle }: { entry: ActivityEntry; isExpanded: boolean; onToggle: () => void }) {
  const roleColor = ROLE_COLORS[entry.agentRole] ?? 'var(--color-text-tertiary)';
  const roleIcon = ROLE_ICONS[entry.agentRole] ?? <Bot size={12} strokeWidth={2} />;
  let details: Record<string, unknown> | null = null;
  try { details = entry.details && entry.details !== '{}' ? JSON.parse(entry.details) : null; } catch { /* */ }

  return (
    <div className="relative pl-8">
      {/* Timeline dot */}
      <div className="absolute left-0 top-3 w-4 h-4 rounded-full border-2 flex items-center justify-center"
           style={{ borderColor: roleColor, backgroundColor: `color-mix(in srgb, ${roleColor} 15%, transparent)`, color: roleColor }}>
        {roleIcon}
      </div>

      <div className={`border border-[var(--color-border)] rounded-lg overflow-hidden hover:border-[var(--color-text-tertiary)] transition-colors cursor-pointer ${isExpanded ? 'bg-[var(--color-surface)]' : ''}`}
           onClick={onToggle}>
        <div className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: `color-mix(in srgb, ${roleColor} 10%, transparent)`, color: roleColor }}>
                  {entry.agentId.length > 20 ? entry.agentId.slice(0, 20) + '…' : entry.agentId}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)]">
                  {entry.actionType}
                </span>
              </div>
              <p className="text-sm mt-1.5 text-[var(--color-text-primary)]">{entry.summary}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-xs text-[var(--color-text-tertiary)]">
                {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              {details && (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
            </div>
          </div>
        </div>
        {isExpanded && details && (
          <div className="px-3 pb-3 pt-0 border-t border-[var(--color-border)]">
            <pre className="text-xs text-[var(--color-text-secondary)] mt-2 whitespace-pre-wrap font-mono bg-[var(--color-surface-secondary)] p-2 rounded">
              {JSON.stringify(details, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Activity() {
  const { projectName, loading: projectLoading } = useProject();
  const { subscribe } = useWsEventBus();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<string | 'all'>('all');
  const [showFilters, setShowFilters] = useState(false);

  const fetchActivity = useCallback(async () => {
    if (!projectName) return;
    try {
      const data = await api.getActivity(projectName, { limit: 200 });
      setEntries(data.reverse()); // newest first
    } catch { /* */ }
    setLoading(false);
  }, [projectName]);

  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  // Refresh on state updates
  useEffect(() => {
    return subscribe((event: any) => {
      if (event.type === 'state:update') fetchActivity();
    });
  }, [subscribe, fetchActivity]);

  if (projectLoading || loading) {
    return (
      <div className="max-w-4xl space-y-4">
        <div className="h-8 w-40 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-16 bg-[var(--color-surface-secondary)] rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Activity</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <ActivityIcon size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
          <p>No activity recorded yet.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">Agent actions will appear here as they work on tasks.</p>
        </div>
      </div>
    );
  }

  const roles = [...new Set(entries.map(e => e.agentRole))];
  const actionTypes = [...new Set(entries.map(e => e.actionType))];
  const filtered = entries
    .filter(e => roleFilter === 'all' || e.agentRole === roleFilter)
    .filter(e => typeFilter === 'all' || e.actionType === typeFilter);

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Activity ({entries.length})</h1>
        <button onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors">
          <Filter size={12} /> Filters {(roleFilter !== 'all' || typeFilter !== 'all') && '•'}
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-4 p-3 bg-[var(--color-surface-secondary)] rounded-lg">
          <div>
            <label className="text-xs text-[var(--color-text-tertiary)] block mb-1">Role</label>
            <div className="flex gap-1">
              <button onClick={() => setRoleFilter('all')}
                className={`text-xs px-2 py-1 rounded ${roleFilter === 'all' ? 'bg-[var(--color-surface-hover)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
                All
              </button>
              {roles.map(r => (
                <button key={r} onClick={() => setRoleFilter(r)}
                  className={`text-xs px-2 py-1 rounded ${roleFilter === r ? 'font-medium' : 'text-[var(--color-text-secondary)]'}`}
                  style={roleFilter === r ? { backgroundColor: `color-mix(in srgb, ${ROLE_COLORS[r] ?? '#888'} 15%, transparent)`, color: ROLE_COLORS[r] } : {}}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-[var(--color-text-tertiary)] block mb-1">Action</label>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="text-xs px-2 py-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)]">
              <option value="all">All</option>
              {actionTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="relative space-y-2">
        <div className="absolute left-[7px] top-0 bottom-0 w-0.5 bg-[var(--color-border)]" />

        {filtered.map((entry, i) => {
          const dateStr = new Date(entry.timestamp).toLocaleDateString();
          const prevDateStr = i > 0 ? new Date(filtered[i - 1].timestamp).toLocaleDateString() : null;
          const showDateSeparator = i === 0 || dateStr !== prevDateStr;
          return (
            <div key={entry.id}>
              {showDateSeparator && (
                <div className="relative pl-8 py-2">
                  <span className="text-xs font-medium text-[var(--color-text-tertiary)] bg-[var(--color-surface)] px-2 relative z-10">
                    {new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                </div>
              )}
              <ActivityCard entry={entry} isExpanded={expanded === entry.id}
                onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

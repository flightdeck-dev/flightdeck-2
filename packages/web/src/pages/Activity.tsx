import { useState, useEffect, useCallback, useRef } from 'react';
import { useProject } from '../hooks/useProject.tsx';
import { api } from '../lib/api.ts';
import { useWsEventBus } from '../hooks/useWsEventBus.tsx';
import { Activity as ActivityIcon, Filter, ChevronDown, ChevronRight, Shield, Bot, Eye, User } from 'lucide-react';
import type { ActivityEntry } from '../lib/types.ts';

const ROLE_COLORS: Record<string, string> = {
  lead: 'var(--color-status-in-review)',
  director: '#a855f7',
  worker: 'var(--color-status-done)',
  reviewer: '#f59e0b',
};

function ActivityRow({ entry, isExpanded, onToggle }: { entry: ActivityEntry; isExpanded: boolean; onToggle: () => void }) {
  const roleColor = ROLE_COLORS[entry.agentRole] ?? 'var(--color-text-tertiary)';
  let details: Record<string, unknown> | null = null;
  try { details = entry.details && entry.details !== '{}' ? JSON.parse(entry.details) : null; } catch (e) { console.error('Failed to parse activity details', e); }
  const hasDetails = details !== null;

  return (
    <div className="relative pl-6">
      {/* Timeline dot */}
      <div className="absolute left-0 top-2 w-2.5 h-2.5 rounded-full"
           style={{ backgroundColor: roleColor }} />

      <div className={`flex items-start gap-3 py-1.5 ${hasDetails ? 'cursor-pointer' : ''} hover:bg-[var(--color-surface-hover)] rounded px-2 -mx-2 transition-colors`}
           onClick={hasDetails ? onToggle : undefined}>
        <span className="text-[11px] font-mono text-[var(--color-text-tertiary)] shrink-0 pt-0.5 w-16">
          {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span className="text-[11px] font-mono shrink-0 w-28 truncate pt-0.5"
              style={{ color: roleColor }}>
          {entry.agentId.length > 16 ? entry.agentId.slice(0, 16) + '…' : entry.agentId}
        </span>
        <span className="text-[11px] font-mono text-[var(--color-text-secondary)] shrink-0 w-24 truncate pt-0.5">
          {entry.actionType}
        </span>
        <span className="text-sm text-[var(--color-text-primary)] flex-1 min-w-0 truncate">
          {entry.summary}
        </span>
        {hasDetails && (
          <span className="text-[var(--color-text-tertiary)] shrink-0 pt-0.5">
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </div>
      {isExpanded && details && (
        <div className="ml-16 mb-2">
          <pre className="text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono bg-[var(--color-surface-secondary)] p-2 rounded">
            {JSON.stringify(details, null, 2)}
          </pre>
        </div>
      )}
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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchActivity = useCallback(async () => {
    if (!projectName) return;
    try {
      const data = await api.getActivity(projectName, { limit: 200 });
      setEntries([...data].reverse()); // newest first
    } catch (e) { console.error('Failed to fetch activity', e); }
    setLoading(false);
  }, [projectName]);

  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  // Debounced refresh on state updates
  useEffect(() => {
    return subscribe((event: any) => {
      if (event.type === 'state:update') {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(fetchActivity, 500);
      }
    });
  }, [subscribe, fetchActivity]);

  if (projectLoading || loading) {
    return (
      <div className="max-w-5xl space-y-4">
        <div className="h-8 w-40 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-8 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="max-w-5xl">
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
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Activity ({entries.length})</h1>
        <div className="flex items-center gap-2">
          {/* Role filter pills */}
          <div className="flex gap-0.5">
            <button onClick={() => setRoleFilter('all')}
              className={`text-xs px-2 py-1 rounded-md transition-colors ${roleFilter === 'all' ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
              All
            </button>
            {roles.map(r => (
              <button key={r} onClick={() => setRoleFilter(r)}
                className={`text-xs px-2 py-1 rounded-md transition-colors ${roleFilter === r ? 'font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
                style={roleFilter === r ? { backgroundColor: `color-mix(in srgb, ${ROLE_COLORS[r] ?? '#888'} 15%, transparent)`, color: ROLE_COLORS[r] } : {}}>
                {r}
              </button>
            ))}
          </div>
          {/* Action type dropdown */}
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="text-xs px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
            <option value="all">All actions</option>
            {actionTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* Compact timeline */}
      <div className="relative space-y-0">
        <div className="absolute left-[4px] top-0 bottom-0 w-0.5 bg-[var(--color-border)]" />

        {filtered.map((entry, i) => {
          const dateStr = new Date(entry.timestamp).toLocaleDateString();
          const prevDateStr = i > 0 ? new Date(filtered[i - 1].timestamp).toLocaleDateString() : null;
          const showDateSeparator = i === 0 || dateStr !== prevDateStr;
          return (
            <div key={entry.id}>
              {showDateSeparator && (
                <div className="relative pl-6 py-2">
                  <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">
                    {new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
              )}
              <ActivityRow entry={entry} isExpanded={expanded === entry.id}
                onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

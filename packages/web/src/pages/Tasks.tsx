import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Task, TaskState } from '../lib/types.ts';

type Ctx = { tasks: Task[] };

const STATE_COLORS: Record<string, string> = {
  ready: 'var(--color-status-ready)',
  running: 'var(--color-status-running)',
  in_review: 'var(--color-status-in-review)',
  done: 'var(--color-status-done)',
  failed: 'var(--color-status-failed)',
  cancelled: 'var(--color-status-cancelled)',
};

const STATES: TaskState[] = ['ready', 'running', 'in_review', 'done', 'failed', 'cancelled'];

function Badge({ state }: { state: TaskState }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${STATE_COLORS[state]} 15%, transparent)`, color: STATE_COLORS[state] }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATE_COLORS[state] }} />
      {state.replace('_', ' ')}
    </span>
  );
}

export default function Tasks() {
  const { tasks } = useOutletContext<Ctx>();
  const [filter, setFilter] = useState<TaskState | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = filter === 'all' ? tasks : tasks.filter((t) => t.state === filter);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex gap-1">
          <button
            onClick={() => setFilter('all')}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === 'all' ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
          >
            All
          </button>
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === s ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Title</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">State</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Role</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Agent</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Priority</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Source</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <>
                <tr
                  key={task.id}
                  onClick={() => setExpanded(expanded === task.id ? null : task.id)}
                  className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{task.title}</div>
                    <div className="font-mono text-xs text-[var(--color-text-tertiary)]">{task.id}</div>
                  </td>
                  <td className="px-4 py-2.5"><Badge state={task.state} /></td>
                  <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{task.role}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--color-text-secondary)]">{task.assignedAgent ?? '—'}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">P{task.priority}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{task.source}</td>
                </tr>
                {expanded === task.id && (
                  <tr key={`${task.id}-detail`} className="border-b border-[var(--color-border)]">
                    <td colSpan={6} className="px-4 py-4 bg-[var(--color-surface-secondary)]">
                      <div className="space-y-2 text-sm">
                        <p>{task.description}</p>
                        {task.claim && (
                          <p className="text-[var(--color-text-secondary)]"><span className="font-medium">Claim:</span> {task.claim}</p>
                        )}
                        {task.dependsOn.length > 0 && (
                          <p className="text-[var(--color-text-secondary)]">
                            <span className="font-medium">Depends on:</span>{' '}
                            {task.dependsOn.map((d) => <span key={d} className="font-mono text-xs">{d} </span>)}
                          </p>
                        )}
                        <p className="text-xs text-[var(--color-text-tertiary)]">
                          Created: {new Date(task.createdAt).toLocaleString()} · Updated: {new Date(task.updatedAt).toLocaleString()}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

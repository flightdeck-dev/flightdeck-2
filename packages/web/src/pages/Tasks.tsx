import { useState } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { STATE_COLORS } from '../lib/constants.ts';
import type { TaskState } from '../lib/types.ts';

const STATES: TaskState[] = ['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'cancelled'];

function Badge({ state }: { state: TaskState }) {
  const color = STATE_COLORS[state] ?? 'var(--color-text-tertiary)';
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {state.replace('_', ' ')}
    </span>
  );
}

export default function Tasks() {
  const { tasks, sendTaskComment, loading } = useFlightdeck();
  const [filter, setFilter] = useState<TaskState | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [commentByTask, setCommentByTask] = useState<Record<string, string>>({});

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.state === filter);

  const handleComment = (taskId: string) => {
    const text = (commentByTask[taskId] ?? '').trim();
    if (!text) return;
    sendTaskComment(taskId, text);
    setCommentByTask(prev => ({ ...prev, [taskId]: '' }));
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks ({tasks.length})</h1>
        <div className="flex gap-1">
          <button onClick={() => setFilter('all')}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === 'all' ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
            All
          </button>
          {STATES.map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === s ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
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
            </tr>
          </thead>
          <tbody>
            {filtered.map(task => (
              <tr key={task.id}>
                <td colSpan={5} className="p-0">
                  <div
                    onClick={() => setExpanded(expanded === task.id ? null : task.id)}
                    className="flex border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors"
                  >
                    <div className="flex-[3] px-4 py-2.5">
                      <div className="font-medium">{task.title}</div>
                      <div className="font-mono text-xs text-[var(--color-text-tertiary)]">{task.id}</div>
                    </div>
                    <div className="flex-[1] px-4 py-2.5"><Badge state={task.state} /></div>
                    <div className="flex-[1] px-4 py-2.5 text-[var(--color-text-secondary)]">{task.role}</div>
                    <div className="flex-[1] px-4 py-2.5 font-mono text-xs text-[var(--color-text-secondary)]">{task.assignedAgent ?? task.assigned_agent ?? '—'}</div>
                    <div className="flex-[0.5] px-4 py-2.5 text-[var(--color-text-secondary)]">P{task.priority}</div>
                  </div>
                  {expanded === task.id && (
                    <div className="px-4 py-4 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]">
                      <div className="space-y-2 text-sm">
                        <p>{task.description}</p>
                        {task.claim && (
                          <p className="text-[var(--color-text-secondary)]"><span className="font-medium">Claim:</span> {task.claim}</p>
                        )}
                        {(task.dependsOn?.length ?? 0) > 0 && (
                          <p className="text-[var(--color-text-secondary)]">
                            <span className="font-medium">Depends on:</span>{' '}
                            {(task.dependsOn ?? []).map(d => <span key={d} className="font-mono text-xs">{d} </span>)}
                          </p>
                        )}
                        <div className="flex gap-2 mt-3">
                          <input
                            value={commentByTask[task.id] ?? ''}
                            onChange={e => setCommentByTask(prev => ({ ...prev, [task.id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') handleComment(task.id); }}
                            placeholder="Add a comment..."
                            className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
                          />
                          <button onClick={() => handleComment(task.id)}
                            className="text-xs px-3 py-1 rounded bg-[var(--color-status-ready)] text-white hover:opacity-90">
                            Comment
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

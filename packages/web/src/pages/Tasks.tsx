import { useState } from 'react';
import { ListTodo, Plus, ChevronUp, ChevronDown } from 'lucide-react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { STATE_COLORS } from '../lib/constants.ts';
import { api } from '../lib/api.ts';
import type { Task, TaskState } from '../lib/types.ts';

const STATES: TaskState[] = ['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'cancelled'];

function Badge({ state }: { state: TaskState }) {
  const color = STATE_COLORS[state] ?? 'var(--color-text-tertiary)';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {state.replace('_', ' ')}
    </span>
  );
}

function PriorityIndicator({ priority }: { priority: number }) {
  const color = priority <= 1 ? 'var(--color-status-failed)' : priority <= 3 ? 'var(--color-status-running)' : 'var(--color-text-tertiary)';
  return (
    <span className="text-xs font-medium px-1.5 py-0.5 rounded" style={{ color }}>
      P{priority}
    </span>
  );
}

function DependencyTree({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  const deps = (task.dependsOn ?? []).map(id => allTasks.find(t => t.id === id)).filter(Boolean) as Task[];
  if (deps.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">Dependencies</p>
      <div className="space-y-1 pl-3 border-l-2 border-[var(--color-border)]">
        {deps.map(d => (
          <div key={d.id} className="flex items-center gap-2 text-xs">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATE_COLORS[d.state] ?? 'var(--color-text-tertiary)' }} />
            <span className="truncate">{d.title}</span>
            <Badge state={d.state} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { projectName } = useFlightdeck();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('developer');
  const [priority, setPriority] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!title.trim() || !projectName) return;
    setSubmitting(true);
    setError('');
    try {
      await api.createTask(projectName, { title: title.trim(), description, role, priority });
      onCreated();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-base font-semibold">Create Task</h2>
          <button onClick={onClose} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">✕</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-status-ready)]"
              placeholder="Task title..." autoFocus />
          </div>
          <div>
            <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-status-ready)] resize-none"
              placeholder="What needs to be done..." />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">Role</label>
              <select value={role} onChange={e => setRole(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] focus:outline-none">
                <option value="developer">Developer</option>
                <option value="reviewer">Reviewer</option>
                <option value="planner">Planner</option>
                <option value="lead">Lead</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">Priority</label>
              <select value={priority} onChange={e => setPriority(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] focus:outline-none">
                {[1, 2, 3, 4, 5].map(p => (
                  <option key={p} value={p}>P{p}{p === 1 ? ' (Critical)' : p === 5 ? ' (Low)' : ''}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-xs text-[var(--color-status-failed)]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--color-border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!title.trim() || submitting}
            className="px-4 py-2 text-sm rounded-lg bg-[var(--color-status-ready)] text-white font-medium hover:opacity-90 disabled:opacity-40">
            {submitting ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, allTasks, isExpanded, onToggle }: {
  task: Task; allTasks: Task[]; isExpanded: boolean; onToggle: () => void;
}) {
  const { sendTaskComment } = useFlightdeck();
  const [comment, setComment] = useState('');
  const agent = task.assignedAgent ?? task.assigned_agent;

  const handleComment = () => {
    const text = comment.trim();
    if (!text) return;
    sendTaskComment(task.id, text);
    setComment('');
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden hover:border-[var(--color-text-tertiary)] transition-colors">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={onToggle}>
        <PriorityIndicator priority={task.priority} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{task.title}</p>
          <p className="text-xs text-[var(--color-text-tertiary)] font-mono mt-0.5">{task.id}</p>
        </div>
        <Badge state={task.state} />
        {agent && (
          <span className="text-xs font-mono text-[var(--color-text-secondary)] bg-[var(--color-surface-secondary)] px-2 py-0.5 rounded">
            {agent}
          </span>
        )}
        <span className="text-[var(--color-text-tertiary)]">{isExpanded ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}</span>
      </div>
      {isExpanded && (
        <div className="px-4 pb-4 pt-0 border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
          <div className="py-3 space-y-3">
            {task.description && (
              <p className="text-sm text-[var(--color-text-secondary)]">{task.description}</p>
            )}
            {task.claim && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                <span className="font-medium">Claim:</span> {task.claim}
              </p>
            )}
            <div className="flex flex-wrap gap-3 text-xs text-[var(--color-text-tertiary)]">
              <span>Role: {task.role}</span>
              {task.created_at && <span>Created: {new Date(task.created_at).toLocaleDateString()}</span>}
              {task.cost != null && <span>Cost: ${task.cost.toFixed(2)}</span>}
            </div>
            <DependencyTree task={task} allTasks={allTasks} />
            <div className="flex gap-2 mt-2">
              <input value={comment} onChange={e => setComment(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleComment(); }}
                placeholder="Add a comment..."
                className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-status-ready)]" />
              <button onClick={handleComment}
                className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-status-ready)] text-white hover:opacity-90 disabled:opacity-40"
                disabled={!comment.trim()}>
                Comment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const { tasks, loading, refresh } = useFlightdeck();
  const [filter, setFilter] = useState<TaskState | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (loading) {
    return (
      <div className="max-w-5xl space-y-4">
        <div className="h-8 w-32 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 bg-[var(--color-surface-secondary)] rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.state === filter);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks ({tasks.length})</h1>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-status-ready)] text-white font-medium hover:opacity-90">
          <Plus size={16} strokeWidth={1.5} /> Create Task
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-1 flex-wrap">
        <button onClick={() => setFilter('all')}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === 'all' ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
          All
        </button>
        {STATES.map(s => {
          const count = tasks.filter(t => t.state === s).length;
          return (
            <button key={s} onClick={() => setFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${filter === s ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
              {s.replace('_', ' ')}{count > 0 ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      {/* Task list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <ListTodo size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
          <p>No tasks{filter !== 'all' ? ` with state "${filter.replace('_', ' ')}"` : ''}.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">Create a task or let Lead generate the task plan.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              allTasks={tasks}
              isExpanded={expanded === task.id}
              onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
            />
          ))}
        </div>
      )}

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
    </div>
  );
}

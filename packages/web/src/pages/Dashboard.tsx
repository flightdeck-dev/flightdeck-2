import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { STATE_COLORS } from '../lib/constants.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Circle, Disc, CircleDot, CheckCircle2, Crown, Code, Search, ClipboardList, Bot } from 'lucide-react';
import type { Task, TaskState } from '../lib/types.ts';

const PIPELINE_COLUMNS: { state: TaskState; label: string; icon: React.ReactNode }[] = [
  { state: 'ready', label: 'Ready', icon: <Circle size={16} strokeWidth={1.5} /> },
  { state: 'running', label: 'Running', icon: <Disc size={16} strokeWidth={1.5} /> },
  { state: 'in_review', label: 'In Review', icon: <CircleDot size={16} strokeWidth={1.5} /> },
  { state: 'done', label: 'Done', icon: <CheckCircle2 size={16} strokeWidth={1.5} /> },
];

const ROLE_ICONS: Record<string, React.ReactNode> = {
  lead: <Crown size={18} strokeWidth={1.5} />, developer: <Code size={18} strokeWidth={1.5} />, worker: <Code size={18} strokeWidth={1.5} />, reviewer: <Search size={18} strokeWidth={1.5} />, planner: <ClipboardList size={18} strokeWidth={1.5} />,
};

function PipelineCard({ task }: { task: Task }) {
  const agent = task.assignedAgent || task.assigned_agent;
  return (
    <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-tertiary)] transition-colors cursor-default">
      <p className="text-sm font-medium truncate">{task.title}</p>
      <div className="flex items-center gap-2 mt-2">
        {agent && (
          <span className="text-xs font-mono text-[var(--color-text-tertiary)] truncate">{agent}</span>
        )}
        {task.priority <= 1 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-status-failed)_15%,transparent)] text-[var(--color-status-failed)]">
            P{task.priority}
          </span>
        )}
      </div>
    </div>
  );
}

function PipelineColumn({ state, label, icon, tasks }: { state: TaskState; label: string; icon: React.ReactNode; tasks: Task[] }) {
  const color = STATE_COLORS[state];
  return (
    <div className="flex-1 min-w-[200px]">
      <div className="flex items-center gap-2 mb-3 px-1">
        <span style={{ color }}>{icon}</span>
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]">
          {tasks.length}
        </span>
      </div>
      <div className="space-y-2 min-h-[80px]">
        {tasks.length === 0 ? (
          <div className="text-xs text-[var(--color-text-tertiary)] text-center py-6 border border-dashed border-[var(--color-border)] rounded-lg">
            No tasks
          </div>
        ) : (
          tasks.map(t => <PipelineCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { status, tasks, agents, messages, loading } = useFlightdeck();

  if (loading) {
    return (
      <div className="max-w-5xl space-y-6">
        <div className="h-8 w-48 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-32 bg-[var(--color-surface-secondary)] rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const tasksByState = (state: TaskState) => tasks.filter(t => t.state === state);
  const activeAgents = agents.filter(a => !['terminated', 'ended', 'offline', 'suspended', 'hibernated', 'retired'].includes(a.status));
  const leadMessage = [...messages].reverse().find(m => m.authorType === 'lead' && !m.threadId);

  return (
    <div className="max-w-6xl space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{status?.config?.name ?? 'Flightdeck'}</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {status?.config?.governance ?? '—'} governance · ${(status?.totalCost ?? 0).toFixed(2)} spent
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="text-center">
            <p className="text-2xl font-semibold">{tasks.length}</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">tasks</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-semibold" style={{ color: 'var(--color-status-running)' }}>
              {activeAgents.length}
            </p>
            <p className="text-xs text-[var(--color-text-tertiary)]">agents</p>
          </div>
        </div>
      </div>

      {/* Task Pipeline */}
      <div>
        <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-4">Task Pipeline</h2>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {PIPELINE_COLUMNS.map(col => (
            <PipelineColumn
              key={col.state}
              state={col.state}
              label={col.label}
              icon={col.icon}
              tasks={tasksByState(col.state)}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Lead's Last Message */}
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Lead's Last Message</h2>
          {leadMessage ? (
            <div className="p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="text-sm line-clamp-4"><Markdown content={leadMessage.content} /></div>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-2">
                {new Date(leadMessage.createdAt).toLocaleString()}
              </p>
            </div>
          ) : (
            <div className="p-6 rounded-lg border border-dashed border-[var(--color-border)] text-center text-sm text-[var(--color-text-tertiary)]">
              No messages from Lead yet
            </div>
          )}
        </div>

        {/* Active Agents */}
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">
            Active Agents ({activeAgents.length})
          </h2>
          {activeAgents.length === 0 ? (
            <div className="p-6 rounded-lg border border-dashed border-[var(--color-border)] text-center text-sm text-[var(--color-text-tertiary)]">
              No agents running — Lead will spawn agents when needed
            </div>
          ) : (
            <div className="space-y-2">
              {activeAgents.slice(0, 6).map(a => {
                const statusColor = a.status === 'busy' || a.status === 'working'
                  ? 'var(--color-status-running)'
                  : a.status === 'idle' ? 'var(--color-status-ready)'
                  : 'var(--color-status-cancelled)';
                const currentTask = tasks.find(t => t.id === (a.currentTask ?? a.current_task));
                return (
                  <div key={a.id} className="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                    <span className="text-base">{ROLE_ICONS[a.role] ?? <Bot size={18} strokeWidth={1.5} />}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize">{a.role}</span>
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
                        <span className="text-xs text-[var(--color-text-tertiary)]">{a.status}</span>
                      </div>
                      {currentTask && (
                        <p className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">
                          Working on: {currentTask.title}
                        </p>
                      )}
                    </div>
                    {a.model && (
                      <span className="text-xs text-[var(--color-text-tertiary)] font-mono shrink-0">{a.model}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

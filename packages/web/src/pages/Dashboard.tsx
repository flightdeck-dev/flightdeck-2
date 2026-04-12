import { useOutletContext } from 'react-router-dom';
import type { Task, Agent, Activity, ProjectInfo } from '../lib/types.ts';

type Ctx = { project: ProjectInfo | null; tasks: Task[]; agents: Agent[]; activities: Activity[] };

const STATE_COLORS: Record<string, string> = {
  ready: 'var(--color-status-ready)',
  running: 'var(--color-status-running)',
  in_review: 'var(--color-status-in-review)',
  done: 'var(--color-status-done)',
  failed: 'var(--color-status-failed)',
  cancelled: 'var(--color-status-cancelled)',
};

function StatCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex flex-col gap-1 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <span className="text-2xl font-semibold" style={{ color }}>{count}</span>
      <span className="text-xs text-[var(--color-text-secondary)] capitalize">{label.replace('_', ' ')}</span>
    </div>
  );
}

function StatusDot({ status }: { status: Agent['status'] }) {
  const color = status === 'working' ? 'var(--color-status-running)' : status === 'idle' ? 'var(--color-status-done)' : 'var(--color-status-cancelled)';
  return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />;
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function Dashboard() {
  const { project, tasks, agents, activities } = useOutletContext<Ctx>();

  const stats = (['ready', 'running', 'in_review', 'done', 'failed'] as const).map((s) => ({
    label: s,
    count: tasks.filter((t) => t.state === s).length,
    color: STATE_COLORS[s],
  }));

  const activeAgents = agents.filter((a) => a.status !== 'terminated');

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold">{project?.name ?? '...'}</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Governance: {project?.governance} · Total cost: ${project?.totalCost.toFixed(2)}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-8">
        {/* Active agents */}
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Active Agents</h2>
          <div className="space-y-2">
            {activeAgents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2 px-3 rounded-md border border-[var(--color-border)]">
                <StatusDot status={a.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono truncate">{a.id}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">{a.role} · {a.model}</p>
                </div>
                <span className="text-xs text-[var(--color-text-tertiary)]">${a.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Recent Activity</h2>
          <div className="space-y-2">
            {activities.slice(0, 6).map((act) => (
              <div key={act.id} className="flex items-start gap-3 py-2 px-3 rounded-md border border-[var(--color-border)]">
                <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: STATE_COLORS[act.to] }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{act.taskTitle}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {act.from} → {act.to}
                    {act.agent && <span className="font-mono"> · {act.agent}</span>}
                  </p>
                </div>
                <span className="text-xs text-[var(--color-text-tertiary)] shrink-0">{timeAgo(act.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

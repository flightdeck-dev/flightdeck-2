import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { STATE_COLORS } from '../lib/constants.ts';

function StatCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex flex-col gap-1 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <span className="text-2xl font-semibold" style={{ color }}>{count}</span>
      <span className="text-xs text-[var(--color-text-secondary)] capitalize">{label.replace('_', ' ')}</span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'busy' || status === 'working' ? 'var(--color-status-running)' : status === 'idle' ? 'var(--color-status-done)' : 'var(--color-status-cancelled)';
  return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />;
}

export default function Dashboard() {
  const { status, tasks, agents, loading } = useFlightdeck();

  if (loading) {
    return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  }

  const taskStats = status?.taskStats ?? {};
  const statsToShow = ['ready', 'running', 'in_review', 'done', 'failed'] as const;
  const stats = statsToShow.map(s => ({
    label: s,
    count: taskStats[s] ?? tasks.filter(t => t.state === s).length,
    color: STATE_COLORS[s],
  }));

  const activeAgents = agents.filter(a => a.status !== 'terminated' && a.status !== 'ended');

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold">{status?.config?.name ?? 'Flightdeck'}</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Governance: {status?.config?.governance ?? '—'} · Total cost: ${(status?.totalCost ?? 0).toFixed(2)}
        </p>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {stats.map(s => <StatCard key={s.label} {...s} />)}
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">
            Active Agents ({activeAgents.length})
          </h2>
          {activeAgents.length === 0 ? (
            <p className="text-sm text-[var(--color-text-tertiary)]">No agents running</p>
          ) : (
            <div className="space-y-2">
              {activeAgents.map(a => (
                <div key={a.id} className="flex items-center gap-3 py-2 px-3 rounded-md border border-[var(--color-border)]">
                  <StatusDot status={a.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono truncate">{a.id}</p>
                    <p className="text-xs text-[var(--color-text-secondary)]">{a.role} · {a.runtime ?? 'acp'}</p>
                  </div>
                  {a.cost != null && (
                    <span className="text-xs text-[var(--color-text-tertiary)]">${a.cost.toFixed(2)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Tasks ({tasks.length})</h2>
          <div className="space-y-2">
            {tasks.slice(0, 8).map(t => (
              <div key={t.id} className="flex items-center gap-3 py-2 px-3 rounded-md border border-[var(--color-border)]">
                <span className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: STATE_COLORS[t.state] ?? 'var(--color-text-tertiary)' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{t.title}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {t.state} {t.assignedAgent || t.assigned_agent ? `· ${t.assignedAgent || t.assigned_agent}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

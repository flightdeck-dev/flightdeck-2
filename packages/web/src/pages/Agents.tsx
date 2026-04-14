import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { Agent } from '../lib/types.ts';

const ROLE_ICONS: Record<string, string> = {
  lead: '👑', developer: '💻', worker: '💻', reviewer: '🔍', planner: '📋',
};

const STATUS_CONFIG: Record<string, { color: string; label: string; animate?: boolean }> = {
  busy: { color: 'var(--color-status-running)', label: 'Busy', animate: true },
  working: { color: 'var(--color-status-running)', label: 'Working', animate: true },
  idle: { color: 'var(--color-status-done)', label: 'Idle' },
  terminated: { color: 'var(--color-status-cancelled)', label: 'Offline' },
  ended: { color: 'var(--color-status-cancelled)', label: 'Ended' },
};

function AgentCard({ agent }: { agent: Agent }) {
  const config = STATUS_CONFIG[agent.status] ?? { color: 'var(--color-text-tertiary)', label: agent.status };
  const { tasks } = useFlightdeck();
  const currentTask = tasks.find(t => t.id === (agent.currentTask ?? agent.current_task));

  return (
    <div className="p-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-tertiary)] transition-colors space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-surface-secondary)] flex items-center justify-center text-lg">
            {ROLE_ICONS[agent.role] ?? '🤖'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold capitalize">{agent.role}</span>
            </div>
            <p className="font-mono text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate max-w-[160px]">{agent.id}</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
              style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
          <span className={`w-2 h-2 rounded-full ${config.animate ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: config.color }} />
          {config.label}
        </span>
      </div>

      {/* Current task */}
      {currentTask && (
        <div className="px-3 py-2 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-tertiary)] mb-0.5">Current Task</p>
          <p className="text-sm truncate">{currentTask.title}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-[var(--color-text-tertiary)]">Model</p>
          <p className="font-mono mt-0.5 truncate">{agent.model ?? '—'}</p>
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Runtime</p>
          <p className="font-mono mt-0.5">{agent.runtimeName ?? agent.runtime ?? 'acp'}</p>
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Cost</p>
          <p className="mt-0.5 font-medium">${(agent.cost ?? 0).toFixed(2)}</p>
        </div>
      </div>

      {/* Actions */}
      {agent.status !== 'terminated' && agent.status !== 'ended' && (
        <div className="flex gap-2 pt-1">
          <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors flex-1">
            Interrupt
          </button>
          <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] transition-colors flex-1">
            Terminate
          </button>
        </div>
      )}
    </div>
  );
}

export default function Agents() {
  const { agents, loading } = useFlightdeck();

  if (loading) {
    return (
      <div className="max-w-5xl space-y-6">
        <div className="h-8 w-32 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-48 bg-[var(--color-surface-secondary)] rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const active = agents.filter(a => a.status !== 'terminated' && a.status !== 'ended');
  const terminated = agents.filter(a => a.status === 'terminated' || a.status === 'ended');

  if (agents.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Agents</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <p className="text-4xl mb-4">🤖</p>
          <p>No agents running.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">The Lead will spawn agents when tasks are ready.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents ({agents.length})</h1>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-running)] animate-pulse" />
            {active.filter(a => a.status === 'busy' || a.status === 'working').length} busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-done)]" />
            {active.filter(a => a.status === 'idle').length} idle
          </span>
        </div>
      </div>

      {active.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {active.map(a => <AgentCard key={a.id} agent={a} />)}
        </div>
      )}

      {terminated.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            {terminated.length} terminated agent{terminated.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 opacity-60">
            {terminated.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        </details>
      )}
    </div>
  );
}

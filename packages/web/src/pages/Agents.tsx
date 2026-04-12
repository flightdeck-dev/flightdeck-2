import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { Agent } from '../lib/types.ts';

const ROLE_ICONS: Record<string, string> = {
  lead: '👑',
  developer: '💻',
  worker: '💻',
  reviewer: '🔍',
  planner: '📋',
};

function AgentCard({ agent }: { agent: Agent }) {
  const statusColor = agent.status === 'busy' || agent.status === 'working'
    ? 'var(--color-status-running)'
    : agent.status === 'idle' ? 'var(--color-status-done)' : 'var(--color-status-cancelled)';

  return (
    <div className="p-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span>{ROLE_ICONS[agent.role] ?? '🤖'}</span>
            <span className="text-sm font-medium capitalize">{agent.role}</span>
          </div>
          <p className="font-mono text-xs text-[var(--color-text-tertiary)] mt-1">{agent.id}</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
          {agent.status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-[var(--color-text-tertiary)]">Runtime</p>
          <p className="font-mono mt-0.5">{agent.runtime ?? 'acp'}</p>
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Cost</p>
          <p className="mt-0.5">${(agent.cost ?? 0).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Task</p>
          <p className="font-mono mt-0.5 truncate">{agent.currentTask ?? agent.current_task ?? '—'}</p>
        </div>
      </div>

      {agent.status !== 'terminated' && agent.status !== 'ended' && (
        <div className="flex gap-2">
          <button className="text-xs px-2.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors">
            Interrupt
          </button>
          <button className="text-xs px-2.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-status-failed)] hover:bg-[var(--color-surface-hover)] transition-colors">
            Terminate
          </button>
        </div>
      )}
    </div>
  );
}

export default function Agents() {
  const { agents, loading } = useFlightdeck();

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  if (agents.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Agents</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <p className="text-4xl mb-4">🤖</p>
          <p>No agents running.</p>
          <p className="text-sm mt-1">The Lead will spawn agents when needed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold">Agents ({agents.length})</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(a => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  );
}

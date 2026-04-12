import { useState } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { DecisionStatus } from '../lib/types.ts';

const STATUS_STYLES: Record<DecisionStatus, { bg: string; text: string }> = {
  confirmed: { bg: 'color-mix(in srgb, var(--color-status-done) 15%, transparent)', text: 'var(--color-status-done)' },
  recorded: { bg: 'color-mix(in srgb, var(--color-status-ready) 15%, transparent)', text: 'var(--color-status-ready)' },
  rejected: { bg: 'color-mix(in srgb, var(--color-status-failed) 15%, transparent)', text: 'var(--color-status-failed)' },
};

export default function Decisions() {
  const { decisions, loading } = useFlightdeck();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  if (decisions.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Decisions</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <p className="text-4xl mb-4">⚖</p>
          <p>No decisions logged yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Decisions ({decisions.length})</h1>
      <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Title</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Category</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Status</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)]">Time</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map(d => (
              <tr key={d.id} className="border-b border-[var(--color-border)]">
                <td colSpan={4} className="p-0">
                  <div onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                       className="flex hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors">
                    <div className="flex-[2] px-4 py-2.5 font-medium">{d.title}</div>
                    <div className="flex-1 px-4 py-2.5 text-[var(--color-text-secondary)]">{d.category}</div>
                    <div className="flex-1 px-4 py-2.5">
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: STATUS_STYLES[d.status]?.bg, color: STATUS_STYLES[d.status]?.text }}>
                        {d.status}
                      </span>
                    </div>
                    <div className="flex-1 px-4 py-2.5 text-xs text-[var(--color-text-tertiary)]">
                      {new Date(d.timestamp).toLocaleString()}
                    </div>
                  </div>
                  {expanded === d.id && (
                    <div className="px-4 py-4 bg-[var(--color-surface-secondary)] text-sm text-[var(--color-text-secondary)]">
                      {d.rationale}
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

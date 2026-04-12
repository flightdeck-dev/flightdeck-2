import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Decision, DecisionStatus } from '../lib/types.ts';

type Ctx = { decisions: Decision[] };

const STATUS_STYLES: Record<DecisionStatus, { bg: string; text: string }> = {
  confirmed: { bg: 'color-mix(in srgb, var(--color-status-done) 15%, transparent)', text: 'var(--color-status-done)' },
  recorded: { bg: 'color-mix(in srgb, var(--color-status-ready) 15%, transparent)', text: 'var(--color-status-ready)' },
  rejected: { bg: 'color-mix(in srgb, var(--color-status-failed) 15%, transparent)', text: 'var(--color-status-failed)' },
};

export default function Decisions() {
  const { decisions } = useOutletContext<Ctx>();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Decisions</h1>
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
            {decisions.map((d) => (
              <>
                <tr
                  key={d.id}
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium">{d.title}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{d.category}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: STATUS_STYLES[d.status].bg, color: STATUS_STYLES[d.status].text }}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[var(--color-text-tertiary)]">
                    {new Date(d.timestamp).toLocaleString()}
                  </td>
                </tr>
                {expanded === d.id && (
                  <tr key={`${d.id}-detail`} className="border-b border-[var(--color-border)]">
                    <td colSpan={4} className="px-4 py-4 bg-[var(--color-surface-secondary)] text-sm text-[var(--color-text-secondary)]">
                      {d.rationale}
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

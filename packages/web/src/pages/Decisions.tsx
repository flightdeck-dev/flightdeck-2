import { useState } from 'react';
import { useTasks } from '../hooks/useTasks.tsx';
import { useProject } from '../hooks/useProject.tsx';
import { Check, Circle, X, Landmark, Zap, Package, Palette, Pin, Scale } from 'lucide-react';
import type { Decision, DecisionStatus } from '../lib/types.ts';

const STATUS_STYLES: Record<DecisionStatus, { bg: string; text: string; icon: React.ReactNode }> = {
  confirmed: { bg: 'color-mix(in srgb, var(--color-status-done) 15%, transparent)', text: 'var(--color-status-done)', icon: <Check size={10} strokeWidth={2} /> },
  recorded: { bg: 'color-mix(in srgb, var(--color-status-ready) 15%, transparent)', text: 'var(--color-status-ready)', icon: <Circle size={10} strokeWidth={2} /> },
  rejected: { bg: 'color-mix(in srgb, var(--color-status-failed) 15%, transparent)', text: 'var(--color-status-failed)', icon: <X size={10} strokeWidth={2} /> },
};

const CATEGORY_STYLES: Record<string, { color: string; icon: React.ReactNode }> = {
  architecture: { color: 'var(--color-status-in-review)', icon: <Landmark size={14} strokeWidth={1.5} /> },
  implementation: { color: 'var(--color-status-running)', icon: <Zap size={14} strokeWidth={1.5} /> },
  dependency: { color: 'var(--color-status-ready)', icon: <Package size={14} strokeWidth={1.5} /> },
  design: { color: 'var(--color-status-done)', icon: <Palette size={14} strokeWidth={1.5} /> },
};

function DecisionCard({ decision, isExpanded, onToggle }: { decision: Decision; isExpanded: boolean; onToggle: () => void }) {
  const statusStyle = STATUS_STYLES[decision.status] ?? STATUS_STYLES.recorded;
  const catStyle = CATEGORY_STYLES[decision.category] ?? { color: 'var(--color-text-tertiary)', icon: <Pin size={14} strokeWidth={1.5} /> };

  return (
    <div className="relative pl-8">
      {/* Timeline dot */}
      <div className="absolute left-0 top-3 w-4 h-4 rounded-full border-2 flex items-center justify-center text-[8px]"
           style={{ borderColor: statusStyle.text, backgroundColor: statusStyle.bg, color: statusStyle.text }}>
        {statusStyle.icon}
      </div>

      <div className={`border border-[var(--color-border)] rounded-lg overflow-hidden hover:border-[var(--color-text-tertiary)] transition-colors cursor-pointer ${isExpanded ? 'bg-[var(--color-surface)]' : ''}`}
           onClick={onToggle}>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{decision.title}</p>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: `color-mix(in srgb, ${catStyle.color} 15%, transparent)`, color: catStyle.color }}>
              {catStyle.icon} {decision.category}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: statusStyle.bg, color: statusStyle.text }}>
                  {decision.status}
                </span>
              </div>
            </div>
            <span className="text-xs text-[var(--color-text-tertiary)] shrink-0">
              {new Date(decision.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
        {isExpanded && (
          <div className="px-4 pb-4 pt-0 border-t border-[var(--color-border)]">
            <p className="text-sm text-[var(--color-text-secondary)] mt-3 whitespace-pre-wrap">{decision.rationale}</p>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-2">
              {new Date(decision.timestamp).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Decisions() {
  const { decisions } = useTasks();
  const { loading } = useProject();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | 'all'>('all');

  if (loading) {
    return (
      <div className="max-w-4xl space-y-4">
        <div className="h-8 w-40 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 bg-[var(--color-surface-secondary)] rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Decisions</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <Scale size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
          <p>No decisions logged yet.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">Decisions will appear here as the Lead makes architectural and implementation choices.</p>
        </div>
      </div>
    );
  }

  const categories = [...new Set(decisions.map(d => d.category))];
  const filtered = categoryFilter === 'all' ? decisions : decisions.filter(d => d.category === categoryFilter);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Decisions ({decisions.length})</h1>
        <div className="flex gap-1">
          <button onClick={() => setCategoryFilter('all')}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${categoryFilter === 'all' ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
            All
          </button>
          {categories.map(c => (
            <button key={c} onClick={() => setCategoryFilter(c)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${categoryFilter === c ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
            {CATEGORY_STYLES[c]?.icon ?? <Pin size={14} strokeWidth={1.5} />} {c}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="relative space-y-3">
        {/* Timeline line */}
        <div className="absolute left-[7px] top-0 bottom-0 w-0.5 bg-[var(--color-border)]" />

        {filtered.map((d, i) => {
          const dateStr = new Date(d.timestamp).toLocaleDateString();
          const prevDateStr = i > 0 ? new Date(filtered[i - 1].timestamp).toLocaleDateString() : null;
          const showDateSeparator = i === 0 || dateStr !== prevDateStr;
          return (
            <div key={d.id}>
              {showDateSeparator && (
                <div className="relative pl-8 py-2">
                  <span className="text-xs font-medium text-[var(--color-text-tertiary)] bg-[var(--color-surface)] px-2 relative z-10">
                    {new Date(d.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
              )}
              <DecisionCard decision={d} isExpanded={expanded === d.id}
                onToggle={() => setExpanded(expanded === d.id ? null : d.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

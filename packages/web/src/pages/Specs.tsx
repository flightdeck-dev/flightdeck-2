import { useState, useEffect } from 'react';
import { api } from '../lib/api.ts';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';

interface Spec {
  id: string;
  filename?: string;
  title?: string;
  content?: string;
}

export default function Specs() {
  const { projectName } = useFlightdeck();
  const [specs] = useState<Spec[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    if (projectName) {
      api.getReport(projectName).then(r => { if (!cancelled) setReport(r); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, []);

  const activeSpec = specs.find(s => s.id === selected);

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Specs & Reports</h1>

      {specs.length > 0 ? (
        <div className="flex gap-6">
          <div className="w-56 shrink-0 space-y-1">
            {specs.map(s => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  selected === s.id
                    ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <p>{s.filename ?? s.title ?? s.id}</p>
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            {activeSpec?.content ? (
              <div className="p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">{activeSpec.content}</pre>
              </div>
            ) : (
              <div className="text-center py-16 text-[var(--color-text-secondary)]">Select a spec.</div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Daily Report</h2>
          <div className="p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
              {report || 'No report available yet. Start the daemon to generate reports.'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

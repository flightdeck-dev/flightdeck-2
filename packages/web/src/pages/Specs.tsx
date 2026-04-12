import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Spec } from '../lib/types.ts';

type Ctx = { specs: Spec[] };

export default function Specs() {
  const { specs } = useOutletContext<Ctx>();
  const [selected, setSelected] = useState<string | null>(null);
  const activeSpec = specs.find((s) => s.id === selected);

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Specs</h1>
      <div className="flex gap-6">
        <div className="w-56 shrink-0 space-y-1">
          {specs.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                selected === s.id
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <p>{s.name}</p>
              <p className="text-xs text-[var(--color-text-tertiary)] font-mono">{s.path}</p>
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          {activeSpec ? (
            <div className="p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-[var(--color-text-primary)]">
                {activeSpec.content}
              </pre>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-4">
                Updated: {new Date(activeSpec.updatedAt).toLocaleString()}
              </p>
            </div>
          ) : (
            <div className="text-center py-16 text-[var(--color-text-secondary)]">
              <p>Select a spec to view its content.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

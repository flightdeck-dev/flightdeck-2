import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { api } from '../lib/api.ts';
import { useProject } from '../hooks/useProject.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { FileText, XCircle } from 'lucide-react';

interface SpecFile {
  id: string;
  filename: string;
  title: string;
  content: string;
}

export default function Specs() {
  const { projectName } = useProject();
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const { mutate } = useSWRConfig();

  const { data: specs = [], isLoading: loading } = useSWR(
    projectName ? ['specs', projectName] : null,
    () => api.getSpecs(projectName!) as Promise<SpecFile[]>
  );

  const { data: report = '' } = useSWR(
    projectName ? ['report', projectName] : null,
    () => api.getReport(projectName!).catch(() => '')
  );

  // Auto-select first spec
  const effectiveSelected = selected ?? (specs.length > 0 ? specs[0].id : null);
  const activeSpec = specs.find(s => s.id === effectiveSelected);

  if (!projectName) {
    return <div className="p-8 text-[var(--color-text-secondary)]">Select a project to view specs.</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-xl font-semibold">Specs & Reports</h1>

      <div className="flex gap-6">
        {/* Spec list */}
        <div className="w-72 flex-shrink-0 space-y-2">
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-3">
            Spec Files
          </h2>

          {loading && specs.length === 0 && (
            <p className="text-sm text-[var(--color-text-tertiary)]">Loading...</p>
          )}

          {!loading && specs.length === 0 && (
            <div className="p-4 rounded-xl border border-dashed border-[var(--color-border)] text-center">
              <FileText size={24} className="mx-auto mb-2 text-[var(--color-text-tertiary)]" strokeWidth={1.5} />
              <p className="text-sm text-[var(--color-text-tertiary)]">
                No spec files found. Add <code>.md</code> files to your project's <code>specs/</code> directory.
              </p>
            </div>
          )}

          {specs.map(s => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${
                effectiveSelected === s.id
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <FileText size={16} className="text-[var(--color-text-tertiary)] shrink-0" strokeWidth={1.5} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{s.title}</p>
                  <p className="text-xs text-[var(--color-text-tertiary)] truncate">{s.filename}</p>
                </div>
              </div>
            </button>
          ))}

          {/* Daily Report link */}
          <div className="pt-4 border-t border-[var(--color-border)]">
            <button
              onClick={() => setSelected('__report__')}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${
                effectiveSelected === '__report__'
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span className="text-base">📊</span>
                <p className="text-sm font-medium text-[var(--color-text-primary)]">Daily Report</p>
              </div>
            </button>
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0">
          {effectiveSelected === '__report__' ? (
            <div className="p-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Daily Report</h2>
              {report ? (
                <div className="prose prose-sm max-w-none">
                  <Markdown content={report} />
                </div>
              ) : (
                <p className="text-sm text-[var(--color-text-tertiary)]">
                  No report available yet. Start the daemon to generate reports.
                </p>
              )}
            </div>
          ) : activeSpec ? (
            <div className="p-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{activeSpec.title}</h2>
                <button
                  disabled={cancelling === activeSpec.id}
                  onClick={async () => {
                    if (!projectName || !activeSpec) return;
                    if (!confirm(`Cancel spec "${activeSpec.title}" and all its incomplete tasks?`)) return;
                    setCancelling(activeSpec.id);
                    try {
                      await api.cancelSpec(projectName, activeSpec.id);
                      mutate(['specs', projectName]);
                    } catch { /* ignore */ }
                    setCancelling(null);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                >
                  <XCircle size={14} />
                  {cancelling === activeSpec.id ? 'Cancelling...' : 'Cancel Spec'}
                </button>
              </div>
              <div className="prose prose-sm max-w-none">
                <Markdown content={activeSpec.content} />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-sm text-[var(--color-text-tertiary)] border border-dashed border-[var(--color-border)] rounded-xl">
              Select a spec to view its contents
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

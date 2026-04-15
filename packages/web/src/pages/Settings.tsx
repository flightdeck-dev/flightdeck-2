import { useState, useEffect } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { api } from '../lib/api.ts';
import { DISPLAY_PRESET_NAMES, DISPLAY_PRESETS, type DisplayPreset, type ToolVisibility } from '@flightdeck-ai/shared/display';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  minimal: 'Final answers only — clean and focused',
  summary: 'Tool names + brief results',
  detail: 'Thinking + full tool details',
  debug: 'Everything visible — for debugging',
};

function VisibilitySelector({ value, onChange }: { value: ToolVisibility; onChange: (v: ToolVisibility) => void }) {
  const opts: ToolVisibility[] = ['off', 'summary', 'detail'];
  return (
    <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)]">
      {opts.map(o => (
        <button key={o} onClick={() => onChange(o)}
          className={`px-3 py-1 text-xs capitalize transition-colors ${
            value === o
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={`w-10 h-5 rounded-full transition-colors relative ${
        value ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)]'
      }`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
        value ? 'left-5' : 'left-0.5'
      }`} />
    </button>
  );
}

export default function Settings() {
  const { displayConfig, setDisplayConfig, applyDisplayPreset, status } = useFlightdeck();
  const [models, setModels] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    api.getModels().then(setModels).catch(() => {});
  }, []);

  const currentPreset = DISPLAY_PRESET_NAMES.find(p => {
    const preset = DISPLAY_PRESETS[p];
    return preset.thinking === displayConfig.thinking
      && preset.toolCalls === displayConfig.toolCalls
      && preset.flightdeckTools === displayConfig.flightdeckTools;
  }) ?? 'custom';

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Project Info */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Project</h2>
        <div className="p-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Name</span>
            <span className="text-sm font-mono text-[var(--color-text-secondary)]">{status?.config?.name ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Governance</span>
            <span className="text-sm px-2.5 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              {status?.config?.governance ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Total Cost</span>
            <span className="text-sm font-mono">${(status?.totalCost ?? 0).toFixed(2)}</span>
          </div>
        </div>
      </section>

      {/* Display Presets */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Display Presets</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {DISPLAY_PRESET_NAMES.map(p => (
            <button key={p} onClick={() => applyDisplayPreset(p as DisplayPreset)}
              className={`p-4 rounded-xl border text-left transition-colors ${
                currentPreset === p
                  ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-text-tertiary)]'
              }`}>
              <p className="text-sm font-medium capitalize">{p}</p>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-1">{PRESET_DESCRIPTIONS[p]}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Display Overrides */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Display Overrides</h2>
        <div className="p-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Thinking</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">Show model's reasoning process</p>
            </div>
            <Toggle value={displayConfig.thinking} onChange={v => setDisplayConfig({ thinking: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Tool Calls</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">External tool invocations</p>
            </div>
            <VisibilitySelector value={displayConfig.toolCalls} onChange={v => setDisplayConfig({ toolCalls: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Flightdeck Tools</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">Internal orchestration tools</p>
            </div>
            <VisibilitySelector value={displayConfig.flightdeckTools} onChange={v => setDisplayConfig({ flightdeckTools: v })} />
          </div>
        </div>
      </section>

      {/* Model Config */}
      {models && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Models</h2>
          <div className="p-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <pre className="text-xs font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap max-h-64 overflow-y-auto">
              {JSON.stringify(models, null, 2)}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}

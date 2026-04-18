import { useState, useEffect, useRef } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { DISPLAY_PRESET_NAMES, DISPLAY_PRESETS, type DisplayPreset, type ToolVisibility } from '@flightdeck-ai/shared/display';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  minimal: 'Final answers only',
  summary: 'Tool names + brief results',
  detail: 'Thinking + full tool details',
  debug: 'Everything visible',
};

export function DisplaySettings({ onClose }: { onClose: () => void }) {
  const { displayConfig, setDisplayConfig, applyDisplayPreset } = useFlightdeck();
  const [showOverrides, setShowOverrides] = useState(false);

  const currentPreset = DISPLAY_PRESET_NAMES.find(p => {
    const preset = DISPLAY_PRESETS[p];
    return preset.thinking === displayConfig.thinking
      && preset.toolCalls === displayConfig.toolCalls
      && preset.flightdeckTools === displayConfig.flightdeckTools;
  }) ?? 'custom';

  // M9: Basic focus trap — keep keyboard focus inside the dialog
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', handler);
    return () => dialog.removeEventListener('keydown', handler);
  }, [showOverrides]); // re-query focusable elements when overrides toggled

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end" onClick={onClose} role="dialog" aria-modal="true" aria-label="Display Settings" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div
        ref={dialogRef}
        className="mt-12 mr-4 w-80 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <span className="text-sm font-medium">Display Settings</span>
          <button onClick={onClose} aria-label="Close settings" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">✕</button>
        </div>

        {/* Presets */}
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <label className="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider">Preset</label>
          <div className="grid grid-cols-2 gap-1.5 mt-2">
            {DISPLAY_PRESET_NAMES.map(p => (
              <button
                key={p}
                onClick={() => applyDisplayPreset(p as DisplayPreset)}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  currentPreset === p
                    ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-text-tertiary)]'
                }`}
                title={PRESET_DESCRIPTIONS[p]}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Individual toggles */}
        <div className="px-4 py-3 space-y-3">
          {/* Thinking */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Thinking</span>
            <button
              onClick={() => setDisplayConfig({ thinking: !displayConfig.thinking })}
              className={`w-10 h-5 rounded-full transition-colors relative ${
                displayConfig.thinking ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-secondary)]'
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                displayConfig.thinking ? 'left-5' : 'left-0.5'
              }`} />
            </button>
          </div>

          {/* Tool calls */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Tool calls</span>
            <VisibilitySelector
              value={displayConfig.toolCalls}
              onChange={v => setDisplayConfig({ toolCalls: v })}
            />
          </div>

          {/* Flightdeck tools */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Flightdeck tools</span>
            <VisibilitySelector
              value={displayConfig.flightdeckTools}
              onChange={v => setDisplayConfig({ flightdeckTools: v })}
            />
          </div>
        </div>

        {/* Advanced: per-tool overrides */}
        <div className="px-4 py-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => setShowOverrides(!showOverrides)}
            className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            {showOverrides ? '▾' : '▸'} Per-tool overrides
          </button>
          {showOverrides && (
            <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
              {displayConfig.toolOverrides && Object.keys(displayConfig.toolOverrides).length > 0 ? (
                Object.entries(displayConfig.toolOverrides).map(([tool, vis]) => (
                  <div key={tool} className="flex items-center justify-between py-1">
                    <span className="font-mono">{tool}</span>
                    <VisibilitySelector
                      value={vis}
                      onChange={v => setDisplayConfig({
                        toolOverrides: { ...displayConfig.toolOverrides, [tool]: v }
                      })}
                    />
                  </div>
                ))
              ) : (
                <p className="py-1 text-[var(--color-text-tertiary)]">No overrides set. Tool-specific overrides appear here as tools are used.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VisibilitySelector({ value, onChange }: { value: ToolVisibility; onChange: (v: ToolVisibility) => void }) {
  const options: ToolVisibility[] = ['off', 'summary', 'detail'];
  return (
    <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-xs">
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-2 py-0.5 transition-colors ${
            value === opt
              ? 'bg-[var(--color-primary)] text-white'
              : 'hover:bg-[var(--color-surface-secondary)]'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

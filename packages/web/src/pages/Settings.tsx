import { useState, useEffect, useCallback } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { api } from '../lib/api.ts';
import { DISPLAY_PRESET_NAMES, DISPLAY_PRESETS, type DisplayPreset, type ToolVisibility } from '@flightdeck-ai/shared/display';
import { Zap, Loader2 } from 'lucide-react';

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

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">{children}</h2>;
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`p-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] space-y-4 ${className}`}>{children}</div>;
}

function RuntimeCard({ rt, projectName, enabled, onToggle }: { rt: { id: string; name: string; command: string; supportsAcp: boolean; adapter: string }; projectName: string; enabled: boolean; onToggle: (id: string, enabled: boolean) => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; installed: boolean; version?: string; message: string } | null>(null);

  const test = useCallback(async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testRuntime(projectName, rt.id);
      setResult(r);
    } catch (e) {
      setResult({ success: false, installed: false, message: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }, [rt.id, projectName]);

  return (
    <div className={`flex items-center justify-between py-3 border-b border-[var(--color-border)] last:border-0 ${!enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          onClick={() => onToggle(rt.id, !enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            enabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)]'
          }`}
          title={enabled ? `Disable ${rt.name}` : `Enable ${rt.name}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            enabled ? 'left-4' : 'left-0.5'
          }`} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{rt.name}</p>
          {result && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              result.success
                ? 'bg-green-500/10 text-green-400'
                : 'bg-red-500/10 text-red-400'
            }`}>
              {result.success ? (result.version ?? 'installed') : 'not found'}
            </span>
          )}
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)] font-mono">{rt.command}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={test}
          disabled={testing}
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-primary)] transition-colors disabled:opacity-50"
          title="Test connection"
        >
          {testing ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
          Test
        </button>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          rt.supportsAcp ? 'bg-green-500/10 text-green-500' : 'bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]'
        }`}>
          {rt.supportsAcp ? 'ACP' : 'PTY'}
        </span>
      </div>
    </div>
  );
}

/** Global settings — display, runtimes (no project context needed) */
function GlobalSettings() {
  const { displayConfig, setDisplayConfig, applyDisplayPreset } = useFlightdeck();
  const [runtimes, setRuntimes] = useState<Array<{ id: string; name: string; command: string; supportsAcp: boolean; adapter: string }> | null>(null);
  const [runtimeProject, setRuntimeProject] = useState<string>('');
  const [disabledRuntimes, setDisabledRuntimes] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(data => {
      const projects = data.projects ?? [];
      if (projects.length > 0) {
        const pName = projects[0].name;
        setRuntimeProject(pName);
        api.getRuntimes(pName).then(setRuntimes).catch(() => {});
        // Load disabled runtimes from project config
        fetch(`/api/projects/${pName}/status`).then(r => r.json()).then(status => {
          setDisabledRuntimes(status?.config?.disabledRuntimes ?? []);
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const toggleRuntime = useCallback(async (id: string, enabled: boolean) => {
    const newDisabled = enabled
      ? disabledRuntimes.filter(r => r !== id)
      : [...disabledRuntimes, id];
    setDisabledRuntimes(newDisabled);
    try {
      await api.updateProjectConfig(runtimeProject, { disabledRuntimes: newDisabled });
    } catch {
      // Revert on failure
      setDisabledRuntimes(disabledRuntimes);
    }
  }, [disabledRuntimes, runtimeProject]);

  const currentPreset = DISPLAY_PRESET_NAMES.find(p => {
    const preset = DISPLAY_PRESETS[p];
    return preset.thinking === displayConfig.thinking
      && preset.toolCalls === displayConfig.toolCalls
      && preset.flightdeckTools === displayConfig.flightdeckTools;
  }) ?? 'custom';

  return (
    <>
      {/* Display Presets */}
      <section className="space-y-3">
        <SectionHeader>Display Presets</SectionHeader>
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
        <SectionHeader>Display Overrides</SectionHeader>
        <Card>
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
        </Card>
      </section>

      {/* Runtimes */}
      {runtimes && runtimes.length > 0 && (
        <section className="space-y-3">
          <SectionHeader>Runtimes</SectionHeader>
          <Card>
            {runtimes.map(rt => (
              <RuntimeCard key={rt.id} rt={rt} projectName={runtimeProject} enabled={!disabledRuntimes.includes(rt.id)} onToggle={toggleRuntime} />
            ))}
          </Card>
        </section>
      )}
    </>
  );
}

/** Project-scoped settings — project info, heartbeat, governance */
function ProjectSettings() {
  const { status, projectName } = useFlightdeck();
  const [heartbeatEnabled, setHeartbeatEnabled] = useState<boolean>(true);
  const [idleTimeoutEnabled, setIdleTimeoutEnabled] = useState<boolean>(true);
  const [idleTimeoutDays, setIdleTimeoutDays] = useState<number>(3);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!status?.config) return;
    const cfg = status.config as any;
    setHeartbeatEnabled(cfg.heartbeatEnabled !== false);
    setIdleTimeoutEnabled((cfg.heartbeatIdleTimeoutDays ?? 3) > 0);
    setIdleTimeoutDays(cfg.heartbeatIdleTimeoutDays || 3);
  }, [status?.config]);

  const saveConfig = async (update: Record<string, unknown>) => {
    if (!projectName) return;
    setSaving(true);
    try { await api.updateProjectConfig(projectName, update); } catch {}
    setSaving(false);
  };

  if (!status) return null;

  return (
    <>
      {/* Project Info */}
      <section className="space-y-3">
        <SectionHeader>Project</SectionHeader>
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Name</span>
            <span className="text-sm font-mono text-[var(--color-text-secondary)]">{status.config?.name ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Governance</span>
            <select
              value={status.config?.governance ?? 'autonomous'}
              onChange={e => saveConfig({ governance: e.target.value })}
              className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer"
            >
              <option value="autonomous">autonomous</option>
              <option value="collaborative">collaborative</option>
              <option value="supervised">supervised</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Total Cost</span>
            <span className="text-sm font-mono">${(status.totalCost ?? 0).toFixed(2)}</span>
          </div>
        </Card>
      </section>

      {/* Heartbeat */}
      <section className="space-y-3">
        <SectionHeader>Heartbeat</SectionHeader>
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Enable heartbeat</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">Periodic Lead polling for status checks</p>
            </div>
            <Toggle value={heartbeatEnabled} onChange={async v => {
              setHeartbeatEnabled(v);
              await saveConfig({ heartbeatEnabled: v });
            }} />
          </div>
          {heartbeatEnabled && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">Idle timeout</p>
                  <p className="text-xs text-[var(--color-text-tertiary)]">Auto-stop heartbeat after inactivity</p>
                </div>
                <Toggle value={idleTimeoutEnabled} onChange={async v => {
                  setIdleTimeoutEnabled(v);
                  if (!v) await saveConfig({ heartbeatIdleTimeoutDays: 0 });
                }} />
              </div>
              {idleTimeoutEnabled && (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm">Timeout (days)</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={idleTimeoutDays}
                      onChange={e => setIdleTimeoutDays(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))}
                      className="w-16 px-2 py-1 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-right"
                    />
                    <button
                      disabled={saving}
                      onClick={() => saveConfig({ heartbeatIdleTimeoutDays: idleTimeoutDays })}
                      className="px-3 py-1 text-xs rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </section>
    </>
  );
}

export default function Settings() {
  const { projectName } = useFlightdeck();

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Project settings only when in project scope */}
      {projectName && <ProjectSettings />}

      {/* Global settings only when NOT in project scope */}
      {!projectName && <GlobalSettings />}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { useDisplay } from '../hooks/useDisplay.tsx';
import { api } from '../lib/api.ts';
import { DISPLAY_PRESET_NAMES, DISPLAY_PRESETS, type DisplayPreset, type ToolVisibility } from '@flightdeck-ai/shared/display';
import { Loader2 } from 'lucide-react';

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

interface RuntimeInfo {
  id: string; name: string; command: string; supportsAcp: boolean; adapter: string;
  icon?: string; docsUrl?: string; setupLinks?: Array<{ label: string; url: string }>;
  loginInstructions?: string; installHint?: string; supportsSessionLoad?: boolean;
}

function RuntimeCard({ rt, projectName: _projectName, enabled, onToggle, testResult, testing }: {
  rt: RuntimeInfo; projectName: string; enabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  testResult: { success: boolean; installed: boolean; version?: string; message: string } | null;
  testing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`border-b border-[var(--color-border)] last:border-0 ${!enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-3 py-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-lg shrink-0">{rt.icon ?? '🔌'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{rt.name}</p>
            {testing && <Loader2 size={12} className="animate-spin text-[var(--color-text-tertiary)]" />}
            {!testing && testResult && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                testResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {testResult.success ? (testResult.version ?? '✓ installed') : '✗ not found'}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)]">
            <span className="font-mono">{testResult?.success && testResult.message ? testResult.message : rt.command}</span>
            {rt.supportsSessionLoad && <span className="ml-2 opacity-60">· Resume</span>}
          </p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
          rt.supportsAcp ? 'bg-green-500/10 text-green-500' : 'bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]'
        }`}>
          {rt.adapter === 'copilot-sdk' ? 'SDK' : rt.supportsAcp ? 'ACP' : 'PTY'}
        </span>
        <button
          onClick={e => { e.stopPropagation(); onToggle(rt.id, !enabled); }}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            enabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)]'
          }`}
          title={enabled ? `Disable ${rt.name}` : `Enable ${rt.name}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            enabled ? 'left-4' : 'left-0.5'
          }`} />
        </button>
      </div>

      {expanded && (
        <div className="pl-[4.5rem] pb-3 space-y-2 text-xs">
          {!testResult?.success && rt.installHint && (
            <div className="bg-[var(--color-surface-secondary)] rounded-md p-2">
              <p className="text-[var(--color-text-tertiary)] mb-1">Install:</p>
              <code className="text-[var(--color-text-secondary)] font-mono text-[11px]">{rt.installHint}</code>
            </div>
          )}
          {!testResult?.success && rt.loginInstructions && (
            <p className="text-[var(--color-text-tertiary)]">{rt.loginInstructions}</p>
          )}
          {rt.setupLinks && rt.setupLinks.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {rt.setupLinks.map(link => (
                <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"
                  className="text-[var(--color-primary)] hover:underline inline-flex items-center gap-1">
                  {link.label} ↗
                </a>
              ))}
              {rt.docsUrl && !rt.setupLinks.some(l => l.url === rt.docsUrl) && (
                <a href={rt.docsUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[var(--color-primary)] hover:underline inline-flex items-center gap-1">
                  Docs ↗
                </a>
              )}
            </div>
          )}
          {!rt.setupLinks?.length && rt.docsUrl && (
            <a href={rt.docsUrl} target="_blank" rel="noopener noreferrer"
              className="text-[var(--color-primary)] hover:underline inline-flex items-center gap-1">
              Documentation ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Global settings — display, runtimes (no project context needed) */
function GlobalSettings() {
  const { displayConfig, setDisplayConfig, applyDisplayPreset } = useDisplay();
  const [dragId, setDragId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; installed: boolean; version?: string; message: string }>>({});
  const [testingSet, setTestingSet] = useState<Set<string>>(new Set());

  // Fetch projects to get first project name for runtime context
  const { data: projectsData } = useSWR('projects-for-settings', () =>
    fetch('/api/projects').then(r => r.json()).then(d => d.projects ?? [])
  );
  const runtimeProject = projectsData?.[0]?.name ?? '';

  const { data: runtimesData, mutate: _mutateRuntimes } = useSWR(
    runtimeProject ? ['runtimes-settings', runtimeProject] : null,
    () => api.getRuntimes(runtimeProject) as Promise<RuntimeInfo[]>
  );
  const runtimes = runtimesData ?? null;

  const { data: globalCfg } = useSWR('global-config', () =>
    fetch('/api/global-config').then(r => r.json())
  );
  const [disabledRuntimes, setDisabledRuntimes] = useState<string[]>([]);
  const [runtimeOrder, setRuntimeOrder] = useState<string[]>([]);
  const [disabledLoaded, setDisabledLoaded] = useState(false);

  useEffect(() => {
    if (globalCfg) {
      if (globalCfg.disabledRuntimes) setDisabledRuntimes(globalCfg.disabledRuntimes);
      if (globalCfg.runtimeOrder) setRuntimeOrder(globalCfg.runtimeOrder);
      setDisabledLoaded(true);
    }
  }, [globalCfg]);

  // Test runtimes when they load
  useEffect(() => {
    if (!runtimes || !runtimeProject) return;
    runtimes.forEach(rt => {
      setTestingSet(prev => new Set(prev).add(rt.id));
      api.testRuntime(runtimeProject, rt.id)
        .then(result => {
          setTestResults(prev => ({ ...prev, [rt.id]: result }));
        })
        .catch(() => {
          setTestResults(prev => ({ ...prev, [rt.id]: { success: false, installed: false, message: 'Test failed' } }));
        })
        .finally(() => {
          setTestingSet(prev => { const next = new Set(prev); next.delete(rt.id); return next; });
        });
    });
  }, [runtimes, runtimeProject]);

  const toggleRuntime = useCallback(async (id: string, enabled: boolean) => {
    const newDisabled = enabled
      ? disabledRuntimes.filter(r => r !== id)
      : [...disabledRuntimes, id];
    setDisabledRuntimes(newDisabled);
    try {
      await fetch('/api/global-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabledRuntimes: newDisabled }) });
    } catch {
      setDisabledRuntimes(disabledRuntimes);
    }
  }, [disabledRuntimes, runtimeProject]);

  const getSortedRuntimes = useCallback(() => {
    if (!runtimes) return [];
    return [...runtimes].sort((a, b) => {
      const ia = runtimeOrder.indexOf(a.id);
      const ib = runtimeOrder.indexOf(b.id);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
  }, [runtimes, runtimeOrder]);

  const handleDrop = useCallback(async (targetId: string) => {
    if (!dragId || dragId === targetId || !runtimes) return;
    const sorted = getSortedRuntimes();
    const order = sorted.map(rt => rt.id);
    const fromIdx = order.indexOf(dragId);
    const toIdx = order.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, dragId);
    setRuntimeOrder(order);
    setDragId(null);
    try {
      await api.updateProjectConfig(runtimeProject, { runtimeOrder: order });
    } catch {
      setRuntimeOrder(runtimeOrder);
    }
  }, [dragId, runtimes, runtimeOrder, runtimeProject, getSortedRuntimes]);

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
          <div className="flex items-center justify-between">
            <SectionHeader>Runtimes</SectionHeader>
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              {Object.values(testResults).filter(r => r.success).length}/{runtimes.length} installed
            </span>
          </div>
          <Card>
            {getSortedRuntimes().map((rt) => (
              <div key={rt.id}
                draggable
                onDragStart={() => setDragId(rt.id)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(rt.id)}
                className={`flex items-center transition-opacity ${dragId === rt.id ? 'opacity-40' : ''}`}
              >
                <span className="cursor-grab active:cursor-grabbing text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] px-1 select-none" title="Drag to reorder">≡</span>
                <div className="flex-1">
                  <RuntimeCard rt={rt} projectName={runtimeProject}
                    enabled={disabledLoaded ? !disabledRuntimes.includes(rt.id) : !(rt as any).disabledByDefault}
                    onToggle={toggleRuntime} testResult={testResults[rt.id] ?? null} testing={testingSet.has(rt.id)} />
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}
    </>
  );
}

/** Project-scoped settings — project info, heartbeat, governance */
function ProjectSettings() {
  const { status, projectName } = useProject();
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
            <span className="text-sm">Isolation</span>
            <select
              value={(status.config as any)?.isolation ?? 'file_lock'}
              onChange={e => saveConfig({ isolation: e.target.value })}
              className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer"
            >
              <option value="file_lock">File Lock (shared directory)</option>
              <option value="git_worktree">Git Worktree (per-task branches)</option>
            </select>
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
  const { projectName } = useProject();

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

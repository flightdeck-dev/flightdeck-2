import { useState, useEffect, useCallback, useRef } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { useDisplay } from '../hooks/useDisplay.tsx';
import { api } from '../lib/api.ts';
import { DISPLAY_PRESET_NAMES, DISPLAY_PRESETS, type DisplayPreset, type ToolVisibility } from '@flightdeck-ai/shared/display';
import { useAgents as useAgentsHook } from '../hooks/useAgents.tsx';
import { Loader2, X, FileText, Trash2 } from 'lucide-react';

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
      className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
        value ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)]'
      }`}>
      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
        value ? 'left-[22px]' : 'left-[2px]'
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
  icon?: string; iconUrl?: string; docsUrl?: string; setupLinks?: Array<{ label: string; url: string }>;
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
        <span className="text-lg shrink-0">{rt.iconUrl ? <img src={rt.iconUrl} alt="" className="w-5 h-5 inline" /> : (rt.icon ?? '🔌')}</span>
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
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; installed: boolean; version?: string; message: string }>>({});
  const [testingSet, setTestingSet] = useState<Set<string>>(new Set());

  // Fetch projects to get first project name for runtime context
  const { data: projectsData } = useSWR('projects-for-settings', () =>
    fetch('/api/projects').then(r => r.json()).then(d => d.projects ?? [])
  );
  const runtimeProject = projectsData?.[0]?.name ?? '';

  const { data: runtimesData, mutate: mutateRuntimes } = useSWR(
    'runtimes-global',
    () => fetch('/api/runtimes').then(r => r.json()) as Promise<RuntimeInfo[]>
  );
  const runtimes = runtimesData ?? null;

  const { data: customRuntimes, mutate: mutateCustom } = useSWR('custom-runtimes',
    () => fetch('/api/custom-runtimes').then(r => r.json()) as Promise<Record<string, any>>
  );

  const { data: globalCfg } = useSWR('global-config', () =>
    fetch('/api/global-config').then(r => r.json())
  );
  const [disabledRuntimes, setDisabledRuntimes] = useState<string[]>([]);
  const [globalConfig, setGlobalConfig] = useState<any>({});
  const [runtimeOrder, setRuntimeOrder] = useState<string[]>([]);
  const [disabledLoaded, setDisabledLoaded] = useState(false);

  useEffect(() => {
    if (globalCfg) {
      if (globalCfg.disabledRuntimes) setDisabledRuntimes(globalCfg.disabledRuntimes);
      if (globalCfg.runtimeOrder) setRuntimeOrder(globalCfg.runtimeOrder);
      setGlobalConfig(globalCfg);
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
    setDisabledRuntimes(prev => {
      const newDisabled = enabled
        ? prev.filter(r => r !== id)
        : [...prev, id];
      fetch('/api/global-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabledRuntimes: newDisabled }) })
        .catch(() => setDisabledRuntimes(prev));
      return newDisabled;
    });
  }, []);

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
    setDragOverId(null);
    try {
      const res = await fetch('/api/global-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtimeOrder: order }),
      });
      if (!res.ok) console.error('Failed to save runtime order');
    } catch { /* best effort */ }
  }, [dragId, runtimes, getSortedRuntimes]);

  const currentPreset = DISPLAY_PRESET_NAMES.find(p => {
    const preset = DISPLAY_PRESETS[p];
    return preset.thinking === displayConfig.thinking
      && preset.toolCalls === displayConfig.toolCalls
      && preset.flightdeckTools === displayConfig.flightdeckTools;
  }) ?? 'custom';

  const { data: registryAgents, mutate: mutateRegistry } = useSWR('acp-registry', 
    () => fetch('/api/registry').then(r => r.json()).then(d => Array.isArray(d) ? d : []),
    { revalidateOnFocus: false }
  );
  const [addedAgents, setAddedAgents] = useState<Set<string>>(new Set());
  const [addingAgent, setAddingAgent] = useState<string | null>(null);
  const [removingRuntime, setRemovingRuntime] = useState<string | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualSaved, setManualSaved] = useState(false);

  const removeCustomRuntime = useCallback(async (id: string) => {
    setRemovingRuntime(id);
    try {
      const res = await fetch('/api/custom-runtimes');
      const existing = await res.json();
      const updated = { ...existing };
      delete updated[id];
      await fetch('/api/custom-runtimes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      mutateCustom();
      mutateRuntimes();
      setAddedAgents(prev => { const next = new Set(prev); next.delete(id); return next; });
    } catch { /* best effort */ }
    setRemovingRuntime(null);
  }, [mutateCustom, mutateRuntimes]);

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

      {/* Timezone */}
      <section className="space-y-3">
        <SectionHeader>Timezone</SectionHeader>
        <Card>
          <div className="flex items-center justify-between">
            <span className="text-sm">Project Timezone</span>
            <select
              value={globalConfig?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
              onChange={async e => {
                await fetch('/api/global-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: e.target.value }) });
                setGlobalConfig((prev: any) => ({ ...prev, timezone: e.target.value }));
              }}
              className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer max-w-[200px]"
            >
              {['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage','Pacific/Honolulu','Europe/London','Europe/Paris','Europe/Berlin','Europe/Moscow','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','Asia/Singapore','Australia/Sydney','Pacific/Auckland'].map(tz => (
                <option key={tz} value={tz}>{tz.replace(/_/g,' ')}</option>
              ))}
            </select>
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
            {getSortedRuntimes().map((rt) => {
              const isCustom = customRuntimes && rt.id in customRuntimes;
              return (
              <div key={rt.id}
                draggable
                onDragStart={() => setDragId(rt.id)}
                onDragOver={e => { e.preventDefault(); setDragOverId(rt.id); }}
                onDragLeave={() => setDragOverId(null)}
                onDrop={() => handleDrop(rt.id)}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                className={`flex items-center transition-all duration-200 ${dragId === rt.id ? 'opacity-30 scale-95' : ''} ${dragOverId === rt.id && dragId !== rt.id ? 'border-l-2 border-[var(--color-primary)] pl-1' : ''}`}
              >
                <span className="cursor-grab active:cursor-grabbing text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] px-1 select-none" title="Drag to reorder">≡</span>
                <div className="flex-1">
                  <RuntimeCard rt={rt} projectName={runtimeProject}
                    enabled={disabledLoaded ? !disabledRuntimes.includes(rt.id) : true}
                    onToggle={toggleRuntime} testResult={testResults[rt.id] ?? null} testing={testingSet.has(rt.id)} />
                </div>
                {isCustom && (
                  <button
                    onClick={() => removeCustomRuntime(rt.id)}
                    disabled={removingRuntime === rt.id}
                    className="ml-1 p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    title="Remove custom runtime"
                  >
                    {removingRuntime === rt.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                )}
              </div>
              );
            })}
          </Card>
        </section>
      )}

      {/* Add from Registry */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>ACP Agent Registry</SectionHeader>
          <button
            onClick={() => mutateRegistry()}
            className="text-[10px] px-2 py-0.5 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            ↻ Refresh
          </button>
        </div>
        {registryAgents && registryAgents.length > 0 && (
          <Card>
            {registryAgents.length === 0 && <p className="text-sm text-[var(--color-text-tertiary)]">No agents found in registry.</p>}
            {registryAgents.map(agent => {
              const alreadyBuiltIn = runtimes?.some(rt => (rt as any).registryId === agent.id);
              const alreadyAdded = addedAgents.has(agent.id) || (customRuntimes && agent.id in customRuntimes);
              const isAdding = addingAgent === agent.id;
              return (
                <div key={agent.id} className="flex items-center gap-3 py-2 border-b border-[var(--color-border)] last:border-0">
                  {agent.icon ? <img src={agent.icon} alt="" className="w-5 h-5 shrink-0" /> : <span className="text-lg">🔌</span>}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text-primary)]">{agent.name}</p>
                    <p className="text-xs text-[var(--color-text-tertiary)] truncate">{agent.description}</p>
                  </div>
                  {alreadyBuiltIn ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]">Built-in</span>
                  ) : alreadyAdded ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">✓ Added</span>
                      <button
                        onClick={() => removeCustomRuntime(agent.id)}
                        disabled={removingRuntime === agent.id}
                        className="p-1 rounded text-[var(--color-text-tertiary)] hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Remove"
                      >
                        {removingRuntime === agent.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={isAdding}
                      onClick={async () => {
                        setAddingAgent(agent.id);
                        const customRt: any = {
                          name: agent.name,
                          command: agent.id,
                          args: agent.distribution?.npx?.args ?? [],
                        };
                        if (agent.distribution?.npx?.env) customRt.env = agent.distribution.npx.env;
                        if (agent.distribution?.npx?.package) {
                          const pkg = agent.distribution.npx.package;
                          const atIdx = pkg.lastIndexOf('@');
                          const basePkg = atIdx > 0 ? pkg.substring(0, atIdx) : pkg;
                          customRt.installHint = `npm install -g ${basePkg}`;
                        }
                        try {
                          const res = await fetch('/api/custom-runtimes');
                          const existing = await res.json();
                          const updated = { ...existing, [agent.id]: customRt };
                          await fetch('/api/custom-runtimes', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(updated),
                          });
                          setAddedAgents(prev => new Set(prev).add(agent.id));
                          mutateCustom();
                          mutateRuntimes();
                        } catch { /* best effort */ }
                        setAddingAgent(null);
                      }}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-primary)] text-white hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      {isAdding ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </div>
              );
            })}
          </Card>
        )}

        {/* Manual Add Custom Runtime */}
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none mb-2">
            ➕ Add custom runtime manually
          </summary>
        <Card>
          <div className="space-y-2">
            <input id="custom-rt-id" placeholder="Runtime ID (e.g. my-agent)" className="w-full text-sm px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-tertiary)]" />
            <input id="custom-rt-name" placeholder="Display name" className="w-full text-sm px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-tertiary)]" />
            <input id="custom-rt-cmd" placeholder="Command (e.g. my-agent-acp)" className="w-full text-sm px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-tertiary)]" />
            <input id="custom-rt-args" placeholder="Args (comma-separated, optional)" className="w-full text-sm px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-tertiary)]" />
            <input id="custom-rt-env" placeholder="Env vars (KEY=VALUE, comma-separated, optional)" className="w-full text-sm px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-tertiary)]" />
            <button
              disabled={manualSaving}
              onClick={async () => {
                const id = (document.getElementById('custom-rt-id') as HTMLInputElement)?.value?.trim();
                const name = (document.getElementById('custom-rt-name') as HTMLInputElement)?.value?.trim();
                const cmd = (document.getElementById('custom-rt-cmd') as HTMLInputElement)?.value?.trim();
                const argsStr = (document.getElementById('custom-rt-args') as HTMLInputElement)?.value?.trim();
                const envStr = (document.getElementById('custom-rt-env') as HTMLInputElement)?.value?.trim();
                if (!id || !name || !cmd) return;
                const args = argsStr ? argsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
                const env: Record<string, string> = {};
                if (envStr) {
                  for (const pair of envStr.split(',')) {
                    const [k, ...v] = pair.split('=');
                    if (k?.trim() && v.length) env[k.trim()] = v.join('=').trim();
                  }
                }
                setManualSaving(true);
                setManualSaved(false);
                try {
                  const res = await fetch('/api/custom-runtimes');
                  const existing = await res.json();
                  await fetch('/api/custom-runtimes', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...existing, [id]: { name, command: cmd, args, ...(Object.keys(env).length ? { env } : {}) } }),
                  });
                  ['custom-rt-id','custom-rt-name','custom-rt-cmd','custom-rt-args','custom-rt-env'].forEach(x => {
                    const el = document.getElementById(x) as HTMLInputElement; if (el) el.value = '';
                  });
                  mutateCustom();
                  mutateRuntimes();
                  setManualSaved(true);
                  setTimeout(() => setManualSaved(false), 2000);
                } catch { /* */ }
                setManualSaving(false);
              }}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >{manualSaving ? 'Saving…' : manualSaved ? '✓ Saved' : 'Save'}</button>
          </div>
        </Card>
        </details>
      </section>

      {/* Chat Bridges */}
      <ChatBridgesSection globalCfg={globalCfg} />

      {/* Debug */}
      <DebugLogSection />
    </>
  );
}

function DebugLogSection() {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?tail=100');
      const data = await res.json();
      setLogs(data.lines ?? []);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <SectionHeader>Gateway Logs</SectionHeader>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); fetchLogs().finally(() => setLoading(false)); }}
            className="text-[10px] px-2 py-0.5 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
          >{loading ? 'Loading…' : '↻ Load'}</button>
          <label className="flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)]">
            <input type="checkbox" checked={autoRefresh} onChange={e => { setAutoRefresh(e.target.checked); if (e.target.checked) fetchLogs(); }} className="w-3 h-3" />
            Auto-refresh
          </label>
        </div>
      </div>
      {logs.length > 0 && (
        <Card>
          <div className="max-h-[400px] overflow-y-auto font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {logs.map((line, i) => (
              <div key={i} className={line.includes('error') || line.includes('Error') || line.includes('FAIL') ? 'text-[var(--color-status-failed)]' : ''}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
        </Card>
      )}
    </section>
  );
}

/** Visual editor for channel/chat map (project name → channel ID) */
function ChannelMapEditor({ value, onChange, idLabel = 'Channel ID' }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; idLabel?: string }) {
  const entries = Object.entries(value);

  const addRow = () => {
    onChange({ ...value, '': '' });
  };

  const removeRow = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const updateRow = (oldKey: string, newKey: string, newValue: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === oldKey) {
        next[newKey] = newValue;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-2 text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-wider px-1">
        <span className="flex-1">Project</span>
        <span className="flex-1">{idLabel}</span>
        <span className="w-6" />
      </div>
      {entries.map(([key, val], i) => (
        <div key={i} className="flex gap-2 items-center">
          <input type="text" value={key} placeholder="project-name"
            onChange={e => updateRow(key, e.target.value, val)}
            className="flex-1 px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface)] outline-none focus:border-[var(--color-primary)]" />
          <input type="text" value={val} placeholder="123456789"
            onChange={e => updateRow(key, key, e.target.value)}
            className="flex-1 px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface)] outline-none focus:border-[var(--color-primary)]" />
          <button onClick={() => removeRow(key)} className="w-6 h-6 flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-red-400 rounded transition-colors" title="Remove">×</button>
        </div>
      ))}
      <button onClick={addRow} className="text-xs text-[var(--color-primary)] hover:underline mt-1">+ Add mapping</button>
    </div>
  );
}

function ChatBridgesSection({ globalCfg }: { globalCfg: any }) {
  const [bridges, setBridges] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (globalCfg?.bridges) setBridges(globalCfg.bridges);
    else setBridges({ discord: { enabled: false, token: '', guildId: '', channelMap: {}, streamMode: 'partial', autoThread: false, requireMention: true, slashCommands: true }, telegram: { enabled: false, token: '', chatMap: {} }, signal: { enabled: false, phoneNumber: '', apiUrl: 'http://localhost:8080', chatMap: {} } });
  }, [globalCfg]);

  const save = useCallback(async (updated: any) => {
    setBridges(updated);
    setSaving(true);
    try {
      await fetch('/api/global-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bridges: updated }) });
    } catch {} finally { setSaving(false); }
  }, []);

  const updateField = (platform: string, field: string, value: any) => {
    const updated = { ...bridges, [platform]: { ...bridges[platform], [field]: value } };
    save(updated);
  };

  if (!bridges) return null;

  return (
    <section className="space-y-3">
      <SectionHeader>Chat Bridges {saving && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}</SectionHeader>

      {/* Discord */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Discord</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">Connect a Discord bot to relay messages</p>
          </div>
          <Toggle value={bridges.discord?.enabled ?? false} onChange={v => updateField('discord', 'enabled', v)} />
        </div>
        {bridges.discord?.enabled && (
          <div className="space-y-3 mt-2">
            <input type="password" placeholder="Bot Token" value={bridges.discord?.token ?? ''}
              onChange={e => updateField('discord', 'token', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] focus:border-[var(--color-primary)] outline-none" />
            <input type="text" placeholder="Guild ID (optional)" value={bridges.discord?.guildId ?? ''}
              onChange={e => updateField('discord', 'guildId', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] focus:border-[var(--color-primary)] outline-none" />

            {/* Stream Mode */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Stream Mode</p>
                <p className="text-xs text-[var(--color-text-tertiary)]">How Lead responses are delivered</p>
              </div>
              <select value={bridges.discord?.streamMode ?? 'partial'}
                onChange={e => updateField('discord', 'streamMode', e.target.value)}
                className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer">
                <option value="off">Off — complete message</option>
                <option value="partial">Partial — live edits</option>
                <option value="block">Block — thinking → final</option>
              </select>
            </div>

            {/* Auto Thread */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Auto-Thread</p>
                <p className="text-xs text-[var(--color-text-tertiary)]">Create thread per conversation</p>
              </div>
              <Toggle value={bridges.discord?.autoThread ?? false} onChange={v => updateField('discord', 'autoThread', v)} />
            </div>

            {/* Require Mention */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Require @mention</p>
                <p className="text-xs text-[var(--color-text-tertiary)]">Only respond when bot is mentioned (channels only)</p>
              </div>
              <Toggle value={bridges.discord?.requireMention ?? true} onChange={v => updateField('discord', 'requireMention', v)} />
            </div>

            {/* Slash Commands */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Slash Commands</p>
                <p className="text-xs text-[var(--color-text-tertiary)]">/fd status, agents, tasks, model</p>
              </div>
              <Toggle value={bridges.discord?.slashCommands ?? true} onChange={v => updateField('discord', 'slashCommands', v)} />
            </div>

            {/* Channel Map */}
            <div className="pt-2 border-t border-[var(--color-border)]">
              <p className="text-sm mb-2">Channel Map</p>
              <ChannelMapEditor
                value={bridges.discord?.channelMap ?? {}}
                onChange={v => updateField('discord', 'channelMap', v)}
                idLabel="Channel ID"
              />
            </div>
          </div>
        )}
      </Card>

      {/* Telegram */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Telegram</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">Connect a Telegram bot</p>
          </div>
          <Toggle value={bridges.telegram?.enabled ?? false} onChange={v => updateField('telegram', 'enabled', v)} />
        </div>
        {bridges.telegram?.enabled && (
          <div className="space-y-3 mt-2">
            <input type="password" placeholder="Bot Token" value={bridges.telegram?.token ?? ''}
              onChange={e => updateField('telegram', 'token', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] focus:border-[var(--color-primary)] outline-none" />
            <div className="pt-2 border-t border-[var(--color-border)]">
              <p className="text-sm mb-2">Chat Map</p>
              <ChannelMapEditor
                value={bridges.telegram?.chatMap ?? {}}
                onChange={v => updateField('telegram', 'chatMap', v)}
                idLabel="Chat ID"
              />
            </div>
          </div>
        )}
      </Card>

      {/* Signal */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Signal</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">Connect via signal-cli REST API</p>
          </div>
          <Toggle value={bridges.signal?.enabled ?? false} onChange={v => updateField('signal', 'enabled', v)} />
        </div>
        {bridges.signal?.enabled && (
          <div className="space-y-3 mt-2">
            <input type="text" placeholder="Phone Number (+1234567890)" value={bridges.signal?.phoneNumber ?? ''}
              onChange={e => updateField('signal', 'phoneNumber', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] focus:border-[var(--color-primary)] outline-none" />
            <input type="text" placeholder="API URL (default: http://localhost:8080)" value={bridges.signal?.apiUrl ?? 'http://localhost:8080'}
              onChange={e => updateField('signal', 'apiUrl', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] focus:border-[var(--color-primary)] outline-none" />
            <div className="pt-2 border-t border-[var(--color-border)]">
              <p className="text-sm mb-2">Chat Map</p>
              <ChannelMapEditor
                value={bridges.signal?.chatMap ?? {}}
                onChange={v => updateField('signal', 'chatMap', v)}
                idLabel="Phone / Group"
              />
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

const DEFAULT_MEMORY_FILES: { filename: string; description: string }[] = [
  { filename: 'SOUL.md', description: 'Agent personality and tone' },
  { filename: 'USER.md', description: 'User preferences and context' },
  { filename: 'MEMORY.md', description: 'Long-term curated memory' },
  { filename: 'AGENTS.md', description: 'Worker instructions and conventions' },
  { filename: 'role-preference.md', description: 'Task planning guidance for Planner' },
];

interface MemoryFileInfo {
  filename: string;
  size: number;
  preview: string;
}

function MemoryFileEditor({ projectName, filename, onClose }: { projectName: string; filename: string; onClose: () => void }) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef('');
  const originalRef = useRef('');

  const hasChanges = content !== original;

  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectName)}/memory/${encodeURIComponent(filename)}`)
      .then(r => r.ok ? r.json() : { content: '' })
      .then(d => { const c = d.content ?? ''; setContent(c); setOriginal(c); contentRef.current = c; originalRef.current = c; })
      .catch(() => { setContent(''); setOriginal(''); contentRef.current = ''; originalRef.current = ''; })
      .finally(() => setLoading(false));
  }, [projectName, filename]);

  useEffect(() => {
    if (!loading && textareaRef.current) textareaRef.current.focus();
  }, [loading]);

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(projectName)}/memory/${encodeURIComponent(filename)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentRef.current }),
      });
      setOriginal(contentRef.current);
      originalRef.current = contentRef.current;
    } catch {}
    setSaving(false);
  };

  const handleClose = () => {
    if (contentRef.current !== originalRef.current && !window.confirm('You have unsaved changes. Discard?')) return;
    onClose();
  };

  // #2: Use refs to avoid stale closure
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projectName, filename]);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-bg)] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-3">
          <FileText size={16} className="text-[var(--color-text-tertiary)]" />
          <span className="text-sm font-mono font-medium">{filename}</span>
          {hasChanges && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-500">unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={saving || !hasChanges}
            className="px-4 py-1.5 text-sm rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]" aria-label="Close editor">
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="flex-1 p-4 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>
        ) : (
          <textarea ref={textareaRef} value={content} onChange={e => { setContent(e.target.value); contentRef.current = e.target.value; }}
            className="w-full h-full resize-none font-mono text-sm p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)]"
            spellCheck={false} />
        )}
      </div>
    </div>
  );
}

function IdentityMemorySection({ projectName }: { projectName: string }) {
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/memory`);
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch {}
  }, [projectName]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Merge default files with actual files
  const allFiles = DEFAULT_MEMORY_FILES.map(def => {
    const found = files.find(f => f.filename === def.filename);
    return { ...def, size: found?.size ?? 0, preview: found?.preview ?? '' };
  });
  // Add extra .md files not in defaults
  const extraFiles = files.filter(f => !DEFAULT_MEMORY_FILES.some(d => d.filename === f.filename));

  const formatSize = (bytes: number) => {
    if (bytes === 0) return 'empty';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  const getPreviewLines = (preview: string) => {
    if (!preview) return 'No content yet';
    return preview.split('\n').slice(0, 3).join('\n').slice(0, 150);
  };

  return (
    <>
      {editing && <MemoryFileEditor projectName={projectName} filename={editing} onClose={() => { setEditing(null); loadFiles(); }} />}
      <section className="space-y-3">
        <SectionHeader>Identity & Memory</SectionHeader>
        <Card className="space-y-0 !p-0 divide-y divide-[var(--color-border)]">
          {[...allFiles, ...extraFiles.map(f => ({ filename: f.filename, description: '', size: f.size, preview: f.preview }))].map(file => (
            <div key={file.filename} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--color-surface-hover)] transition-colors">
              <FileText size={16} className="text-[var(--color-text-tertiary)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono font-medium">{file.filename}</span>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">{formatSize(file.size)}</span>
                </div>
                {'description' in file && file.description && (
                  <p className="text-xs text-[var(--color-text-tertiary)]">{file.description}</p>
                )}
                <p className="text-xs text-[var(--color-text-tertiary)] truncate mt-0.5 opacity-60">
                  {getPreviewLines(file.preview)}
                </p>
              </div>
              <button onClick={() => setEditing(file.filename)}
                className="px-3 py-1 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] transition-colors shrink-0">
                Edit
              </button>
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}

/** Project-scoped settings — project info, heartbeat, governance */
function ProjectSettings() {
  const { status, projectName } = useProject();
  const { agents } = useAgentsHook();
  const [heartbeatEnabled, setHeartbeatEnabled] = useState<boolean>(false);
  const [scoutEnabled, setScoutEnabled] = useState<boolean>(false);
  const [idleTimeoutEnabled, setIdleTimeoutEnabled] = useState<boolean>(true);
  const [idleTimeoutDays, setIdleTimeoutDays] = useState<number>(3);
  const [saving, setSaving] = useState(false);
  const [restartingLead, setRestartingLead] = useState(false);
  const [leadRuntime, setLeadRuntime] = useState<string>("copilot");
  const [leadModel, setLeadModel] = useState<string>("");
  const [leadModelOptions, setLeadModelOptions] = useState<string[]>([]);
  const { data: availableRuntimes } = useSWR(
    projectName ? ['runtimes-project', projectName] : null,
    () => api.getRuntimes(projectName!) as Promise<RuntimeInfo[]>
  );
  const [cwd, setCwd] = useState<string>('');
  const [originalCwd, setOriginalCwd] = useState<string>('');

  useEffect(() => {
    if (!status?.config) return;
    const cfg = status.config as any;
    setHeartbeatEnabled(cfg.heartbeatEnabled === true);
    setScoutEnabled(cfg.scoutEnabled === true);
    setIdleTimeoutEnabled((cfg.heartbeatIdleTimeoutDays ?? 3) > 0);
    setIdleTimeoutDays(cfg.heartbeatIdleTimeoutDays || 3);
    setCwd(cfg.cwd ?? '');
    setOriginalCwd(cfg.cwd ?? '');
  }, [status?.config]);

  // Load lead runtime/model from model config
  useEffect(() => {
    if (!projectName) return;
    fetch(`/api/projects/${encodeURIComponent(projectName)}/models`).then(r => r.json()).then(data => {
      const lead = data.roles?.find((r: any) => r.role === "lead");
      if (lead) { setLeadRuntime(lead.runtime ?? "copilot"); setLeadModel(lead.model ?? "high"); }
    }).catch(() => {});
    // Fetch available models for dropdown (filtered by current runtime)
    fetch(`/api/projects/${encodeURIComponent(projectName)}/models/available`).then(r => r.json()).then(data => {
      const runtimeModels = data[leadRuntime];
      const all: string[] = [];
      if (runtimeModels) {
        for (const models of Object.values(runtimeModels)) {
          for (const m of models as any[]) { if (m.modelId && !all.includes(m.modelId)) all.push(m.modelId); }
        }
      }
      setLeadModelOptions(all);
    }).catch(() => {});
  }, [projectName, leadRuntime]);
  const saveConfig = async (update: Record<string, unknown>) => {
    if (!projectName) return;
    setSaving(true);
    try { await api.updateProjectConfig(projectName, update); } catch {}
    setSaving(false);
  };

  if (!status) return null;

  const activeLeads = agents.filter(a => a.role === 'lead' && a.status !== 'terminated' && a.status !== 'ended');

  const restartLead = async () => {
    if (!projectName) return;
    setRestartingLead(true);
    try {
      for (const lead of activeLeads) {
        await api.terminateAgent(projectName, lead.id);
      }
    } catch (err) {
      console.error('Failed to restart lead:', err);
    }
    setRestartingLead(false);
  };

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
            <span className="text-sm">Working Directory</span>
            <input
              type="text"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              onBlur={() => { if (cwd !== originalCwd) { saveConfig({ cwd }); setOriginalCwd(cwd); } }}
              placeholder="/path/to/project"
              className="w-64 text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] font-mono"
            />
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
          <div className="flex items-center justify-between">
            <span className="text-sm">Max Workers</span>
            <input
              type="number"
              min={1}
              max={100}
              value={(status.config as any)?.maxConcurrentWorkers ?? 30}
              onChange={e => saveConfig({ maxConcurrentWorkers: parseInt(e.target.value) || 30 })}
              className="w-20 text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] text-right"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Lead Runtime</span>
            <select value={leadRuntime} onChange={async e => { setLeadRuntime(e.target.value); if (projectName) { await fetch(`/api/projects/${encodeURIComponent(projectName)}/models/lead`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: e.target.value, model: leadModel }) }); } }} className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer">
              {availableRuntimes ? availableRuntimes.map(rt => (
                <option key={rt.id} value={rt.id}>{rt.name}</option>
              )) : (
                <option value={leadRuntime}>{leadRuntime}</option>
              )}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Lead Model</span>
            <select value={leadModel} onChange={async e => { setLeadModel(e.target.value); if (projectName) { await fetch(`/api/projects/${encodeURIComponent(projectName)}/models/lead`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: leadRuntime, model: e.target.value }) }); } }} className="text-sm px-2.5 py-1 rounded-lg bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer max-w-[200px]">
              <option value="">Select model...</option>
              {leadModelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {activeLeads.length > 0 && (
            <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
              <div>
                <p className="text-sm">Restart Lead</p>
                <p className="text-xs text-[var(--color-text-tertiary)]">Terminate active Lead(s) — will auto-respawn with current config</p>
              </div>
              <button
                disabled={restartingLead}
                onClick={restartLead}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-status-failed)] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] transition-colors disabled:opacity-50"
              >
                {restartingLead ? 'Restarting…' : `Restart Lead (${activeLeads.length})`}
              </button>
            </div>
          )}
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

      {/* Scout */}
      <section className="space-y-3">
        <SectionHeader>Scout</SectionHeader>
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Enable Scout</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">Periodic codebase analysis and improvement suggestions</p>
            </div>
            <Toggle value={scoutEnabled} onChange={async v => {
              setScoutEnabled(v);
              await saveConfig({ scoutEnabled: v });
            }} />
          </div>
        </Card>
      </section>

      {/* Identity & Memory */}
      <IdentityMemorySection projectName={projectName!} />
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

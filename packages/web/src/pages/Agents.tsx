import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { useTasks } from '../hooks/useTasks.tsx';
import { useAgents as useAgentsHook } from '../hooks/useAgents.tsx';
import { api } from '../lib/api.ts';
import { Bot, MoreHorizontal, Pause, Play, LogOut, AlertTriangle, ChevronDown } from 'lucide-react';
import type { Agent } from '../lib/types.ts';
import { AgentDetailPanel, EMPTY_CHUNKS, STATUS_CONFIG, ROLE_ICONS } from '../components/AgentDetailPanel.tsx';





function AgentActionMenu({ agent, projectName, onAction, onError }: { agent: Agent; projectName: string; onAction: () => void; onError?: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const s = agent.status;
  const actions: { label: string; icon: React.ReactNode; show: boolean; fn: () => Promise<unknown> }[] = [
    { label: 'Hibernate', icon: <Pause size={13} />, show: s === 'busy' || s === 'working' || s === 'idle', fn: () => api.hibernateAgent(projectName, agent.id) },
    { label: 'Interrupt', icon: <AlertTriangle size={13} />, show: s === 'busy' || s === 'working', fn: () => api.sendAgentMessage(projectName, agent.id, 'User interrupt', true) },
    { label: 'Wake', icon: <Play size={13} />, show: s === 'hibernated', fn: () => api.wakeAgent(projectName, agent.id) },
    { label: 'Retire', icon: <LogOut size={13} />, show: s !== 'terminated' && s !== 'ended', fn: () => api.retireAgent(projectName, agent.id) },
  ];
  const visible = actions.filter(a => a.show);
  if (!visible.length) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setLoading(true);
    try { await fn(); onAction(); } catch (err) { onError?.(err instanceof Error ? err.message : String(err)); }
    setLoading(false);
    setOpen(false);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
        className="p-1.5 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] transition-colors"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 min-w-[140px] py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          {visible.map(a => (
            <button key={a.label} disabled={loading}
              onClick={e => { e.stopPropagation(); run(a.fn); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--color-surface-secondary)] disabled:opacity-50 transition-colors">
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentModelDropdown({ agent, projectName, onChanged }: { agent: Agent; projectName: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: modelsData } = useSWR(
    open && projectName ? ['card-models', projectName] : null,
    () => api.getAvailableModels(projectName)
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Group models by runtime, filter to agent's runtime
  const groups = useMemo(() => {
    if (!modelsData) return [];
    const result: { runtime: string; models: string[] }[] = [];
    const agentRuntime = agent.runtimeName ?? agent.runtime ?? '';
    for (const [runtime, runtimeModels] of Object.entries(modelsData as Record<string, any>)) {
      const models: string[] = [];
      if (Array.isArray(runtimeModels)) {
        for (const m of runtimeModels) { if (m.modelId && !models.includes(m.modelId)) models.push(m.modelId); }
      } else {
        for (const group of Object.values(runtimeModels as Record<string, any>)) {
          for (const m of group as any[]) { if (m.modelId && !models.includes(m.modelId)) models.push(m.modelId); }
        }
      }
      if (models.length) result.push({ runtime, models });
    }
    // Put agent's runtime first
    result.sort((a, b) => {
      if (a.runtime === agentRuntime) return -1;
      if (b.runtime === agentRuntime) return 1;
      return 0;
    });
    return result;
  }, [modelsData, agent.runtimeName, agent.runtime]);

  const selectModel = async (model: string) => {
    setLoading(true);
    try { await api.setAgentModel(projectName, agent.id, model); onChanged(); } catch (err) { console.error(err); }
    setLoading(false);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
        className="flex items-center gap-1 font-mono text-xs truncate hover:text-[var(--color-text)] transition-colors"
        disabled={loading}
      >
        <span className="truncate">{agent.model ?? agent.runtimeName ?? '—'}</span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-50 min-w-[220px] max-h-[300px] overflow-y-auto py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          {!groups.length && <div className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">Loading…</div>}
          {groups.map(g => (
            <div key={g.runtime}>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium">{g.runtime}</div>
              {g.models.map(m => (
                <button key={m}
                  onClick={e => { e.stopPropagation(); selectModel(m); }}
                  className={`w-full px-3 py-1.5 text-xs text-left font-mono truncate hover:bg-[var(--color-surface-secondary)] transition-colors ${
                    m === agent.model ? 'text-[var(--color-primary)]' : ''
                  }`}>
                  {m}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, projectName, onSelect, isSelected, onMutate, onError }: { agent: Agent; projectName: string; onSelect: (id: string) => void; isSelected: boolean; onMutate: () => void; onError?: (msg: string) => void }) {
  const config = STATUS_CONFIG[agent.status] ?? { color: 'var(--color-text-tertiary)', label: agent.status };
  const { tasks } = useTasks();
  const { agentOutputs } = useAgentsHook();
  const currentTask = tasks.find(t => t.id === agent.currentTask);
  const liveOutput = agentOutputs.get(agent.id) ?? '';

  return (
    <div
      onClick={() => onSelect(agent.id)}
      className={`group p-5 rounded-xl border bg-[var(--color-surface)] hover:border-[var(--color-text-tertiary)] transition-colors space-y-4 cursor-pointer ${
        isSelected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-surface-secondary)] flex items-center justify-center text-lg">
            {ROLE_ICONS[agent.role] ?? <Bot size={20} strokeWidth={1.5} />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold capitalize">{agent.role}</span>
            </div>
            <p className="font-mono text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate max-w-[160px]">{agent.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            {projectName && <AgentActionMenu agent={agent} projectName={projectName} onAction={onMutate} onError={onError} />}
          </div>
          <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
                style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
            <span className={`w-2 h-2 rounded-full ${config.animate ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: config.color }} />
            {config.label}
          </span>
        </div>
      </div>

      {/* Current task */}
      {currentTask && (
        <div className="px-3 py-2 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-tertiary)] mb-0.5">Current Task</p>
          <p className="text-sm truncate">{currentTask.title}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-[var(--color-text-tertiary)]">Model</p>
          {projectName ? (
            <AgentModelDropdown agent={agent} projectName={projectName} onChanged={onMutate} />
          ) : (
            <p className="font-mono mt-0.5 truncate">{agent.model ?? agent.runtimeName ?? '—'}</p>
          )}
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Runtime</p>
          <p className="font-mono mt-0.5">{agent.runtimeName ?? agent.runtime ?? 'acp'}</p>
        </div>
        <div>
          <p className="text-[var(--color-text-tertiary)]">Tokens</p>
          <p className="mt-0.5 font-medium">{((agent as any).tokensIn ?? 0).toLocaleString()} in / {((agent as any).tokensOut ?? 0).toLocaleString()} out</p>
        </div>
      </div>

      {/* Live indicator */}
      {liveOutput && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />
          Streaming output…
        </div>
      )}
    </div>
  );
}

export default function Agents() {
  const { agents, agentOutputs, agentStreamChunks, dmMessages } = useAgentsHook();
  const { loading, projectName } = useProject();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('selected');
  });
  const [pageToast, setPageToast] = useState<string | null>(null);
  const { mutate } = useSWR(projectName ? ['agents', projectName] : null);
  const handleMutate = useCallback(() => { mutate(); }, [mutate]);

  const selectedAgent = agents.find(a => a.id === selectedAgentId) ?? null;

  // Clear selection if agent disappears
  useEffect(() => {
    if (selectedAgentId && !agents.find(a => a.id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [agents, selectedAgentId]);

  if (loading) {
    return (
      <div className="max-w-5xl space-y-6">
        <div className="h-8 w-32 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-48 bg-[var(--color-surface-secondary)] rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const active = agents.filter(a => !['retired', 'hibernated', 'errored'].includes(a.status));
  const hibernated = agents.filter(a => a.status === 'hibernated');
  const errored = agents.filter(a => a.status === 'errored');
  const retired = agents.filter(a => a.status === 'retired');

  if (agents.length === 0) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-8">Agents</h1>
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <Bot size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
          <p>No agents running.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">The Lead will spawn agents when tasks are ready.</p>
        </div>
      </div>
    );
  }

  const handleAgentSelect = useCallback((id: string) => {
    // Toggle: clicking the same agent deselects it
    setSelectedAgentId(prev => prev === id ? null : id);
  }, []);

  return (
    <div className="flex h-full">
    <div className="flex-1 overflow-y-auto min-w-0">
    <div className="max-w-5xl space-y-6 p-0">
      {/* Toast */}
      {pageToast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl bg-red-500/90 text-white text-sm shadow-lg backdrop-blur-sm animate-in slide-in-from-top-2 flex items-center gap-2">
          <span>⚠️ {pageToast}</span>
          <button onClick={() => setPageToast(null)} className="text-white/70 hover:text-white">✕</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents ({active.length})</h1>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-running)] animate-pulse" />
            {active.filter(a => a.status === 'busy' || a.status === 'working').length} busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-ready)]" />
            {active.filter(a => a.status === 'idle').length} idle
          </span>
        </div>
      </div>

      {active.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {active.map(a => <AgentCard key={a.id} agent={a} projectName={projectName!} onSelect={handleAgentSelect} isSelected={a.id === selectedAgentId} onMutate={handleMutate} onError={msg => { setPageToast(msg); setTimeout(() => setPageToast(null), 4000); }} />)}
        </div>
      )}

      {hibernated.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            💤 {hibernated.length} hibernated agent{hibernated.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 opacity-60">
            {hibernated.map(a => <AgentCard key={a.id} agent={a} projectName={projectName!} onSelect={handleAgentSelect} isSelected={a.id === selectedAgentId} onMutate={handleMutate} onError={msg => { setPageToast(msg); setTimeout(() => setPageToast(null), 4000); }} />)}
          </div>
        </details>
      )}

      {errored.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            ⚠️ {errored.length} errored agent{errored.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 opacity-60">
            {errored.map(a => <AgentCard key={a.id} agent={a} projectName={projectName!} onSelect={handleAgentSelect} isSelected={a.id === selectedAgentId} onMutate={handleMutate} onError={msg => { setPageToast(msg); setTimeout(() => setPageToast(null), 4000); }} />)}
          </div>
        </details>
      )}

      {retired.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            {retired.length} retired agent{retired.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 opacity-50">
            {retired.map(a => <AgentCard key={a.id} agent={a} projectName={projectName!} onSelect={handleAgentSelect} isSelected={a.id === selectedAgentId} onMutate={handleMutate} onError={msg => { setPageToast(msg); setTimeout(() => setPageToast(null), 4000); }} />)}
          </div>
        </details>
      )}

    </div>
    </div>

      {/* Sidebar detail panel */}
      {selectedAgent && projectName && (
        <AgentDetailPanel
          key={selectedAgent.id}
          agent={selectedAgent}
          projectName={projectName}
          liveOutput={agentOutputs.get(selectedAgent.id) ?? ''}
          liveChunks={agentStreamChunks.get(selectedAgent.id) ?? EMPTY_CHUNKS}
          liveDmMessages={dmMessages.get(selectedAgent.id) ?? []}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}

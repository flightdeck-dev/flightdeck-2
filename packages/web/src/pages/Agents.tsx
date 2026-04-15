import { useState, useEffect, useRef, useCallback } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { api } from '../lib/api.ts';
import { Crown, Code, Search, ClipboardList, Bot, Send, Zap, Terminal, MessageSquare, X, Info, Pause, Play, Power, Trash2, RotateCcw, Snowflake } from 'lucide-react';
import type { Agent } from '../lib/types.ts';

const ROLE_ICONS: Record<string, React.ReactNode> = {
  lead: <Crown size={20} strokeWidth={1.5} />, developer: <Code size={20} strokeWidth={1.5} />, worker: <Code size={20} strokeWidth={1.5} />, reviewer: <Search size={20} strokeWidth={1.5} />, planner: <ClipboardList size={20} strokeWidth={1.5} />,
};

const STATUS_CONFIG: Record<string, { color: string; label: string; animate?: boolean }> = {
  busy: { color: 'var(--color-status-running)', label: 'Busy', animate: true },
  working: { color: 'var(--color-status-running)', label: 'Working', animate: true },
  idle: { color: 'var(--color-status-ready)', label: 'Idle' },
  hibernated: { color: 'var(--color-accent)', label: 'Hibernated' },
  suspended: { color: 'var(--color-accent)', label: 'Suspended' },
  retired: { color: 'var(--color-text-tertiary)', label: 'Retired' },
  terminated: { color: 'var(--color-status-cancelled)', label: 'Offline' },
  ended: { color: 'var(--color-status-cancelled)', label: 'Ended' },
  offline: { color: 'var(--color-status-cancelled)', label: 'Offline' },
};

const ACTIVE_STATUSES = new Set(['busy', 'working', 'idle']);
const HIBERNATED_STATUSES = new Set(['hibernated', 'suspended']);
const RETIRED_STATUSES = new Set(['retired', 'offline', 'terminated', 'ended']);

const PANEL_WIDTH_KEY = 'flightdeck:agent-panel-width';
const DEFAULT_PANEL_WIDTH = 420;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH_VW = 70;

function getStoredWidth(): number {
  try {
    const v = localStorage.getItem(PANEL_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_PANEL_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_PANEL_WIDTH;
}

// ── Action buttons based on agent status ──

function AgentActions({ agent, projectName, onDone }: { agent: Agent; projectName: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try { await fn(); onDone(); } catch (e) { console.error(e); } finally { setBusy(false); }
  };

  const s = agent.status;
  const btnBase = 'inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-40';
  const btnDefault = `${btnBase} border-[var(--color-border)] hover:bg-[var(--color-surface-secondary)]`;
  const btnDanger = `${btnBase} border-[var(--color-status-failed)] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)]`;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2" onClick={e => e.stopPropagation()}>
      {(s === 'busy' || s === 'working') && <>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.sendAgentMessage(projectName, agent.id, '', true))}><Zap size={12}/> Interrupt</button>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.hibernateAgent(projectName, agent.id))}><Snowflake size={12}/> Hibernate</button>
        <button disabled={busy} className={btnDanger} onClick={() => act(() => api.terminateAgent(projectName, agent.id), 'Terminate this agent?')}><Power size={12}/> Terminate</button>
      </>}
      {s === 'idle' && <>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.hibernateAgent(projectName, agent.id))}><Snowflake size={12}/> Hibernate</button>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.retireAgent(projectName, agent.id), 'Retire this agent?')}><Pause size={12}/> Retire</button>
        <button disabled={busy} className={btnDanger} onClick={() => act(() => api.terminateAgent(projectName, agent.id), 'Terminate this agent?')}><Power size={12}/> Terminate</button>
      </>}
      {(s === 'hibernated' || s === 'suspended') && <>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.wakeAgent(projectName, agent.id))}><Play size={12}/> Wake</button>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.retireAgent(projectName, agent.id), 'Retire this agent?')}><Pause size={12}/> Retire</button>
      </>}
      {s === 'retired' && (
        <button disabled={busy} className={btnDanger} onClick={() => act(() => api.terminateAgent(projectName, agent.id), 'Delete this agent?')}><Trash2 size={12}/> Delete</button>
      )}
      {(s === 'offline' || s === 'terminated' || s === 'ended') && <>
        <button disabled={busy} className={btnDefault} onClick={() => act(() => api.restartAgent(projectName, agent.id))}><RotateCcw size={12}/> Restart</button>
        <button disabled={busy} className={btnDanger} onClick={() => act(() => api.terminateAgent(projectName, agent.id), 'Delete this agent?')}><Trash2 size={12}/> Delete</button>
      </>}
    </div>
  );
}

type DetailTab = 'output' | 'send' | 'info';

function AgentDetailPanel({
  agent,
  projectName,
  liveOutput,
  onClose,
  onAction,
}: {
  agent: Agent;
  projectName: string;
  liveOutput: string;
  onClose: () => void;
  onAction: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('output');
  const [historicalOutput, setHistoricalOutput] = useState<string[]>([]);
  const [loadingOutput, setLoadingOutput] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [width, setWidth] = useState(getStoredWidth);
  const [dragging, setDragging] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);

  const config = STATUS_CONFIG[agent.status] ?? { color: 'var(--color-text-tertiary)', label: agent.status };
  const { tasks } = useFlightdeck();
  const currentTask = tasks.find(t => t.id === (agent.currentTask ?? agent.current_task));

  useEffect(() => {
    let cancelled = false;
    setLoadingOutput(true);
    api.getAgentOutput(projectName, agent.id, 200).then(data => {
      if (!cancelled) { setHistoricalOutput(data.lines); setLoadingOutput(false); }
    }).catch(() => { if (!cancelled) setLoadingOutput(false); });
    return () => { cancelled = true; };
  }, [agent.id, projectName]);

  useEffect(() => {
    if (autoScrollRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [historicalOutput, liveOutput]);

  const handleScroll = useCallback(() => {
    if (!outputRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (!dragging) return;
    const maxPx = window.innerWidth * MAX_PANEL_WIDTH_VW / 100;
    const onMove = (e: MouseEvent) => {
      const newWidth = Math.min(maxPx, Math.max(MIN_PANEL_WIDTH, window.innerWidth - e.clientX));
      setWidth(newWidth);
    };
    const onUp = () => {
      setDragging(false);
      setWidth(w => { try { localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w))); } catch {} return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  const handleSend = async (urgent?: boolean) => {
    if (!message.trim()) return;
    setSending(true);
    try { await api.sendAgentMessage(projectName, agent.id, message.trim(), urgent); setMessage(''); } catch (err) { console.error('Failed to send message:', err); }
    setSending(false);
  };

  const fullOutput = [...historicalOutput, ...(liveOutput ? [liveOutput] : [])].join('\n');

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div ref={panelRef} className="fixed top-0 right-0 h-full z-50 flex animate-slide-in-right" style={{ width: `${width}px`, userSelect: dragging ? 'none' : undefined }}>
        <div className="w-1 hover:w-1.5 bg-[var(--color-border)] hover:bg-[var(--color-text-tertiary)] cursor-col-resize shrink-0 transition-colors" onMouseDown={e => { e.preventDefault(); setDragging(true); }} />
        <div className="flex-1 flex flex-col bg-[var(--color-surface)] border-l border-[var(--color-border)] overflow-hidden">
          {/* Header */}
          <div className="px-5 py-4 border-b border-[var(--color-border)] shrink-0">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--color-surface-secondary)] flex items-center justify-center">
                  {ROLE_ICONS[agent.role] ?? <Bot size={18} strokeWidth={1.5} />}
                </div>
                <div>
                  <span className="text-sm font-semibold capitalize">{agent.role}</span>
                  <span className="font-mono text-xs text-[var(--color-text-tertiary)] ml-2">{agent.id.slice(0, 13)}</span>
                </div>
                <span className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
                  <span className={`w-1.5 h-1.5 rounded-full ${config.animate ? 'animate-pulse' : ''}`} style={{ backgroundColor: config.color }} />
                  {config.label}
                </span>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]">
                <X size={16} />
              </button>
            </div>
            {currentTask && (
              <p className="text-xs text-[var(--color-text-secondary)] mt-2 truncate">
                <span className="text-[var(--color-text-tertiary)]">Task:</span> {currentTask.title}
              </p>
            )}
            <AgentActions agent={agent} projectName={projectName} onDone={onAction} />
          </div>

          {/* Tabs */}
          <div className="flex gap-1 px-5 py-2 border-b border-[var(--color-border)] shrink-0">
            {([['output', Terminal, 'Output'], ['send', MessageSquare, 'Send Message'], ['info', Info, 'Info']] as const).map(([key, Icon, label]) => (
              <button key={key} onClick={() => setTab(key as DetailTab)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${tab === key ? 'bg-[var(--color-surface-secondary)] text-[var(--color-text)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}`}>
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {tab === 'output' && (
              <div ref={outputRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 bg-[var(--color-surface-secondary)] font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {loadingOutput ? <span className="text-[var(--color-text-tertiary)]">Loading output...</span> : fullOutput ? fullOutput : <span className="text-[var(--color-text-tertiary)]">No output yet.</span>}
              </div>
            )}
            {tab === 'send' && (
              <div className="p-4 space-y-3 flex-1 flex flex-col">
                <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Type a message to this agent..."
                  className="flex-1 bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg p-3 text-sm resize-none focus:outline-none focus:border-[var(--color-text-tertiary)]"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }} />
                <div className="flex gap-2">
                  <button onClick={() => handleSend(false)} disabled={sending || !message.trim()} className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40">
                    <Send size={12} /> Send
                  </button>
                  <button onClick={() => handleSend(true)} disabled={sending || !message.trim()} className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border border-[var(--color-status-failed)] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] transition-colors disabled:opacity-40">
                    <Zap size={12} /> Interrupt
                  </button>
                </div>
              </div>
            )}
            {tab === 'info' && (
              <div className="p-4 space-y-3 text-sm overflow-y-auto">
                {[['Agent ID', agent.id], ['Role', agent.role], ['Status', config.label], ['Model', agent.model ?? '—'], ['Runtime', agent.runtimeName ?? agent.runtime ?? 'acp'], ['Cost', `$${(agent.cost ?? 0).toFixed(2)}`], ['Session ID', agent.acp_session_id ?? '—']].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-[var(--color-text-tertiary)] shrink-0">{label}</span>
                    <span className="font-mono text-xs text-right truncate">{value}</span>
                  </div>
                ))}
                {currentTask && (
                  <div className="mt-4 p-3 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-tertiary)] mb-1">Current Task</p>
                    <p className="text-sm">{currentTask.title}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function AgentCard({ agent, projectName, onSelect, isSelected, onAction }: { agent: Agent; projectName: string; onSelect: (id: string) => void; isSelected: boolean; onAction: () => void }) {
  const config = STATUS_CONFIG[agent.status] ?? { color: 'var(--color-text-tertiary)', label: agent.status };
  const { tasks, agentOutputs } = useFlightdeck();
  const currentTask = tasks.find(t => t.id === (agent.currentTask ?? agent.current_task));
  const liveOutput = agentOutputs.get(agent.id) ?? '';
  const isHibernated = HIBERNATED_STATUSES.has(agent.status);

  return (
    <div
      onClick={() => onSelect(agent.id)}
      className={`p-5 rounded-xl border bg-[var(--color-surface)] hover:border-[var(--color-text-tertiary)] transition-colors space-y-4 cursor-pointer ${
        isSelected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-surface-secondary)] flex items-center justify-center text-lg">
            {isHibernated ? <span>❄️</span> : (ROLE_ICONS[agent.role] ?? <Bot size={20} strokeWidth={1.5} />)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold capitalize">{agent.role}</span>
            </div>
            <p className="font-mono text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate max-w-[160px]">{agent.id}</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
              style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
          <span className={`w-2 h-2 rounded-full ${config.animate ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: config.color }} />
          {config.label}
        </span>
      </div>

      {currentTask && (
        <div className="px-3 py-2 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-tertiary)] mb-0.5">Current Task</p>
          <p className="text-sm truncate">{currentTask.title}</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 text-xs">
        <div><p className="text-[var(--color-text-tertiary)]">Model</p><p className="font-mono mt-0.5 truncate">{agent.model ?? '—'}</p></div>
        <div><p className="text-[var(--color-text-tertiary)]">Runtime</p><p className="font-mono mt-0.5">{agent.runtimeName ?? agent.runtime ?? 'acp'}</p></div>
        <div><p className="text-[var(--color-text-tertiary)]">Cost</p><p className="mt-0.5 font-medium">${(agent.cost ?? 0).toFixed(2)}</p></div>
      </div>

      {liveOutput && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />
          Streaming output…
        </div>
      )}

      <AgentActions agent={agent} projectName={projectName} onDone={onAction} />
    </div>
  );
}

export default function Agents() {
  const { agents, loading, projectName, agentOutputs, refresh } = useFlightdeck();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const selectedAgent = agents.find(a => a.id === selectedAgentId) ?? null;

  useEffect(() => {
    if (selectedAgentId && !agents.find(a => a.id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [agents, selectedAgentId]);

  const handleAction = useCallback(() => {
    refresh?.();
  }, [refresh]);

  if (loading) {
    return (
      <div className="max-w-5xl space-y-6">
        <div className="h-8 w-32 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-48 bg-[var(--color-surface-secondary)] rounded-xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  const active = agents.filter(a => ACTIVE_STATUSES.has(a.status));
  const hibernated = agents.filter(a => HIBERNATED_STATUSES.has(a.status));
  const retired = agents.filter(a => RETIRED_STATUSES.has(a.status));

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

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents ({agents.length})</h1>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-running)] animate-pulse" />
            {active.filter(a => a.status === 'busy' || a.status === 'working').length} busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-status-ready)]" />
            {active.filter(a => a.status === 'idle').length} idle
          </span>
          {hibernated.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span>❄️</span> {hibernated.length} hibernated
            </span>
          )}
        </div>
      </div>

      {/* Active agents */}
      {active.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {active.map(a => <AgentCard key={a.id} agent={a} projectName={projectName ?? ''} onSelect={setSelectedAgentId} isSelected={a.id === selectedAgentId} onAction={handleAction} />)}
        </div>
      )}

      {/* Hibernated agents */}
      {hibernated.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            ❄️ {hibernated.length} hibernated agent{hibernated.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            {hibernated.map(a => <AgentCard key={a.id} agent={a} projectName={projectName ?? ''} onSelect={setSelectedAgentId} isSelected={a.id === selectedAgentId} onAction={handleAction} />)}
          </div>
        </details>
      )}

      {/* Retired / Offline agents */}
      {retired.length > 0 && (
        <details className="group">
          <summary className="text-sm text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)] select-none">
            {retired.length} offline/retired agent{retired.length !== 1 ? 's' : ''}
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 opacity-50">
            {retired.map(a => <AgentCard key={a.id} agent={a} projectName={projectName ?? ''} onSelect={setSelectedAgentId} isSelected={a.id === selectedAgentId} onAction={handleAction} />)}
          </div>
        </details>
      )}

      {selectedAgent && projectName && (
        <AgentDetailPanel
          agent={selectedAgent}
          projectName={projectName}
          liveOutput={agentOutputs.get(selectedAgent.id) ?? ''}
          onClose={() => setSelectedAgentId(null)}
          onAction={handleAction}
        />
      )}
    </div>
  );
}

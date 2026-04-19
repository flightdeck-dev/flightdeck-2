import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { useTasks } from '../hooks/useTasks.tsx';
import { useAgents as useAgentsHook } from '../hooks/useAgents.tsx';
import { useChat } from '../hooks/useChat.tsx';
import { useDisplay } from '../hooks/useDisplay.tsx';
import type { ToolCallState } from '../hooks/useChat.tsx';
import type { StreamChunk } from '../hooks/useAgents.tsx';
import { api } from '../lib/api.ts';
import { Crown, Code, Search, ClipboardList, Bot, Send, Zap, X, Info, MessageSquare, MoreHorizontal, Pause, Play, LogOut, AlertTriangle, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Markdown } from '../components/Markdown.tsx';
import { ThinkingBlock, ToolCallCard, groupChunks } from './Chat.tsx';
import { shouldShow, type DisplayConfig } from '@flightdeck-ai/shared/display';
import type { Agent } from '../lib/types.ts';

// M3: Hoist empty fallback arrays to avoid new references defeating memo
const EMPTY_CHUNKS: StreamChunk[] = [];

const ROLE_ICONS: Record<string, React.ReactNode> = {
  lead: <Crown size={20} strokeWidth={1.5} />, developer: <Code size={20} strokeWidth={1.5} />, worker: <Code size={20} strokeWidth={1.5} />, reviewer: <Search size={20} strokeWidth={1.5} />, planner: <ClipboardList size={20} strokeWidth={1.5} />,
};

const STATUS_CONFIG: Record<string, { color: string; label: string; animate?: boolean }> = {
  busy: { color: 'var(--color-status-running)', label: 'Busy', animate: true },
  working: { color: 'var(--color-status-running)', label: 'Working', animate: true },
  idle: { color: 'var(--color-text-tertiary)', label: 'Idle' },
  terminated: { color: 'var(--color-status-cancelled)', label: 'Offline' },
  ended: { color: 'var(--color-status-cancelled)', label: 'Ended' },
  hibernated: { color: 'var(--color-text-tertiary)', label: '💤 Hibernated' },
  retired: { color: 'var(--color-status-cancelled)', label: 'Retired' },
};

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

type DetailTab = 'chat' | 'info';

/** Render agent stream chunks (thinking, tool calls, text) similar to Lead chat */
function AgentStreamContent({ chunks, displayConfig, toolCallMap }: {
  chunks: StreamChunk[];
  displayConfig: DisplayConfig;
  toolCallMap: Map<string, ToolCallState>;
}) {
  const sections = useMemo(() => groupChunks(chunks), [chunks]);
  const renderedToolCallIds = new Set<string>();

  return (
    <>
      {sections.map((section, i) => {
        if (!shouldShow(displayConfig, section.contentType, section.toolName)) return null;
        if (section.contentType === 'thinking') {
          return <ThinkingBlock key={i} content={section.content} />;
        }
        if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call' ||
            section.contentType === 'tool_result' || section.contentType === 'flightdeck_tool_result') {
          try {
            const parsed = JSON.parse(section.content);
            if (parsed.toolCallId) {
              if (renderedToolCallIds.has(parsed.toolCallId)) return null;
              renderedToolCallIds.add(parsed.toolCallId);
              const tc = toolCallMap.get(parsed.toolCallId);
              if (!tc || !tc.name) return null;
              const isFlightdeck = tc.contentType === 'flightdeck_tool_call';
              const level = isFlightdeck ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              return <ToolCallCard key={parsed.toolCallId} tc={tc} level={level} />;
            }
          } catch {}
          return null;
        }
        return (
          <div key={i} className="text-sm break-words">
            <Markdown content={section.content} />
          </div>
        );
      })}
    </>
  );
}

function AgentDetailPanel({
  agent,
  projectName,
  liveOutput,
  liveChunks,
  onClose,
}: {
  agent: Agent;
  projectName: string;
  liveOutput: string;
  liveChunks: StreamChunk[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('chat');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentMessages, setSentMessages] = useState<{ text: string; ts: number }[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null);
  const [width, setWidth] = useState(getStoredWidth);
  const [dragging, setDragging] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // Historical output (loaded from API when no live data)
  const [historicalOutput, setHistoricalOutput] = useState('');
  // H8: Add proper deps — refetch when agent or project changes
  const { data: agentOutputData } = useSWR(
    !liveOutput && !liveChunks.length && projectName ? ['agentOutput', projectName, agent.id] : null,
    () => api.getAgentOutput(projectName!, agent.id),
    { refreshInterval: 3000 }
  );
  useEffect(() => {
    if (agentOutputData?.lines?.length) setHistoricalOutput(agentOutputData.lines.join('\n'));
  }, [agentOutputData]);

  // Model dropdown state
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);

  const config = STATUS_CONFIG[agent.status] ?? { color: 'var(--color-text-tertiary)', label: agent.status };
  const { tasks } = useTasks();
  const { displayConfig } = useDisplay();
  const { toolCallMap } = useChat();
  const { mutate: globalMutate } = useSWRConfig();
  const currentTask = tasks.find(t => t.id === agent.currentTask);

  // H8: Add projectName to deps so models refetch when project changes
  const { data: modelsData } = useSWR(
    projectName ? ['availableModels-agents', projectName] : null,
    () => api.getAvailableModels(projectName!)
  );
  useEffect(() => {
    if (!modelsData) return;
    const models: string[] = [];
    for (const runtime of Object.keys(modelsData as Record<string, any>)) {
      const runtimeModels = (modelsData as Record<string, any>)[runtime];
      // Support both flat array and legacy grouped object
      if (Array.isArray(runtimeModels)) {
        for (const m of runtimeModels) {
          if (m.modelId && !models.includes(m.modelId)) models.push(m.modelId);
        }
      } else {
        for (const group of Object.values(runtimeModels as Record<string, any>)) {
          for (const m of group as any[]) {
            if (m.modelId && !models.includes(m.modelId)) models.push(m.modelId);
          }
        }
      }
    }
    setAvailableModels(models);
  }, [modelsData]);

  // Auto-scroll chat
  useEffect(() => {
    if (autoScrollRef.current && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [liveOutput, liveChunks, sentMessages]);

  const handleScroll = useCallback(() => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  // L4: stopPropagation so Escape in panel doesn't trigger page-level handlers
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Drag resize
  useEffect(() => {
    if (!dragging) return;
    const maxPx = window.innerWidth * MAX_PANEL_WIDTH_VW / 100;
    const onMove = (e: MouseEvent) => {
      const newWidth = Math.min(maxPx, Math.max(MIN_PANEL_WIDTH, window.innerWidth - e.clientX));
      setWidth(newWidth);
    };
    const onUp = () => {
      setDragging(false);
      setWidth(w => {
        try { localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w))); } catch {}
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const handleSend = async (urgent?: boolean) => {
    if (!message.trim()) return;
    const text = message.trim();
    setSending(true);
    try {
      await api.sendAgentMessage(projectName, agent.id, text, urgent);
      setSentMessages(prev => [...prev, { text, ts: Date.now() }]);
      setMessage('');
    } catch (err) {
      setToast({ message: `Failed to send: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
      setTimeout(() => setToast(null), 4000);
    }
    setSending(false);
  };

  const handleModelChange = async (model: string) => {
    setModelLoading(true);
    try {
      await api.setAgentModel(projectName, agent.id, model);
      // Revalidate agents list to reflect new model
      globalMutate((key: unknown) => Array.isArray(key) && key[0] === 'agents');
    } catch (err) {
      console.error('Failed to set model:', err);
    }
    setModelLoading(false);
  };

  // Build chat timeline: interleave agent output chunks with sent messages by timestamp
  const effectiveOutput = liveOutput || historicalOutput;
  const hasChunks = liveChunks.length > 0;

  // Fetch persisted DM history for this agent
  const { data: dmMessages } = useSWR(
    projectName && agent.id ? ['agent-dms', projectName, agent.id] : null,
    () => api.getMessages(projectName!, { channel: `dm:${agent.id}`, limit: 50 }),
    { refreshInterval: 5000 }
  );

  return (
      <div
        ref={panelRef}
        className="h-full flex flex-shrink-0 transition-[width] duration-200 ease-in-out"
        style={{
          width: `${width}px`,
          userSelect: dragging ? 'none' : undefined,
        }}
      >
        {/* Resize handle */}
        <div
          className="w-1 hover:w-1.5 bg-[var(--color-border)] hover:bg-[var(--color-text-tertiary)] cursor-col-resize shrink-0 transition-colors"
          onMouseDown={e => { e.preventDefault(); setDragging(true); }}
        />

        {/* Content */}
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
                <span className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
                  <span className={`w-1.5 h-1.5 rounded-full ${config.animate ? 'animate-pulse' : ''}`}
                        style={{ backgroundColor: config.color }} />
                  {config.label}
                </span>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]" aria-label="Close agent panel">
                <X size={16} />
              </button>
            </div>
            {currentTask && (
              <p className="text-xs text-[var(--color-text-secondary)] mt-2 truncate">
                <span className="text-[var(--color-text-tertiary)]">Task:</span> {currentTask.title}
              </p>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 px-5 py-2 border-b border-[var(--color-border)] shrink-0">
            {([['chat', MessageSquare, 'Chat'], ['info', Info, 'Info']] as const).map(([key, Icon, label]) => (
              <button
                key={key}
                onClick={() => setTab(key as DetailTab)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  tab === key
                    ? 'bg-[var(--color-surface-secondary)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Lead chat link */}
            {agent.role === 'lead' && (
              <div className="px-4 py-3 text-sm text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
                <Link to={`/${projectName}/chat`} className="hover:text-[var(--color-text)] transition-colors">View Lead conversations in Chat →</Link>
              </div>
            )}
            {tab === 'chat' && (
              <>
                {/* Toast */}
                {toast && (
                  <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-500/90 text-white text-xs flex items-center justify-between">
                    <span>{toast.message}</span>
                    <button onClick={() => setToast(null)} className="text-white/70 hover:text-white ml-2">✕</button>
                  </div>
                )}
                {/* Chat messages area */}
                <div
                  ref={chatRef}
                  onScroll={handleScroll}
                  className="flex-1 overflow-y-auto px-4 py-4 space-y-2"
                >
                  {/* Persisted DM history */}
                  {dmMessages && dmMessages.length > 0 && (
                    <div className="space-y-2 mb-4 pb-4 border-b border-[var(--color-border)]">
                      {dmMessages.map((m) => (
                        <div key={m.id} className={`flex ${m.authorType === 'agent' && m.authorId === agent.id ? 'justify-start' : 'justify-end'}`}>
                          <div className={`inline-block px-3 py-2 rounded-2xl text-sm max-w-[85%] whitespace-pre-wrap break-words ${
                            m.authorType === 'agent' && m.authorId === agent.id
                              ? 'rounded-bl-sm bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)]'
                              : 'rounded-br-sm bg-[var(--color-primary)] text-white'
                          }`}>
                            {m.authorType === 'system' && <span className="text-xs opacity-60 block mb-0.5">system</span>}
                            {m.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Agent output */}
                  {hasChunks ? (
                    <div className="space-y-1">
                      <AgentStreamContent chunks={liveChunks} displayConfig={displayConfig} toolCallMap={toolCallMap} />
                    </div>
                  ) : effectiveOutput ? (
                    <div className="text-sm break-words">
                      <Markdown content={effectiveOutput} />
                    </div>
                  ) : (
                    <div className="text-center py-8 text-[var(--color-text-tertiary)] text-sm">
                      No output yet.
                    </div>
                  )}

                  {/* Sent messages (user → agent) */}
                  {sentMessages.map((m, i) => (
                    <div key={i} className="flex justify-end">
                      <div className="inline-block px-3 py-2 rounded-2xl rounded-br-sm bg-[var(--color-primary)] text-white text-sm max-w-[85%] whitespace-pre-wrap break-words">
                        {m.text}
                      </div>
                    </div>
                  ))}

                  {/* Streaming indicator */}
                  {(agent.status === 'busy' || agent.status === 'working') && effectiveOutput && (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />
                      Agent is working…
                    </div>
                  )}
                </div>

                {/* Input area */}
                <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface)] shrink-0">
                  <div className="flex gap-2">
                    <textarea
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      placeholder="Message this agent... (⌘Enter to send)"
                      className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-primary)] max-h-32 overflow-y-auto"
                      rows={1}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && e.shiftKey) {
                          // Shift+Enter = newline
                          return;
                        }
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      onInput={e => {
                        const el = e.target as HTMLTextAreaElement;
                        el.style.height = 'auto';
                        el.style.height = Math.min(el.scrollHeight, 128) + 'px';
                      }}
                    />
                    <button
                      onClick={() => handleSend(false)}
                      disabled={sending || !message.trim()}
                      className="px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity"
                      aria-label="Send message"
                    >
                      <Send size={14} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => handleSend(true)}
                      disabled={sending || !message.trim()}
                      className="px-4 py-2.5 rounded-xl border border-[var(--color-status-failed)] text-[var(--color-status-failed)] text-sm font-medium hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] transition-colors disabled:opacity-30"
                      aria-label="Send urgent message"
                    >
                      <Zap size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              </>
            )}

            {tab === 'info' && (
              <div className="p-4 space-y-3 text-sm overflow-y-auto">
                {[
                  ['Agent ID', agent.id],
                  ['Role', agent.role],
                  ['Status', config.label],
                  ['Runtime', agent.runtimeName ?? agent.runtime ?? 'acp'],
                  ['Tokens', `${((agent as any).tokensIn ?? 0).toLocaleString()} in / ${((agent as any).tokensOut ?? 0).toLocaleString()} out`],
                  ['Session ID', agent.acpSessionId ?? '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-[var(--color-text-tertiary)] shrink-0">{label}</span>
                    <span className="font-mono text-xs text-right truncate">{value}</span>
                  </div>
                ))}

                {/* Model select */}
                <div className="flex justify-between gap-4 items-center">
                  <span className="text-[var(--color-text-tertiary)] shrink-0">Model</span>
                  <select
                    value={agent.model ?? ''}
                    onChange={e => handleModelChange(e.target.value)}
                    disabled={modelLoading}
                    className="font-mono text-xs text-right bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1 focus:outline-none focus:border-[var(--color-text-tertiary)] max-w-[220px] truncate disabled:opacity-50"
                  >
                    {agent.model && !availableModels.includes(agent.model) && (
                      <option value={agent.model}>{agent.model}</option>
                    )}
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

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
  );
}

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
  const { agents, agentOutputs, agentStreamChunks } = useAgentsHook();
  const { loading, projectName } = useProject();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
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
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}

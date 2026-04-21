import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useTasks } from '../hooks/useTasks.tsx';
import { useDisplay } from '../hooks/useDisplay.tsx';
import { useChat } from '../hooks/useChat.tsx';
import type { ToolCallState } from '../hooks/useChat.tsx';
import type { StreamChunk } from '../hooks/useAgents.tsx';
import { api } from '../lib/api.ts';
import { Crown, Code, Search, ClipboardList, Bot, Send, Zap, X, Info, MessageSquare, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Markdown } from './Markdown.tsx';
import { ThinkingBlock, ToolCallCard, groupChunks } from '../pages/Chat.tsx';
import { shouldShow, type DisplayConfig } from '@flightdeck-ai/shared/display';
import type { Agent } from '../lib/types.ts';

export const EMPTY_CHUNKS: StreamChunk[] = [];

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

export { STATUS_CONFIG, ROLE_ICONS };

type DetailTab = 'chat' | 'info';

/** Render agent stream chunks (thinking, tool calls, text) similar to Lead chat */
export function AgentStreamContent({ chunks, displayConfig, toolCallMap }: {
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

export function AgentDetailPanel({
  agent,
  projectName,
  liveOutput,
  liveChunks,
  liveDmMessages,
  onClose,
  compact,
}: {
  agent: Agent;
  projectName: string;
  liveOutput: string;
  liveChunks: StreamChunk[];
  liveDmMessages: any[];
  onClose: () => void;
  /** When true, renders without resize handle and uses full width (for sidebar embedding) */
  compact?: boolean;
}) {
  const [tab, setTab] = useState<DetailTab>('chat');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentMessages, setSentMessages] = useState<{ text: string; ts: number }[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Resize state (only used when not compact)
  const PANEL_WIDTH_KEY = 'flightdeck:agent-panel-width';
  const DEFAULT_PANEL_WIDTH = 420;
  const MIN_PANEL_WIDTH = 320;
  const MAX_PANEL_WIDTH_VW = 70;
  const [width, setWidth] = useState(() => {
    if (compact) return 0;
    try {
      const v = localStorage.getItem(PANEL_WIDTH_KEY);
      if (v) { const n = parseInt(v, 10); if (n >= MIN_PANEL_WIDTH) return n; }
    } catch {}
    return DEFAULT_PANEL_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Historical output (loaded from API when no live data)
  const [historicalOutput, setHistoricalOutput] = useState('');
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

  const { data: modelsData } = useSWR(
    projectName ? ['availableModels-agents', projectName] : null,
    () => api.getAvailableModels(projectName!)
  );
  useEffect(() => {
    if (!modelsData) return;
    const models: string[] = [];
    for (const runtime of Object.keys(modelsData as Record<string, any>)) {
      const runtimeModels = (modelsData as Record<string, any>)[runtime];
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

  // Escape to close (only for non-compact / full panel mode)
  useEffect(() => {
    if (compact) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, compact]);

  // Drag resize (only for non-compact)
  useEffect(() => {
    if (!dragging || compact) return;
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
  }, [dragging, compact]);

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
      globalMutate((key: unknown) => Array.isArray(key) && key[0] === 'agents');
    } catch (err) {
      console.error('Failed to set model:', err);
    }
    setModelLoading(false);
  };

  const effectiveOutput = liveOutput || historicalOutput;
  const hasChunks = liveChunks.length > 0;

  // Fetch persisted DM history
  const { data: dmHistoryMessages } = useSWR(
    projectName && agent.id ? ['agent-dms', projectName, agent.id] : null,
    () => api.getMessages(projectName!, { channel: `dm:${agent.id}`, limit: 50 }),
  );

  // For Lead, also fetch main chat messages (user ↔ Lead conversation)
  const { data: mainChatMessages } = useSWR(
    projectName && agent.role === 'lead' ? ['lead-main-chat', projectName] : null,
    () => api.getMessages(projectName!, { limit: 50 }),
  );

  const dmMessages = useMemo(() => {
    const history = dmHistoryMessages ?? [];
    const mainChat = (agent.role === 'lead' ? mainChatMessages ?? [] : []);
    const all = [...mainChat, ...history].sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const seen = new Set<string>();
    const deduped = all.filter((m: any) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
    const liveIds = new Set(deduped.map((m: any) => m.id));
    const newLive = liveDmMessages.filter((m: any) => !liveIds.has(m.id));
    return [...deduped, ...newLive];
  }, [dmHistoryMessages, mainChatMessages, liveDmMessages, agent.role]);

  // Content (shared between compact and full modes)
  const content = (
    <div className="flex-1 flex flex-col bg-[var(--color-surface)] overflow-hidden h-full">
      {/* Header */}
      <div className={`${compact ? 'px-3 py-3' : 'px-5 py-4'} border-b border-[var(--color-border)] shrink-0`}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            {compact && (
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]" aria-label="Back to agent list">
                <ArrowLeft size={14} />
              </button>
            )}
            <div className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-[var(--color-surface-secondary)] flex items-center justify-center`}>
              {ROLE_ICONS[agent.role] ?? <Bot size={compact ? 14 : 18} strokeWidth={1.5} />}
            </div>
            <div>
              <span className="text-sm font-semibold capitalize">{agent.role}</span>
              {!compact && <span className="font-mono text-xs text-[var(--color-text-tertiary)] ml-2">{agent.id.slice(0, 13)}</span>}
            </div>
            <span className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }}>
              <span className={`w-1.5 h-1.5 rounded-full ${config.animate ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: config.color }} />
              {config.label}
            </span>
          </div>
          {!compact && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]" aria-label="Close agent panel">
              <X size={16} />
            </button>
          )}
        </div>
        {currentTask && (
          <p className="text-xs text-[var(--color-text-secondary)] mt-2 truncate">
            <span className="text-[var(--color-text-tertiary)]">Task:</span> {currentTask.title}
          </p>
        )}
        <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1 font-mono truncate">
          {agent.runtimeName ?? agent.runtime ?? ''}{agent.model ? ` · ${agent.model}` : ''}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-2 border-b border-[var(--color-border)] shrink-0">
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
        {agent.role === 'lead' && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <Link to={`/${projectName}/chat`} className="hover:text-[var(--color-text)] transition-colors">View Lead conversations in Chat →</Link>
          </div>
        )}
        {tab === 'chat' && (
          <>
            {toast && (
              <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-500/90 text-white text-xs flex items-center justify-between">
                <span>{toast.message}</span>
                <button onClick={() => setToast(null)} className="text-white/70 hover:text-white ml-2">✕</button>
              </div>
            )}
            <div
              ref={chatRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto px-4 py-4 space-y-2"
            >
              {dmMessages && dmMessages.length > 0 && (
                <div className="space-y-2 mb-4 pb-4 border-b border-[var(--color-border)]">
                  {dmMessages.map((m) => (
                    <div key={m.id} className={`flex ${m.authorId === agent.id || (m.authorType === 'user' && agent.role === 'lead') ? 'justify-end' : 'justify-start'}`}>
                      <div className={`inline-block px-3 py-2 rounded-2xl text-sm max-w-[85%] whitespace-pre-wrap break-words ${
                        m.authorId === agent.id || (m.authorType === 'user' && agent.role === 'lead')
                          ? 'rounded-br-sm bg-[var(--color-primary)] text-white'
                          : 'rounded-bl-sm bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)]'
                      }`}>
                        {m.authorId !== agent.id && m.authorType !== 'user' && <span className="text-[10px] opacity-60 block mb-0.5 capitalize">{m.authorType === 'agent' ? (m.authorId?.replace(/-[a-z0-9]+$/, '') ?? 'agent') : m.authorType}</span>}
                        {m.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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

              {sentMessages.map((m, i) => (
                <div key={i} className="flex justify-end">
                  <div className="inline-block px-3 py-2 rounded-2xl rounded-br-sm bg-[var(--color-primary)] text-white text-sm max-w-[85%] whitespace-pre-wrap break-words">
                    {m.text}
                  </div>
                </div>
              ))}

              {(agent.status === 'busy' || agent.status === 'working') && effectiveOutput && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />
                  Agent is working…
                </div>
              )}
            </div>

            <div className="border-t border-[var(--color-border)] px-3 py-2 bg-[var(--color-surface)] shrink-0">
              <div className="flex gap-2">
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder={compact ? "Message..." : "Message this agent... (⌘Enter to send)"}
                  className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-primary)] max-h-32 overflow-y-auto"
                  rows={1}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.shiftKey) return;
                    if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
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
                  className="px-3 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity"
                  aria-label="Send message"
                >
                  <Send size={14} strokeWidth={1.5} />
                </button>
                {!compact && (
                  <button
                    onClick={() => handleSend(true)}
                    disabled={sending || !message.trim()}
                    className="px-3 py-2 rounded-xl border border-[var(--color-status-failed)] text-[var(--color-status-failed)] text-sm font-medium hover:bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] transition-colors disabled:opacity-30"
                    aria-label="Send urgent message"
                  >
                    <Zap size={14} strokeWidth={1.5} />
                  </button>
                )}
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
  );

  // Compact mode: just render content directly, no resize handle or fixed width
  if (compact) {
    return content;
  }

  // Full mode: with resize handle and fixed width
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
      {content}
    </div>
  );
}

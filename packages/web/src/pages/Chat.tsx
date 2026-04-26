import { useState, useRef, useEffect, useCallback, useMemo, memo, Component, type ReactNode, type ErrorInfo } from 'react';
import { Bot, Crown, User, Settings as SettingsIcon, Send, MessageSquare, Brain, Wrench, AlertTriangle, Terminal, FileText, Search, Copy, Check, Reply, Volume2, VolumeX, Mic, MicOff, Square, X, Paperclip, Loader2 } from 'lucide-react';
import { Markdown } from '../components/Markdown.tsx';
import { useProject } from '../hooks/useProject.tsx';
import { useChat } from '../hooks/useChat.tsx';
import { useAgents } from '../hooks/useAgents.tsx';
import { useDisplay } from '../hooks/useDisplay.tsx';
import type { StreamChunk, ToolCallState } from '../hooks/useChat.tsx';
import type { ChatMessage, Thread } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { shouldShow, type ContentType } from '@flightdeck-ai/shared/display';
import { ChatSidePanel } from '../components/ChatSidePanel.tsx';

// L2: Hoist regex outside component to avoid re-creation per call
const CJK_RE = /[\u4e00-\u9fff]/;

// M3: Hoist empty fallback arrays to avoid new references defeating memo
const EMPTY_CHUNKS: StreamChunk[] = [];

const AUTHOR_STYLES: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  user: { label: 'You', color: 'var(--color-primary)', bg: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', icon: <User size={16} strokeWidth={1.5} /> },
  lead: { label: 'Lead', color: '#d97706', bg: 'color-mix(in srgb, #d97706 10%, transparent)', icon: <Crown size={16} strokeWidth={1.5} /> },
  agent: { label: 'Agent', color: 'var(--color-status-in-review)', bg: 'color-mix(in srgb, var(--color-status-in-review) 10%, transparent)', icon: <Bot size={16} strokeWidth={1.5} /> },
  system: { label: 'System', color: 'var(--color-text-tertiary)', bg: 'transparent', icon: <SettingsIcon size={16} strokeWidth={1.5} /> },
};

function MessageToolbar({ msg, isUser, onReply }: { msg: ChatMessage; isUser: boolean; onReply: (m: ChatMessage) => void }) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  }, [msg.content]);

  const handleSpeak = useCallback(() => {
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(msg.content);
    utterance.lang = CJK_RE.test(msg.content) ? 'zh-CN' : 'en-US';
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, [msg.content]);

  return (
    <>
      {/* Top toolbar */}
      <div className={`absolute ${isUser ? 'left-0' : 'right-0'} -top-3 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 px-1.5 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm rounded-lg z-10`}>
        <button onClick={handleCopy} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Copy" aria-label="Copy message">
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
        </button>
        <button onClick={() => onReply(msg)} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Reply" aria-label="Reply to message">
          <Reply size={14} strokeWidth={1.5} />
        </button>
        <button onClick={handleSpeak} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Read aloud" aria-label="Read aloud">
          {speaking ? <VolumeX size={14} strokeWidth={1.5} /> : <Volume2 size={14} strokeWidth={1.5} />}
        </button>
      </div>

    </>
  );
}

function scrollToMessage(id: string) {
  const el = document.getElementById(`msg-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('animate-highlight');
  setTimeout(() => el.classList.remove('animate-highlight'), 1500);
}

const MessageBubble = memo(function MessageBubble({ msg, messages, replyCountMap, onReply, highlighted, agents }: { msg: ChatMessage; messages?: ChatMessage[]; replyCountMap?: Map<string, string[]>; onReply: (m: ChatMessage) => void; highlighted?: boolean; agents?: Array<{ id: string; role: string; runtime?: string; runtimeName?: string; model?: string; status?: string }> }) {
  const style = AUTHOR_STYLES[msg.authorType] ?? AUTHOR_STYLES.system;
  const isUser = msg.authorType === 'user';
  const parentMsg = msg.parentId && messages ? messages.find(m => m.id === msg.parentId) : null;
  const parentMsgs = msg.parentIds && messages ? msg.parentIds.map(pid => messages.find(m => m.id === pid)).filter(Boolean) as ChatMessage[] : [];

  if (msg.authorType === 'system') {
    return (
      <div className="text-center py-2">
        <span className="text-xs text-[var(--color-text-tertiary)] px-3 py-1 rounded-full bg-[var(--color-surface-secondary)]">
          {msg.content}
        </span>
      </div>
    );
  }

  const replies = replyCountMap?.get(msg.id);

  // H4: Memoize tooltip computation to avoid running on every render
  const avatarTitle = useMemo(() => {
    if (msg.authorType === 'user') return 'You';
    if (msg.authorType === 'system') return 'System';
    const agent = agents?.find(a => a.id === msg.authorId);
    const lines = [msg.authorType === 'lead' ? 'Lead Agent' : `${msg.authorId?.replace(/-[a-z0-9]+$/, '').replace(/^\w/, (c: string) => c.toUpperCase())} Agent`];
    if (msg.authorId) lines.push(`ID: ${msg.authorId}`);
    if (agent?.runtimeName) lines.push(`Runtime: ${agent.runtimeName}`);
    if (agent?.model) lines.push(`Model: ${agent.model}`);
    if (agent?.status) lines.push(`Status: ${agent.status}`);
    return lines.join('\n');
  }, [msg.authorType, msg.authorId, agents]);

  return (
    <div id={`msg-${msg.id}`} className={`group relative flex gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors min-w-0 ${isUser ? 'flex-row-reverse' : ''} ${highlighted ? 'ring-2 ring-[var(--color-primary)] bg-[var(--color-primary)]/5' : ''}`}>
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 cursor-default"
           style={{ backgroundColor: style.bg, color: style.color }}
           title={avatarTitle}>
        {style.icon}
      </div>
      <div className={`relative flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        <MessageToolbar msg={msg} isUser={isUser} onReply={onReply} />
        {parentMsgs.length > 1 ? (
          <div className={`text-xs text-[var(--color-text-tertiary)] mb-1 px-2 py-1 rounded border-l-2 border-[var(--color-border)] bg-[var(--color-surface-secondary)] max-w-[85%] cursor-pointer hover:bg-[var(--color-surface-hover)] ${isUser ? 'ml-auto' : ''}`}
            onClick={() => parentMsgs[0] && scrollToMessage(parentMsgs[0].id)}>
            {parentMsgs.map((pm, _i) => (
              <div key={pm.id} className="truncate">
                ↩ replying to {AUTHOR_STYLES[pm.authorType]?.label ?? pm.authorType}: {pm.content.slice(0, 60)}{pm.content.length > 60 ? '...' : ''}
              </div>
            ))}
          </div>
        ) : parentMsg && (
          <div className={`text-xs text-[var(--color-text-tertiary)] mb-1 px-2 py-1 rounded border-l-2 border-[var(--color-border)] bg-[var(--color-surface-secondary)] max-w-[85%] truncate cursor-pointer hover:bg-[var(--color-surface-hover)] ${isUser ? 'ml-auto' : ''}`}
            onClick={() => scrollToMessage(parentMsg.id)}>
            ↩ replying to {AUTHOR_STYLES[parentMsg.authorType]?.label ?? parentMsg.authorType}: {parentMsg.content.slice(0, 80)}{parentMsg.content.length > 80 ? '...' : ''}
          </div>
        )}
        <div className={`flex items-baseline gap-2 ${isUser ? 'justify-end' : ''}`}>
          <span className="text-sm font-medium" style={{ color: style.color }}>
            {msg.authorType === 'user' && msg.senderName
              ? msg.senderName
              : msg.authorType === 'agent' && msg.authorId
              ? msg.authorId.replace(/-[a-z0-9]+$/, '').replace(/^\w/, c => c.toUpperCase())
              : style.label}
          </span>
          {msg.source && msg.source !== 'web' && (
            <span className="text-xs px-1 rounded bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]" title={msg.source}>
              {msg.source === 'discord' ? '💬' : msg.source === 'slack' ? '⚡' : msg.source === 'telegram' ? '✈️' : msg.source === 'tui' ? '🖥️' : msg.source === 'api' ? '🔌' : '🌐'}
            </span>
          )}
          {msg.authorId && msg.authorType !== 'user' && msg.authorType !== 'agent' && (
            <span className="text-xs font-mono text-[var(--color-text-tertiary)]">{msg.authorId}</span>
          )}
          {msg.authorType === 'agent' && msg.authorId && (
            <span className="text-xs font-mono text-[var(--color-text-tertiary)]">{msg.authorId}</span>
          )}
          {msg.channelId?.startsWith('dm:') && (
            <span className="text-[10px] text-[var(--color-text-tertiary)] ml-1">
              → {msg.channelId.replace('dm:', '').replace(/-[a-z0-9]+$/, '')}
            </span>
          )}
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {new Date(msg.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className={`inline-block mt-1 text-sm break-words max-w-[85%] ${
          isUser
            ? 'px-3 py-2 rounded-2xl bg-[var(--color-primary)] text-white rounded-br-sm whitespace-pre-wrap text-left'
            : 'px-3 py-2 rounded-2xl bg-[var(--color-surface-secondary)] rounded-bl-sm'
        }`}>
          {(() => {
            const attMatch = msg.content.match(/\[attachments\](.*?)\[\/attachments\]/);
            const textContent = msg.content.replace(/\n*\[attachments\].*?\[\/attachments\]/, '').trim();
            let parsedAtts: Array<{ url: string; filename: string; mimeType: string; size: number }> = [];
            if (attMatch) { try { parsedAtts = JSON.parse(attMatch[1]); } catch {} }
            // Also include msg.attachments field if present
            const msgAtts = msg.attachments ?? [];
            const allAtts = [...parsedAtts, ...msgAtts];
            return (
              <>
                {textContent && (isUser ? textContent : <div className="overflow-x-auto"><Markdown content={textContent} /></div>)}
                {allAtts.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {allAtts.map((att, i) => (
                      att.mimeType.startsWith('image/') ? (
                        <a key={i} href={att.url} target="_blank" rel="noopener noreferrer">
                          <img src={att.url} alt={att.filename} className="max-w-[200px] max-h-[200px] rounded cursor-pointer hover:opacity-80 transition-opacity" />
                        </a>
                      ) : att.mimeType.startsWith('audio/') ? (
                        <div key={i}>
                          <div className="text-xs opacity-70 mb-1">{att.filename}</div>
                          <audio controls src={att.url} className="max-w-[250px]" />
                        </div>
                      ) : (
                        <a key={i} href={att.url} download={att.filename} className="flex items-center gap-1 px-2 py-1 rounded bg-black/10 hover:bg-black/20 text-xs">
                          📄 {att.filename}
                        </a>
                      )
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
        {replies && replies.length > 0 && (
          <button
            onClick={() => scrollToMessage(replies[0])}
            className={`text-xs text-[var(--color-primary)] hover:underline mt-1 ${isUser ? 'block ml-auto' : ''}`}>
            ↓ {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>
    </div>
  );
});

function TypingIndicator() {
  return (
    <div className="flex gap-3 py-2 px-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: AUTHOR_STYLES.lead.bg, color: AUTHOR_STYLES.lead.color }}>
        <Crown size={16} strokeWidth={1.5} />
      </div>
      <div className="flex items-center gap-1 px-4 py-3 rounded-2xl rounded-bl-sm bg-[var(--color-surface-secondary)]">
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function getToolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.startsWith('flightdeck_')) return <SettingsIcon size={14} strokeWidth={1.5} className="inline mr-1" />;
  if (/bash|shell|execute|terminal|command/.test(n)) return <Terminal size={14} strokeWidth={1.5} className="inline mr-1" />;
  if (/read|write|edit|file|create/.test(n)) return <FileText size={14} strokeWidth={1.5} className="inline mr-1" />;
  if (/search|grep|find|glob/.test(n)) return <Search size={14} strokeWidth={1.5} className="inline mr-1" />;
  return <Wrench size={14} strokeWidth={1.5} className="inline mr-1" />;
}

export function ToolCallCard({ tc, level }: { tc: ToolCallState; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (!tc.name) return null; // Hide empty tool calls

  const icon = getToolIcon(tc.name);
  const briefInput = tc.input ? tc.input.slice(0, 60).replace(/\n/g, ' ') : '';
  const briefResult = tc.result ? tc.result.slice(0, 60).replace(/\n/g, ' ') : '';
  const isPending = tc.status === 'pending' || tc.status === 'running';

  if (level === 'summary') {
    return (
      <details className="inline-block max-w-full">
        <summary className="text-xs px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--color-status-running)_15%,transparent)] text-[var(--color-status-running)] cursor-pointer select-none">
          {icon}{tc.name}{briefInput ? `(${briefInput}${tc.input.length > 60 ? '...' : ''})` : ''}
          {tc.result ? ` → ${briefResult}${tc.result.length > 60 ? '...' : ''}` : isPending ? ' ⏳' : ''}
        </summary>
        <div className="mt-1 px-3 py-2 text-xs font-mono bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg max-h-48 overflow-y-auto whitespace-pre-wrap">
          {tc.input && <><strong>Input:</strong>\n{tc.input}\n\n</>}
          {tc.result && <><strong>Result:</strong>\n{tc.result}</>}
          {isPending && !tc.result && <span className="text-[var(--color-text-tertiary)] italic">Running...</span>}
        </div>
      </details>
    );
  }

  // detail mode
  return (
    <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer select-none">
        {icon}{tc.name}
        {isPending && !tc.result && <span className="ml-2 text-[var(--color-text-tertiary)] animate-pulse">running...</span>}
      </summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {tc.input && <><span className="text-[var(--color-text-tertiary)]">Input:</span>\n{tc.input}\n\n</>}
        {tc.result && <><span className="text-[var(--color-text-tertiary)]">→ Result:</span>\n{tc.result}</>}
      </div>
    </details>
  );
}

function StreamingBubble({ content, chunks, toolCallMap, displayConfig }: {
  content: string;
  chunks?: StreamChunk[];
  toolCallMap: Map<string, ToolCallState>;
  displayConfig: import('@flightdeck-ai/shared/display').DisplayConfig;
}) {
  const sections = groupChunks(chunks ?? [{ content, contentType: 'text' }]);
  // Collect toolCallIds already rendered so we don't duplicate
  const renderedToolCallIds = new Set<string>();

  return (
    <div className="flex gap-3 py-2 px-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: AUTHOR_STYLES.lead.bg, color: AUTHOR_STYLES.lead.color }}>
        <Crown size={16} strokeWidth={1.5} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium" style={{ color: AUTHOR_STYLES.lead.color }}>Lead</span>
          <span className="text-xs text-[var(--color-status-running)] animate-pulse">typing...</span>
        </div>
        <div className="mt-1 space-y-1">
          {sections.map((section, i) => {
            if (!shouldShow(displayConfig, section.contentType, section.toolName)) return null;
            if (section.contentType === 'thinking') {
              return <ThinkingBlock key={i} content={section.content} />;
            }
            if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call' ||
                section.contentType === 'tool_result' || section.contentType === 'flightdeck_tool_result') {
              // Parse toolCallId and render merged card
              try {
                const parsed = JSON.parse(section.content);
                if (parsed.toolCallId) {
                  if (renderedToolCallIds.has(parsed.toolCallId)) return null;
                  renderedToolCallIds.add(parsed.toolCallId);
                  const tc = toolCallMap.get(parsed.toolCallId);
                  if (!tc || !tc.name) return null; // Hide empty
                  const isFlightdeck = tc.contentType === 'flightdeck_tool_call';
                  const level = isFlightdeck ? displayConfig.flightdeckTools : displayConfig.toolCalls;
                  return <ToolCallCard key={parsed.toolCallId} tc={tc} level={level} />;
                }
                if (!parsed.name) return null; // Hide empty tool calls
              } catch {}
              // Fallback for non-JSON tool calls (legacy)
              const level = (section.contentType === 'flightdeck_tool_call' || section.contentType === 'flightdeck_tool_result')
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call') {
                if (!section.toolName) return null; // Hide empty tool calls
                return <ToolCallBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
              }
              if (!section.toolName) return null;
              return <ToolResultBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
            }
            return <div key={i} className="text-sm break-words"><Markdown content={section.content} /></div>;
          })}
          <span className="animate-pulse">▊</span>
        </div>
      </div>
    </div>
  );
}

export interface ChunkSection { contentType: ContentType; toolName?: string; content: string; }

export function groupChunks(chunks: StreamChunk[]): ChunkSection[] {
  const sections: ChunkSection[] = [];
  for (const chunk of chunks) {
    const ct = chunk.contentType ?? 'text';
    const last = sections[sections.length - 1];
    if (last && last.contentType === ct && last.toolName === chunk.toolName) {
      last.content += chunk.content;
    } else {
      sections.push({ contentType: ct, toolName: chunk.toolName, content: chunk.content });
    }
  }
  return sections;
}

export function ThinkingBlock({ content }: { content: string }) {
  const preview = content.split('\n').slice(0, 2).join('\n');
  const isLong = content.length > 200;
  return (
    <details className="rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
      <summary className="px-3 py-1.5 text-xs text-[var(--color-text-tertiary)] italic font-mono cursor-pointer select-none">
        <Brain size={14} strokeWidth={1.5} className="inline mr-1" />{isLong ? preview.slice(0, 120) + '...' : preview}
      </summary>
      <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] italic font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

export function ToolCallBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (level === 'summary') {
    const brief = content.slice(0, 80).replace(/\n/g, ' ');
    return (
      <details className="inline-block">
        <summary className="text-xs px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--color-status-running)_15%,transparent)] text-[var(--color-status-running)] cursor-pointer select-none">
          <Wrench size={14} strokeWidth={1.5} className="inline mr-1" />{toolName ?? 'tool'}({brief})
        </summary>
        <div className="mt-1 px-3 py-2 text-xs font-mono bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg max-h-48 overflow-y-auto whitespace-pre-wrap">
          {content}
        </div>
      </details>
    );
  }
  return (
    <details open className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer select-none"><Wrench size={14} strokeWidth={1.5} className="inline mr-1" />{toolName ?? 'tool'}</summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">{content}</div>
    </details>
  );
}

export function ToolResultBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (level === 'summary') {
    const brief = content.slice(0, 60).replace(/\n/g, ' ');
    return <span className="text-xs text-[var(--color-text-tertiary)] font-mono">→ {brief}{content.length > 60 ? '...' : ''}</span>;
  }
  return (
    <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs text-[var(--color-text-secondary)] cursor-pointer select-none">Result from {toolName ?? 'tool'}</summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">{content}</div>
    </details>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ThreadSidebar({ threads, activeThread, onSelect }: {
  threads: Thread[];
  activeThread: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="w-56 border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] flex flex-col">
      <div className="px-3 py-3 border-b border-[var(--color-border)]">
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Threads</h3>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <button onClick={() => onSelect(null)}
          className={`w-full text-left px-3 py-2 text-sm transition-colors ${
            activeThread === null ? 'bg-[var(--color-surface-hover)] font-medium' : 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'
          }`}>
          Main
        </button>
        {threads.map(t => (
          <button key={t.id} onClick={() => onSelect(t.id)}
            className={`w-full text-left px-3 py-2 text-sm truncate transition-colors ${
              activeThread === t.id ? 'bg-[var(--color-surface-hover)] font-medium' : 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'
            }`}>
            {t.title ?? `Thread ${t.id.slice(0, 8)}`}
          </button>
        ))}
        {threads.length === 0 && (
          <p className="px-3 py-4 text-xs text-[var(--color-text-tertiary)]">No threads yet</p>
        )}
      </div>
    </div>
  );
}

class MessageAreaErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('MessageArea error:', error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center text-[var(--color-text-secondary)]">
          <div className="text-center">
            <p className="text-2xl mb-2"><AlertTriangle size={28} strokeWidth={1.5} className="mx-auto" /></p>
            <p>Something went wrong rendering messages.</p>
            <p className="text-xs mt-1 text-[var(--color-text-tertiary)]">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-3 px-3 py-1 text-sm rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-secondary)]">
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Chat() {
  // H5 TODO: Group related states into custom hooks to reduce re-render surface:
  // - useSearchState() for searchQuery, showSearch, searchIdx
  // - useSpeechRecognition() for isListening, speechLang, recognition
  // - useChatInput() for input, replyTo, waitingForLead
  const { messages, streamingMessages, streamingChunks, toolCallMap, sendChat, interruptLead } = useChat();
  const { displayConfig } = useDisplay();
  const { connected, projectName } = useProject();
  const { agents } = useAgents();
  const leadAgent = agents.find(a => a.role === 'lead' && !['retired', 'errored'].includes(a.status));
  const isLeadSpawning = !leadAgent && agents.length === 0 && messages.length > 0;
  const [input, setInput] = useState('');
  const [waitingForLead, setWaitingForLead] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [activeThread, _setActiveThread] = useState<string | null>(null);
  const [, setThreads] = useState<Thread[]>([]);
  const [_showThreads, _setShowThreads] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);
  const [attachments, setAttachments] = useState<Array<{
    file: File;
    preview?: string;
    uploading: boolean;
    url?: string;
  }>>([]);
  const [isDragging, setIsDragging] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File) => {
    const entry: typeof attachments[number] = { file, uploading: true };
    if (file.type.startsWith('image/')) {
      entry.preview = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
    }
    setAttachments(prev => [...prev, entry]);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName!)}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setAttachments(prev => prev.map((a, i) => i === prev.length - 1 && a.file === file ? { ...a, uploading: false, url: data.url } : a));
      } else {
        setAttachments(prev => prev.filter(a => a.file !== file));
      }
    } catch {
      setAttachments(prev => prev.filter(a => a.file !== file));
    }
  }, [projectName]);

  const addFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(f => uploadFile(f));
  }, [uploadFile]);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  // Cmd+F to open chat search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSearch]);

  // H6: Add projectName to deps so threads refetch when project changes
  useEffect(() => {
    if (projectName) api.getThreads(projectName).then(setThreads).catch(() => {});
  }, [projectName]);

  // Filter messages by thread
  const filteredMessages = useMemo(() =>
    activeThread
      ? messages.filter(m => m.threadId === activeThread)
      : messages.filter(m => !m.threadId && !m.taskId),
    [messages, activeThread]
  );

  // Search matches
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return filteredMessages
      .filter(m => m.content?.toLowerCase().includes(q))
      .map(m => m.id);
  }, [filteredMessages, searchQuery]);

  // Scroll to current search match
  useEffect(() => {
    if (searchMatches.length > 0 && searchMatches[searchIdx]) {
      scrollToMessage(searchMatches[searchIdx]);
    }
  }, [searchIdx, searchMatches]);

  const replyCountMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of filteredMessages) {
      const pids = m.parentIds ?? (m.parentId ? [m.parentId] : []);
      for (const pid of pids) {
        const arr = map.get(pid);
        if (arr) arr.push(m.id);
        else map.set(pid, [m.id]);
      }
    }
    return map;
  }, [filteredMessages]);

  const handleReply = useCallback((m: ChatMessage) => setReplyTo(m), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length, streamingMessages.size]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const readyAttachments = attachments.filter(a => a.url);
    let msgContent = text;
    if (readyAttachments.length > 0) {
      const attJson = readyAttachments.map(a => ({ url: a.url!, filename: a.file.name, mimeType: a.file.type, size: a.file.size }));
      msgContent = text + '\n\n[attachments]' + JSON.stringify(attJson) + '[/attachments]';
    }
    sendChat(msgContent, replyTo?.id, activeThread ?? undefined);
    setInput('');
    setAttachments([]);
    setReplyTo(null);
    setWaitingForLead(true);
    // Stop recording if active — set sentRef to ignore final transcript
    sentRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
    inputRef.current?.focus();
  }, [input, replyTo, sendChat, activeThread]);

  // M11: Use rAF to batch textarea height calculation, reducing layout thrashing
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    requestAnimationFrame(() => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 128) + 'px';
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
  };

  const messageIds = useMemo(() => new Set(messages.map(m => m.id)), [messages]);
  const streamEntries = [...streamingMessages.entries()].filter(([id]) => !messageIds.has(id));
  const isStreaming = streamEntries.length > 0;

  // Clear waiting state when streaming starts or new message from lead/system arrives
  useEffect(() => {
    const lastMsg = filteredMessages[filteredMessages.length - 1];
    if (isStreaming || (lastMsg && lastMsg.authorType !== 'user')) {
      setWaitingForLead(false);
    }
  }, [isStreaming, filteredMessages]);

  // Speech recognition
  const [isListening, setIsListening] = useState(false);
  const [speechLang, setSpeechLang] = useState(() => {
    try { return localStorage.getItem('flightdeck:speech-lang') ?? (navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US'); } catch { return 'en-US'; }
  });
  const recognitionRef = useRef<any>(null);
  const sentRef = useRef(false);
  // #12: SpeechRecognition types — non-standard API, accessed via (window as any)
  const speechSupported = useMemo(() => {
    return typeof window !== 'undefined' && !!(
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    // SpeechRecognition is a non-standard browser API, accessed via (window as any)
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = speechLang;
    recognition.onresult = (event: any) => {
      if (sentRef.current) return; // Ignore results after send
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 128) + 'px';
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    sentRef.current = false;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  return (
    <div className="flex" style={{ margin: '-2rem', height: 'calc(100% + 4rem)' }}>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Status bar */}
        {!connected && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <span className="text-xs text-[var(--color-status-failed)] flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--color-status-failed)]" /> Disconnected
            </span>
          </div>
        )}

        {/* Search bar */}
        {showSearch && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <Search size={14} className="text-[var(--color-text-tertiary)] shrink-0" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && searchMatches.length > 0) {
                  setSearchIdx(prev => (e.shiftKey ? (prev - 1 + searchMatches.length) % searchMatches.length : (prev + 1) % searchMatches.length));
                }
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); }
              }}
              placeholder="Search in conversation..."
              className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
            />
            {searchQuery && (
              <span className="text-xs text-[var(--color-text-tertiary)] shrink-0">
                {searchMatches.length > 0 ? `${searchIdx + 1}/${searchMatches.length}` : 'No results'}
              </span>
            )}
            <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className="p-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]" aria-label="Close search">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Messages */}
        <MessageAreaErrorBoundary>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="max-w-4xl mx-auto space-y-1">
            {filteredMessages.length === 0 && streamEntries.length === 0 && (
              <div className="text-center py-16 text-[var(--color-text-secondary)]">
                <MessageSquare size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
                <p>No messages yet.</p>
                <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">
                  {connected ? 'Send a message to start a conversation with Lead.' : 'Waiting for connection...'}
                </p>
              </div>
            )}
            {filteredMessages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} messages={filteredMessages} replyCountMap={replyCountMap} onReply={handleReply} highlighted={searchMatches.includes(msg.id)} agents={agents} />
            ))}
            {streamEntries.map(([id, content]) => (
              <StreamingBubble key={id} content={content}
                chunks={streamingChunks.get(id) ?? EMPTY_CHUNKS} toolCallMap={toolCallMap} displayConfig={displayConfig} />
            ))}

            {isLeadSpawning && (
              <div className="flex items-center gap-2 px-4 py-3 mx-4 rounded-xl bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)]">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Lead is starting up…
              </div>
            )}
            {waitingForLead && !isStreaming && <TypingIndicator />}
            <div ref={bottomRef} />
            </div>
          </div>
        </MessageAreaErrorBoundary>

        {/* Input */}
        <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface)] flex-shrink-0">
          <div className="max-w-4xl mx-auto">
          {replyTo && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface-secondary)] text-xs">
              <span className="text-[var(--color-text-tertiary)]">Replying to</span>
              <span className="font-medium">{AUTHOR_STYLES[replyTo.authorType]?.label}</span>
              <span className="text-[var(--color-text-secondary)] truncate flex-1">{replyTo.content.slice(0, 80)}</span>
              <button onClick={() => setReplyTo(null)} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">✕</button>
            </div>
          )}
          <div className="flex gap-2 items-stretch">
            <div className={`flex-1 flex flex-col bg-[var(--color-surface-secondary)] border rounded-xl overflow-hidden transition-colors ${isDragging ? 'border-[var(--color-primary)] border-2 bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)]' : 'border-[var(--color-border)]'}`}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={e => { e.preventDefault(); setIsDragging(false); }}
              onDrop={e => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
              {attachments.length > 0 && (
                <div className="flex gap-2 px-3 py-2 border-b border-[var(--color-border)] overflow-x-auto">
                  {attachments.map((att, i) => (
                    <div key={i} className="relative group shrink-0">
                      {att.file.type.startsWith('image/') && att.preview ? (
                        <img src={att.preview} className="w-16 h-16 object-cover rounded" alt={att.file.name} />
                      ) : att.file.type.startsWith('audio/') ? (
                        <div className="w-16 h-16 rounded bg-[var(--color-surface)] flex items-center justify-center text-xl" title={att.file.name}>🎵</div>
                      ) : (
                        <div className="w-16 h-16 rounded bg-[var(--color-surface)] flex items-center justify-center text-xl" title={att.file.name}>📄</div>
                      )}
                      <button onClick={() => removeAttachment(i)} className="absolute -top-1 -right-1 w-4 h-4 bg-[var(--color-text-tertiary)] text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--color-status-failed)]">✕</button>
                      {att.uploading && <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded"><Loader2 size={16} className="animate-spin text-white" /></div>}
                    </div>
                  ))}
                </div>
              )}
              <textarea ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
                onPaste={e => {
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0) {
                    e.preventDefault();
                    addFiles(files);
                    return;
                  }
                  // Check items for images
                  const items = e.clipboardData?.items;
                  if (items) {
                    for (const item of Array.from(items)) {
                      if (item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) { e.preventDefault(); addFiles([file]); return; }
                      }
                    }
                  }
                }}
                placeholder={connected ? (isDragging ? 'Drop files here...' : 'Message Lead... (Enter to send)') : 'Connecting...'}
                disabled={!connected} rows={1}
                className="flex-1 resize-none bg-transparent px-4 py-2.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none disabled:opacity-50 max-h-32 overflow-y-auto"
              />
              <input ref={fileInputRef} type="file" multiple accept="image/*,text/*,audio/*,.pdf" className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <button onClick={() => fileInputRef.current?.click()} className="px-3 py-2.5 rounded-xl bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors" title="Attach files">
              <Paperclip size={16} strokeWidth={1.5} />
            </button>
            {speechSupported && (
              <div className="flex items-stretch">
                <button onClick={toggleListening}
                  className={`px-3 rounded-l-xl text-sm transition-all ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)] border-r-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}`}
                  title={isListening ? 'Stop listening' : 'Voice input'}>
                  {isListening ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
                </button>
                <div className="relative flex items-stretch">
                  <select value={speechLang} onChange={e => {
                    setSpeechLang(e.target.value);
                    try { localStorage.setItem('flightdeck:speech-lang', e.target.value); } catch {}
                  }}
                    className={`absolute inset-0 opacity-0 cursor-pointer w-full h-full`}
                    title="Speech language">
                    {[
                      ['af-ZA','Afrikaans'],['ar-SA','Arabic'],['ca-ES','Catalan'],['cs-CZ','Czech'],['da-DK','Danish'],
                      ['de-DE','German'],['el-GR','Greek'],['en-GB','English (UK)'],['en-US','English (US)'],['es-ES','Spanish'],
                      ['fi-FI','Finnish'],['fil-PH','Filipino'],['fr-FR','French'],['he-IL','Hebrew'],['hi-IN','Hindi'],
                      ['hu-HU','Hungarian'],['id-ID','Indonesian'],['it-IT','Italian'],['ja-JP','Japanese'],['ko-KR','Korean'],
                      ['ms-MY','Malay'],['nb-NO','Norwegian'],['nl-NL','Dutch'],['pl-PL','Polish'],['pt-BR','Portuguese (BR)'],
                      ['pt-PT','Portuguese (PT)'],['ro-RO','Romanian'],['ru-RU','Russian'],['sv-SE','Swedish'],['th-TH','Thai'],
                      ['tr-TR','Turkish'],['uk-UA','Ukrainian'],['vi-VN','Vietnamese'],['zh-CN','Chinese (Simplified)'],['zh-HK','Cantonese'],['zh-TW','Chinese (Traditional)'],
                    ].map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                  </select>
                  <span className={`flex items-center text-[9px] px-1.5 rounded-r-xl pointer-events-none ${isListening ? 'bg-red-500 text-white/60' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)] border-l-0 text-[var(--color-text-tertiary)]'}`}>▾</span>
                </div>
              </div>
            )}
            {isStreaming && (
              <button onClick={interruptLead}
                className="px-3 py-2.5 rounded-xl bg-[var(--color-status-failed)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                title="Stop Lead"
                aria-label="Stop Lead">
                <Square size={16} strokeWidth={1.5} fill="currentColor" />
              </button>
            )}
            <button onClick={handleSend} disabled={!connected || !input.trim()}
              className="px-5 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity"
              aria-label="Send message">
              <Send size={16} strokeWidth={1.5} />
            </button>
          </div>
          </div>
        </div>
      </div>
      <ChatSidePanel />
    </div>
  );
}

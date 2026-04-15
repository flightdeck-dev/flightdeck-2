import { useState, useRef, useEffect, useCallback, useMemo, memo, Component, type ReactNode, type ErrorInfo } from 'react';
import { Bot, Crown, User, Settings as SettingsIcon, Send, MessageSquare, ChevronLeft, ChevronRight, Brain, Wrench, AlertTriangle, Terminal, FileText, Search, Copy, Check, Reply, Volume2, VolumeX, Mic, MicOff, Square } from 'lucide-react';
import { Markdown } from '../components/Markdown.tsx';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { StreamChunk, ToolCallState } from '../hooks/useFlightdeck.tsx';
import type { ChatMessage, Thread } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { shouldShow, type ContentType } from '@flightdeck-ai/shared/display';

const AUTHOR_STYLES: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  user: { label: 'You', color: '#2f80ed', bg: 'color-mix(in srgb, #2f80ed 10%, transparent)', icon: <User size={16} strokeWidth={1.5} /> },
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
    utterance.lang = /[\u4e00-\u9fff]/.test(msg.content) ? 'zh-CN' : 'en-US';
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, [msg.content]);

  return (
    <>
      {/* Top toolbar */}
      <div className={`absolute ${isUser ? 'left-0' : 'right-0'} -top-3 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 px-1.5 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm rounded-lg z-10`}>
        <button onClick={handleCopy} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Copy">
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
        </button>
        <button onClick={() => onReply(msg)} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Reply">
          <Reply size={14} strokeWidth={1.5} />
        </button>
        <button onClick={handleSpeak} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Read aloud">
          {speaking ? <VolumeX size={14} strokeWidth={1.5} /> : <Volume2 size={14} strokeWidth={1.5} />}
        </button>
      </div>
      {/* Bottom toolbar */}
      <div className={`absolute ${isUser ? 'right-0' : 'left-0'} -bottom-5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 px-1.5 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm rounded-lg z-10`}>
        <button onClick={handleCopy} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Copy">
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
        </button>
        <button onClick={() => onReply(msg)} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Reply">
          <Reply size={14} strokeWidth={1.5} />
        </button>
        <button onClick={handleSpeak} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" title="Read aloud">
          {speaking ? <VolumeX size={14} strokeWidth={1.5} /> : <Volume2 size={14} strokeWidth={1.5} />}
        </button>
      </div>
    </>
  );
}

const MessageBubble = memo(function MessageBubble({ msg, messages, onReply }: { msg: ChatMessage; messages?: ChatMessage[]; onReply: (m: ChatMessage) => void }) {
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

  return (
    <div className={`group relative flex gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors min-w-0 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: style.bg, color: style.color }}>
        {style.icon}
      </div>
      <div className={`relative flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        <MessageToolbar msg={msg} isUser={isUser} onReply={onReply} />
        {parentMsgs.length > 1 ? (
          <div className={`text-xs text-[var(--color-text-tertiary)] mb-1 px-2 py-1 rounded border-l-2 border-[var(--color-border)] bg-[var(--color-surface-secondary)] max-w-[85%] ${isUser ? 'ml-auto' : ''}`}>
            {parentMsgs.map((pm, i) => (
              <div key={pm.id} className="truncate">
                ↩ replying to {AUTHOR_STYLES[pm.authorType]?.label ?? pm.authorType}: {pm.content.slice(0, 60)}{pm.content.length > 60 ? '...' : ''}
              </div>
            ))}
          </div>
        ) : parentMsg && (
          <div className={`text-xs text-[var(--color-text-tertiary)] mb-1 px-2 py-1 rounded border-l-2 border-[var(--color-border)] bg-[var(--color-surface-secondary)] max-w-[85%] truncate ${isUser ? 'ml-auto' : ''}`}>
            ↩ replying to {AUTHOR_STYLES[parentMsg.authorType]?.label ?? parentMsg.authorType}: {parentMsg.content.slice(0, 80)}{parentMsg.content.length > 80 ? '...' : ''}
          </div>
        )}
        <div className={`flex items-baseline gap-2 ${isUser ? 'justify-end' : ''}`}>
          <span className="text-sm font-medium" style={{ color: style.color }}>{style.label}</span>
          {msg.authorId && msg.authorType !== 'user' && (
            <span className="text-xs font-mono text-[var(--color-text-tertiary)]">{msg.authorId}</span>
          )}
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {new Date(msg.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className={`inline-block mt-1 text-sm break-words max-w-[85%] ${
          isUser
            ? 'px-3 py-2 rounded-2xl bg-[#2f80ed] text-white rounded-br-sm whitespace-pre-wrap'
            : ''
        }`}>
          {isUser ? msg.content : <div className="overflow-x-auto"><Markdown content={msg.content} /></div>}
        </div>
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
              } catch {}
              // Fallback for non-JSON tool calls (legacy)
              const level = (section.contentType === 'flightdeck_tool_call' || section.contentType === 'flightdeck_tool_result')
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call') {
                return <ToolCallBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
              }
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

function ThreadSidebar({ threads, activeThread, onSelect }: {
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
  const { messages, streamingMessages, streamingChunks, toolCallMap, displayConfig, sendChat, interruptLead, connected, projectName } = useFlightdeck();
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [showThreads, setShowThreads] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch threads
  useEffect(() => {
    if (projectName) api.getThreads(projectName).then(setThreads).catch(() => {});
  }, []);

  // Filter messages by thread
  const filteredMessages = useMemo(() =>
    activeThread
      ? messages.filter(m => m.threadId === activeThread)
      : messages.filter(m => !m.threadId && !m.taskId),
    [messages, activeThread]
  );

  const handleReply = useCallback((m: ChatMessage) => setReplyTo(m), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length, streamingMessages.size]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    sendChat(text, replyTo?.id, activeThread ?? undefined);
    setInput('');
    setReplyTo(null);
    inputRef.current?.focus();
  }, [input, replyTo, sendChat, activeThread]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
  };

  const messageIds = useMemo(() => new Set(messages.map(m => m.id)), [messages]);
  const streamEntries = [...streamingMessages.entries()].filter(([id]) => !messageIds.has(id));
  const isStreaming = streamEntries.length > 0;

  // Speech recognition
  const [isListening, setIsListening] = useState(false);
  const [speechLang, setSpeechLang] = useState(() => {
    try { return localStorage.getItem('flightdeck:speech-lang') ?? (navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US'); } catch { return 'en-US'; }
  });
  const recognitionRef = useRef<any>(null);
  const speechSupported = useMemo(() => {
    return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = speechLang;
    recognition.onresult = (event: any) => {
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
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  return (
    <div className="flex" style={{ margin: '-2rem', height: 'calc(100% + 4rem)' }}>
      <div className="flex flex-col flex-1 max-w-4xl mx-auto min-w-0 overflow-hidden">
        {/* Status bar */}
        {!connected && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <span className="text-xs text-[var(--color-status-failed)] flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--color-status-failed)]" /> Disconnected
            </span>
          </div>
        )}

        {/* Messages */}
        <MessageAreaErrorBoundary>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
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
              <MessageBubble key={msg.id} msg={msg} messages={filteredMessages} onReply={handleReply} />
            ))}
            {streamEntries.map(([id, content]) => (
              <StreamingBubble key={id} content={content}
                chunks={streamingChunks.get(id)} toolCallMap={toolCallMap} displayConfig={displayConfig} />
            ))}
            {!isStreaming && filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1]?.authorType === 'user' && (
              <TypingIndicator />
            )}
            <div ref={bottomRef} />
          </div>
        </MessageAreaErrorBoundary>

        {/* Input */}
        <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface)] flex-shrink-0">
          {isStreaming && (
            <div className="flex items-center justify-between mb-2 px-3 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--color-status-failed)_8%,transparent)]">
              <span className="text-xs text-[var(--color-text-secondary)] animate-pulse">Lead is responding...</span>
              <button onClick={interruptLead}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-80"
                style={{ backgroundColor: 'var(--color-status-failed)' }}>
                <Square size={12} strokeWidth={2} fill="currentColor" /> Interrupt
              </button>
            </div>
          )}
          {replyTo && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface-secondary)] text-xs">
              <span className="text-[var(--color-text-tertiary)]">Replying to</span>
              <span className="font-medium">{AUTHOR_STYLES[replyTo.authorType]?.label}</span>
              <span className="text-[var(--color-text-secondary)] truncate flex-1">{replyTo.content.slice(0, 80)}</span>
              <button onClick={() => setReplyTo(null)} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">✕</button>
            </div>
          )}
          <div className="flex gap-2">
            <textarea ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
              placeholder={connected ? 'Message Lead... (Enter to send)' : 'Connecting...'}
              disabled={!connected} rows={1}
              className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[#2f80ed] disabled:opacity-50 max-h-32 overflow-y-auto"
            />
            {speechSupported && (
              <div className="flex items-center">
                <select value={speechLang} onChange={e => {
                  setSpeechLang(e.target.value);
                  try { localStorage.setItem('flightdeck:speech-lang', e.target.value); } catch {}
                }}
                  className="py-2 pl-2 pr-1 text-[11px] font-mono bg-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] border-none focus:outline-none cursor-pointer appearance-none"
                  title="Speech recognition language">
                  <optgroup label="Common">
                    <option value="en-US">English (US)</option>
                    <option value="en-GB">English (UK)</option>
                    <option value="zh-CN">中文 (简体)</option>
                    <option value="zh-TW">中文 (繁體)</option>
                    <option value="zh-HK">粵語 (香港)</option>
                    <option value="ja-JP">日本語</option>
                    <option value="ko-KR">한국어</option>
                  </optgroup>
                  <optgroup label="European">
                    <option value="es-ES">Español</option>
                    <option value="fr-FR">Français</option>
                    <option value="de-DE">Deutsch</option>
                    <option value="it-IT">Italiano</option>
                    <option value="pt-BR">Português (BR)</option>
                    <option value="pt-PT">Português (PT)</option>
                    <option value="nl-NL">Nederlands</option>
                    <option value="pl-PL">Polski</option>
                    <option value="ru-RU">Русский</option>
                    <option value="uk-UA">Українська</option>
                    <option value="sv-SE">Svenska</option>
                    <option value="da-DK">Dansk</option>
                    <option value="nb-NO">Norsk</option>
                    <option value="fi-FI">Suomi</option>
                    <option value="el-GR">Ελληνικά</option>
                    <option value="cs-CZ">Čeština</option>
                    <option value="ro-RO">Română</option>
                    <option value="hu-HU">Magyar</option>
                    <option value="tr-TR">Türkçe</option>
                  </optgroup>
                  <optgroup label="Asian">
                    <option value="hi-IN">हिन्दी</option>
                    <option value="th-TH">ไทย</option>
                    <option value="vi-VN">Tiếng Việt</option>
                    <option value="id-ID">Bahasa Indonesia</option>
                    <option value="ms-MY">Bahasa Melayu</option>
                    <option value="fil-PH">Filipino</option>
                  </optgroup>
                  <optgroup label="Other">
                    <option value="ar-SA">العربية</option>
                    <option value="he-IL">עברית</option>
                    <option value="af-ZA">Afrikaans</option>
                    <option value="ca-ES">Català</option>
                  </optgroup>
                </select>
                <button onClick={toggleListening}
                  className={`px-3 py-2.5 rounded-xl text-sm transition-all ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}`}
                  title={isListening ? 'Stop listening' : 'Voice input'}>
                  {isListening ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
                </button>
              </div>
            )}
            <button onClick={handleSend} disabled={!connected || !input.trim()}
              className="px-5 py-2.5 rounded-xl bg-[#2f80ed] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity">
              <Send size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

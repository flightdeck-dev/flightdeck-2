import { useState, useRef, useEffect, useCallback, useMemo, memo, Component, type ReactNode, type ErrorInfo } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { StreamChunk } from '../hooks/useFlightdeck.tsx';
import type { ChatMessage, Thread } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { shouldShow, type ContentType } from '@flightdeck-ai/shared/display';

const AUTHOR_STYLES: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  user: { label: 'You', color: 'var(--color-status-ready)', bg: 'color-mix(in srgb, var(--color-status-ready) 10%, transparent)', icon: '👤' },
  lead: { label: 'Lead', color: 'var(--color-status-running)', bg: 'color-mix(in srgb, var(--color-status-running) 10%, transparent)', icon: '👑' },
  agent: { label: 'Agent', color: 'var(--color-status-in-review)', bg: 'color-mix(in srgb, var(--color-status-in-review) 10%, transparent)', icon: '🤖' },
  system: { label: 'System', color: 'var(--color-text-tertiary)', bg: 'transparent', icon: '⚙' },
};

const MessageBubble = memo(function MessageBubble({ msg, onReply }: { msg: ChatMessage; onReply: (m: ChatMessage) => void }) {
  const style = AUTHOR_STYLES[msg.authorType] ?? AUTHOR_STYLES.system;
  const isUser = msg.authorType === 'user';

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
    <div className={`group flex gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: style.bg, color: style.color }}>
        {style.icon}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        <div className={`flex items-baseline gap-2 ${isUser ? 'justify-end' : ''}`}>
          <span className="text-sm font-medium" style={{ color: style.color }}>{style.label}</span>
          {msg.authorId && msg.authorType !== 'user' && (
            <span className="text-xs font-mono text-[var(--color-text-tertiary)]">{msg.authorId}</span>
          )}
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {new Date(msg.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className={`inline-block mt-1 px-3 py-2 rounded-2xl text-sm break-words max-w-[85%] ${
          isUser
            ? 'bg-[var(--color-status-ready)] text-white rounded-br-sm whitespace-pre-wrap'
            : 'bg-[var(--color-surface-secondary)] rounded-bl-sm'
        }`}>
          {isUser ? msg.content : <Markdown content={msg.content} />}
        </div>
      </div>
      <button
        onClick={() => onReply(msg)}
        className="opacity-0 group-hover:opacity-100 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-opacity shrink-0 self-start mt-1"
        title="Reply"
      >
        ↩
      </button>
    </div>
  );
});

function TypingIndicator() {
  return (
    <div className="flex gap-3 py-2 px-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: AUTHOR_STYLES.lead.bg, color: AUTHOR_STYLES.lead.color }}>
        👑
      </div>
      <div className="flex items-center gap-1 px-4 py-3 rounded-2xl rounded-bl-sm bg-[var(--color-surface-secondary)]">
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function StreamingBubble({ content, chunks, displayConfig }: {
  content: string;
  chunks?: StreamChunk[];
  displayConfig: import('@flightdeck-ai/shared/display').DisplayConfig;
}) {
  const sections = groupChunks(chunks ?? [{ content, contentType: 'text' }]);

  return (
    <div className="flex gap-3 py-2 px-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
           style={{ backgroundColor: AUTHOR_STYLES.lead.bg, color: AUTHOR_STYLES.lead.color }}>
        👑
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
            if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call') {
              const level = section.contentType === 'flightdeck_tool_call'
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              return <ToolCallBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
            }
            if (section.contentType === 'tool_result' || section.contentType === 'flightdeck_tool_result') {
              const level = section.contentType === 'flightdeck_tool_result'
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
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

interface ChunkSection { contentType: ContentType; toolName?: string; content: string; }

function groupChunks(chunks: StreamChunk[]): ChunkSection[] {
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

function ThinkingBlock({ content }: { content: string }) {
  const preview = content.split('\n').slice(0, 2).join('\n');
  const isLong = content.length > 200;
  return (
    <details className="rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
      <summary className="px-3 py-1.5 text-xs text-[var(--color-text-tertiary)] italic font-mono cursor-pointer select-none">
        🧠 {isLong ? preview.slice(0, 120) + '...' : preview}
      </summary>
      <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] italic font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

function ToolCallBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (level === 'summary') {
    const brief = content.slice(0, 80).replace(/\n/g, ' ');
    return (
      <details className="inline-block">
        <summary className="text-xs px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--color-status-running)_15%,transparent)] text-[var(--color-status-running)] cursor-pointer select-none">
          🔧 {toolName ?? 'tool'}({brief})
        </summary>
        <div className="mt-1 px-3 py-2 text-xs font-mono bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg max-h-48 overflow-y-auto whitespace-pre-wrap">
          {content}
        </div>
      </details>
    );
  }
  return (
    <details open className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer select-none">🔧 {toolName ?? 'tool'}</summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">{content}</div>
    </details>
  );
}

function ToolResultBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
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
            <p className="text-2xl mb-2">⚠️</p>
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
  const { messages, streamingMessages, streamingChunks, displayConfig, sendChat, connected, projectName } = useFlightdeck();
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
  };

  const messageIds = useMemo(() => new Set(messages.map(m => m.id)), [messages]);
  const streamEntries = [...streamingMessages.entries()].filter(([id]) => !messageIds.has(id));
  const isStreaming = streamEntries.length > 0;

  return (
    <div className="flex h-full -m-8">
      {/* Thread sidebar */}
      {showThreads && (
        <ThreadSidebar threads={threads} activeThread={activeThread} onSelect={id => setActiveThread(id)} />
      )}

      <div className="flex flex-col flex-1 max-w-4xl mx-auto">
        {/* Thread toggle bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <button onClick={() => setShowThreads(!showThreads)}
            className="text-xs px-2.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            {showThreads ? '◀ Hide' : '▶ Threads'}
          </button>
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">
            {activeThread ? threads.find(t => t.id === activeThread)?.title ?? 'Thread' : 'Main Chat'}
          </span>
          {!connected && (
            <span className="ml-auto text-xs text-[var(--color-status-failed)] flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--color-status-failed)]" /> Disconnected
            </span>
          )}
        </div>

        {/* Messages */}
        <MessageAreaErrorBoundary>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
            {filteredMessages.length === 0 && streamEntries.length === 0 && (
              <div className="text-center py-16 text-[var(--color-text-secondary)]">
                <p className="text-4xl mb-4">💬</p>
                <p>No messages yet.</p>
                <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">
                  {connected ? 'Send a message to start a conversation with Lead.' : 'Waiting for connection...'}
                </p>
              </div>
            )}
            {filteredMessages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} onReply={handleReply} />
            ))}
            {streamEntries.map(([id, content]) => (
              <StreamingBubble key={id} content={content}
                chunks={streamingChunks.get(id)} displayConfig={displayConfig} />
            ))}
            {!isStreaming && filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1]?.authorType === 'user' && (
              <TypingIndicator />
            )}
            <div ref={bottomRef} />
          </div>
        </MessageAreaErrorBoundary>

        {/* Input */}
        <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface)]">
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
              className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-status-ready)] disabled:opacity-50 max-h-32 overflow-y-auto"
            />
            <button onClick={handleSend} disabled={!connected || !input.trim()}
              className="px-5 py-2.5 rounded-xl bg-[var(--color-status-ready)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity">
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
